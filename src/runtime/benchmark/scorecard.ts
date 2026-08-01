import type { AssertionResult, RunEnvelope, RunScorecard } from "./contracts";

const TERMINAL_STATUSES = new Set(["completed", "partial", "failed", "cancelled"]);

function assertion(id: string, status: AssertionResult["status"], detail: string): AssertionResult {
  return { id, status, detail };
}

/**
 * 对一个归一化 RunEnvelope 打分。Hard 采用 fail-closed；缺少尚未埋点的证据为
 * skipped，而非 pass，因而不会污染 challenger 晋级。
 */
export function scoreRunEnvelope(envelope: RunEnvelope): RunScorecard {
  const hard = scoreHard(envelope);
  const trajectory = scoreTrajectory(envelope);
  const hardPass = hard.every((item) => item.status !== "fail");
  const hardComplete = hard.every(
    (item) =>
      item.status !== "skipped" ||
      item.detail === "not_live_or_paper_execution" ||
      item.detail === "not_a_short_scenario"
  );
  const trajectoryPass = !trajectory.veto;
  const outcomeScore = 0.5; // 未成熟后验为中性，不奖惩本次过程质量。
  const score = hardPass ? 0.4 + (trajectory.score ?? 0) * 0.25 + outcomeScore * 0.2 : 0;

  return {
    workflowRunId: envelope.workflowRunId,
    suite: envelope.suite,
    harnessVersion: envelope.harnessVersion,
    layers: {
      hard: {
        pass: hardPass,
        complete: hardComplete,
        score: hardPass ? 1 : 0,
        assertions: hard,
      },
      trajectory: trajectory,
      soft: { score: null, status: "skipped" },
      outcome: { score: null, status: "pending" },
    },
    pass: hardPass && trajectoryPass,
    score,
    promotionEligible: hardPass && hardComplete && trajectoryPass,
    ...(envelope.deliveryVerdict ? { deliveryVerdict: envelope.deliveryVerdict } : {}),
  };
}

function scoreHard(envelope: RunEnvelope): AssertionResult[] {
  const results: AssertionResult[] = [];
  const terminal = TERMINAL_STATUSES.has(envelope.terminal.status);
  results.push(
    terminal
      ? assertion("H1", "pass", `terminal=${envelope.terminal.status}`)
      : assertion("H1", "skipped", `run_not_terminal:${envelope.terminal.status}`)
  );

  if (envelope.terminal.status !== "completed") {
    results.push(assertion("H2", "skipped", "only_completed_runs_require_delivery"));
  } else if (!envelope.delivery.observed) {
    results.push(assertion("H2", "skipped", "delivery_projection_unavailable"));
  } else {
    results.push(
      envelope.delivery.hasUserFinalAnswer
        ? assertion("H2", "pass", "user_final_answer_observed")
        : assertion("H2", "fail", "completed_without_user_final_answer")
    );
  }

  if (!envelope.artifactGate.available) {
    results.push(assertion("H3", "skipped", "scenario_artifact_contract_unavailable"));
  } else {
    results.push(
      envelope.artifactGate.ok
        ? assertion("H3", "pass", "required_artifacts_present")
        : assertion("H3", "fail", `missing_artifacts:${envelope.artifactGate.missing.join(",")}`)
    );
  }

  // DeliveryVerdict Hard: completed runs with a recorded partial/failed verdict cannot pass.
  if (!envelope.deliveryVerdict) {
    results.push(assertion("H-DV", "skipped", "delivery_verdict_projection_unavailable"));
  } else if (!envelope.deliveryVerdict.available) {
    results.push(assertion("H-DV", "skipped", "delivery_verdict_not_recorded"));
  } else if (
    envelope.terminal.status === "completed" &&
    envelope.deliveryVerdict.state !== "delivered" &&
    envelope.deliveryVerdict.state !== "delivered_with_gaps"
  ) {
    results.push(
      assertion(
        "H-DV",
        "fail",
        `delivery_verdict_${envelope.deliveryVerdict.state}:${(envelope.deliveryVerdict.reasonCodes ?? []).slice(0, 4).join(",")}`
      )
    );
  } else {
    results.push(
      assertion("H-DV", "pass", `delivery_verdict=${envelope.deliveryVerdict.state ?? "unknown"}`)
    );
  }

  const semanticEmptyRecommendation =
    envelope.artifacts.some((artifact) => artifact.kind === "recommendation_snapshot") &&
    envelope.tools.some((tool) => tool.semanticEmpty);
  results.push(
    semanticEmptyRecommendation
      ? assertion("H4", "fail", "recommendation_after_semantic_empty_tool_result")
      : assertion("H4", "pass", "no_semantic_empty_recommendation")
  );

  const datedArtifacts = envelope.artifacts.filter(
    (artifact) => artifact.dataAsof !== undefined && artifact.asof !== undefined
  );
  if (datedArtifacts.length === 0) {
    results.push(assertion("H5", "skipped", "no_artifact_with_asof_and_data_asof"));
  } else {
    const futureData = datedArtifacts.find(
      (artifact) => Date.parse(artifact.dataAsof ?? "") > Date.parse(artifact.asof ?? "")
    );
    results.push(
      futureData
        ? assertion("H5", "fail", `pit_violation:${futureData.id}`)
        : assertion("H5", "pass", "all_data_asof_lte_asof")
    );
  }

  results.push(scoreTelemetryAssertion("H6", envelope.contract, "permanent_contract_execution"));
  results.push(scoreTelemetryAssertion("H7", envelope.capability, "disabled_mcp_execution"));

  const liveRun = envelope.scenarioKey?.startsWith("live_trading") ?? false;
  results.push(
    !liveRun
      ? assertion("H8", "skipped", "not_live_or_paper_execution")
      : scoreTelemetryAssertion("H8", envelope.risk, "risk_decision_missing", true)
  );

  const shortRun =
    envelope.scenarioKey?.includes("short") ||
    envelope.artifacts.some((artifact) => artifact.side === "short");
  results.push(
    !shortRun
      ? assertion("H9", "skipped", "not_a_short_scenario")
      : scoreTelemetryAssertion("H9", envelope.shortRisk, "short_risk_coverage_missing", true)
  );
  return results;
}

function scoreTelemetryAssertion(
  id: string,
  telemetry:
    | { telemetryAvailable: boolean; permanentExecutionCount: number }
    | { telemetryAvailable: boolean; disabledMcpExecutionCount: number }
    | { telemetryAvailable: boolean; decisionRecorded: boolean }
    | { telemetryAvailable: boolean; coverageRecorded: boolean }
    | undefined,
  failureDetail: string,
  booleanValue = false
): AssertionResult {
  if (!telemetry?.telemetryAvailable) return assertion(id, "skipped", "telemetry_unavailable");
  const value = booleanValue
    ? "decisionRecorded" in telemetry
      ? telemetry.decisionRecorded
      : "coverageRecorded" in telemetry && telemetry.coverageRecorded
    : "permanentExecutionCount" in telemetry
      ? telemetry.permanentExecutionCount === 0
      : "disabledMcpExecutionCount" in telemetry && telemetry.disabledMcpExecutionCount === 0;
  return value
    ? assertion(id, "pass", "telemetry_check_passed")
    : assertion(id, "fail", failureDetail);
}

function scoreTrajectory(envelope: RunEnvelope): RunScorecard["layers"]["trajectory"] {
  const toolCount = envelope.tools.length;
  const succeeded = envelope.tools.filter((tool) => tool.status === "success").length;
  const toolSuccessRate = toolCount ? succeeded / toolCount : null;
  const counts = new Map<string, number>();
  for (const tool of envelope.tools) {
    const key = `${tool.name}:${tool.requestFingerprint ?? "unknown"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicateToolCalls = [...counts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0
  );
  const semanticEmptyRetries = envelope.tools.reduce((count, tool, index) => {
    const previous = envelope.tools[index - 1];
    return count + Number(Boolean(previous?.semanticEmpty && previous.name === tool.name));
  }, 0);
  const reinjectCount = envelope.artifactGate.reinjectCount ?? null;
  const values = [
    toolSuccessRate,
    toolSuccessRate === null ? null : duplicateToolCalls <= 2 ? 1 : 0,
    toolSuccessRate === null ? null : semanticEmptyRetries <= 1 ? 1 : 0,
    reinjectCount === null ? null : reinjectCount <= 2 ? 1 : 0,
  ].filter((value): value is number => value !== null);
  const score = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const veto = toolSuccessRate !== null && toolSuccessRate < 0.5;
  return {
    pass: !veto,
    veto,
    score,
    metrics: { toolSuccessRate, duplicateToolCalls, semanticEmptyRetries, reinjectCount },
  };
}
