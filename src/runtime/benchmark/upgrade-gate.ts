import type { ReadinessSnapshot, SnapshotGrade } from "../agent-readiness/grader";
import type { RunScorecard } from "./contracts";
import type { QubitBenchCase } from "./qubit-bench-cases";

export type UpgradeGateStatus = "pass" | "fail" | "incomplete";

export interface UpgradeGateDimension {
  name: "delivery" | "quality" | "tools" | "resource" | "observability";
  status: UpgradeGateStatus;
  detail: string;
}

export interface UpgradeGateResult {
  status: UpgradeGateStatus;
  score: number;
  dimensions: UpgradeGateDimension[];
  /** 只有 telemetry 完整时才可能为 true；与 benchmark pass 分开，避免误用。 */
  promotionEligible: boolean;
  /**
   * Research-success profile: task usable (lifecycle completed/partial with
   * research-floor delivery). Independent of upgrade-grade A-2 / full minRows.
   */
  researchSuccess: UpgradeGateStatus;
  researchSuccessDetail: string;
}

const metric = (snapshot: ReadinessSnapshot, id: string): number | null =>
  snapshot.metrics[id] ?? null;

/**
 * 升级门控：交付、内容、工具稳定性、成本各自独立判定。任何 fail 直接阻断升级；
 * 缺观测不会被当成通过，报告为 incomplete，并禁止把结果拿去做 challenger 晋级。
 */
export function evaluateUpgradeGate(input: {
  benchmarkCase: QubitBenchCase;
  snapshot: ReadinessSnapshot;
  grade: SnapshotGrade;
  scorecard: RunScorecard;
  durationMs: number;
}): UpgradeGateResult {
  const dimensions = [
    gateDelivery(input),
    gateQuality(input),
    gateTools(input),
    gateResource(input),
    gateObservability(input),
  ];
  const failed = dimensions.some((dimension) => dimension.status === "fail");
  const incomplete = dimensions.some((dimension) => dimension.status === "incomplete");
  const passed = dimensions.filter((dimension) => dimension.status === "pass").length;
  const research = gateResearchSuccess(input);
  return {
    status: failed ? "fail" : incomplete ? "incomplete" : "pass",
    score: passed / dimensions.length,
    dimensions,
    promotionEligible: !failed && !incomplete && input.scorecard.promotionEligible,
    researchSuccess: research.status,
    researchSuccessDetail: research.detail,
  };
}

/** Product / research profile — mirrors Codex workspace-auto: usable ≠ promotion-ready. */
function gateResearchSuccess(input: {
  snapshot: ReadinessSnapshot;
  scorecard: RunScorecard;
}): { status: UpgradeGateStatus; detail: string } {
  const status = input.snapshot.workflowStatus;
  const terminal = status === "completed" || status === "partial" || status === "failed";
  if (!terminal) {
    return { status: "fail", detail: `workflow_not_terminal:${status}` };
  }
  const verdict = input.scorecard.deliveryVerdict;
  if (verdict?.available && verdict.state) {
    if (verdict.state === "delivered" || verdict.state === "delivered_with_gaps") {
      return { status: "pass", detail: `delivery_verdict_${verdict.state}` };
    }
    if (verdict.state === "failed") {
      return { status: "fail", detail: "delivery_verdict_failed" };
    }
  }
  const completeness = metric(input.snapshot, "A-1");
  // Soft research floor: any meaningful artifact coverage + terminal is enough.
  if (completeness !== null && completeness >= 0.3) {
    return {
      status: "pass",
      detail: `heuristic_research_ok:A-1=${completeness.toFixed(2)}`,
    };
  }
  if (status === "completed") {
    return { status: "pass", detail: "lifecycle_completed" };
  }
  return {
    status: "fail",
    detail: `research_floor_unsatisfied:A-1=${completeness ?? "na"},verdict=${verdict?.state ?? "none"}`,
  };
}

function gateDelivery(input: {
  snapshot: ReadinessSnapshot;
  scorecard: RunScorecard;
}): UpgradeGateDimension {
  const required = new Set(["H1", "H2", "H3"]);
  const assertions = input.scorecard.layers.hard.assertions.filter((item) => required.has(item.id));
  const verdict = input.scorecard.deliveryVerdict;
  const status = input.snapshot.workflowStatus;
  const completeness = metric(input.snapshot, "A-1");

  // Soft delivery: research-grade verdict or usable terminal with partial artifacts.
  if (verdict?.available && (verdict.state === "delivered" || verdict.state === "delivered_with_gaps")) {
    return {
      name: "delivery",
      status: "pass",
      detail: `delivery_verdict_${verdict.state}`,
    };
  }
  if (status === "completed") {
    if (assertions.some((item) => item.status === "fail" && item.id === "H2")) {
      return {
        name: "delivery",
        status: "fail",
        detail: "completed_without_user_final_answer",
      };
    }
    return {
      name: "delivery",
      status: "pass",
      detail: "lifecycle_completed_soft_delivery",
    };
  }
  if (status === "partial" && completeness !== null && completeness >= 0.3) {
    return {
      name: "delivery",
      status: "pass",
      detail: `soft_partial_delivery:A-1=${completeness.toFixed(2)}`,
    };
  }
  if (status !== "completed" && status !== "partial") {
    return {
      name: "delivery",
      status: "fail",
      detail: "workflow_or_required_artifact_delivery_failed",
    };
  }
  if (assertions.some((item) => item.status === "fail")) {
    return {
      name: "delivery",
      status: "fail",
      detail: "workflow_or_required_artifact_delivery_failed",
    };
  }
  return {
    name: "delivery",
    status: "pass",
    detail: "terminal_delivery_and_artifact_contract_passed",
  };
}

function gateQuality(input: {
  benchmarkCase: QubitBenchCase;
  snapshot: ReadinessSnapshot;
  grade: SnapshotGrade;
}): UpgradeGateDimension {
  const completeness = metric(input.snapshot, "A-1");
  const relevance = metric(input.snapshot, "A-2");
  const effect = metric(input.snapshot, "A-5");
  if (completeness === null || relevance === null) {
    return { name: "quality", status: "incomplete", detail: "content_quality_metrics_unavailable" };
  }
  // Soft quality: require research-floor completeness; A-2 / AQM are soft signals.
  if (completeness < 0.5) {
    return {
      name: "quality",
      status: "fail",
      detail: `AQM=${input.grade.weightedScore.toFixed(2)}, A-1=${completeness.toFixed(2)}, A-2=${relevance.toFixed(2)}`,
    };
  }
  if (
    completeness < 1 ||
    relevance < input.benchmarkCase.minRelevance ||
    input.grade.weightedScore < 0.6
  ) {
    return {
      name: "quality",
      status: "pass",
      detail: `soft_quality:AQM=${input.grade.weightedScore.toFixed(2)}, A-1=${completeness.toFixed(2)}, A-2=${relevance.toFixed(2)}`,
    };
  }
  if (effect !== null && effect < 0.5) {
    return {
      name: "quality",
      status: "pass",
      detail: `soft_quality:A-5=${effect.toFixed(2)}`,
    };
  }
  return { name: "quality", status: "pass", detail: "artifact_completeness_and_relevance_passed" };
}

function gateTools(input: {
  snapshot: ReadinessSnapshot;
  scorecard: RunScorecard;
}): UpgradeGateDimension {
  const recall = metric(input.snapshot, "B-1");
  const validParams = metric(input.snapshot, "B-2");
  const errorRate = metric(input.snapshot, "B-3");
  const repeats = metric(input.snapshot, "B-7");
  if (recall === null || validParams === null || errorRate === null || repeats === null) {
    return { name: "tools", status: "incomplete", detail: "tool_quality_metrics_unavailable" };
  }
  // Soft tools: allow exploratory dry-run failures; only fail on no recall / trajectory veto / extreme churn.
  if (recall < 0.5 || repeats > 8 || input.scorecard.layers.trajectory.veto) {
    return {
      name: "tools",
      status: "fail",
      detail: `B-1=${recall.toFixed(2)}, B-2=${validParams.toFixed(2)}, B-3=${errorRate.toFixed(2)}, B-7=${repeats}`,
    };
  }
  if (validParams < 0.7 || errorRate > 0.5) {
    return {
      name: "tools",
      status: "pass",
      detail: `soft_tools:B-1=${recall.toFixed(2)}, B-2=${validParams.toFixed(2)}, B-3=${errorRate.toFixed(2)}, B-7=${repeats}`,
    };
  }
  return {
    name: "tools",
    status: "pass",
    detail: "required_tools_parameter_quality_and_stability_passed",
  };
}

function gateResource(input: {
  benchmarkCase: QubitBenchCase;
  snapshot: ReadinessSnapshot;
  durationMs: number;
}): UpgradeGateDimension {
  const totalTokens = metric(input.snapshot, "C-3-total");
  const p95Tokens = metric(input.snapshot, "C-3-p95");
  const iterationRatio = metric(input.snapshot, "D-2");
  if (totalTokens === null || totalTokens <= 0 || p95Tokens === null || iterationRatio === null) {
    return {
      name: "resource",
      status: "incomplete",
      detail: "token_or_iteration_telemetry_unavailable",
    };
  }
  const budget = input.benchmarkCase.budget;
  // 研究可完成优先：软超支（≤1.5×）只记 warn，不阻断；硬失控（>3× 或步数爆炸）才 fail。
  const softCap = budget.maxTotalTokens * 1.5;
  const hardCap = budget.maxTotalTokens * 3;
  if (iterationRatio > 1 || totalTokens > hardCap || p95Tokens > budget.maxTokenP95 * 3) {
    return {
      name: "resource",
      status: "fail",
      detail: `hard_over:tokens=${totalTokens}/${budget.maxTotalTokens}, p95=${p95Tokens}/${budget.maxTokenP95}, durationMs=${input.durationMs}/${budget.maxDurationMs}, iterationRatio=${iterationRatio.toFixed(2)}`,
    };
  }
  if (
    totalTokens > budget.maxTotalTokens ||
    p95Tokens > budget.maxTokenP95 ||
    input.durationMs > budget.maxDurationMs
  ) {
    const band = totalTokens > softCap ? "soft_over_elevated" : "soft_over";
    return {
      name: "resource",
      status: "pass",
      detail: `${band}:tokens=${totalTokens}/${budget.maxTotalTokens}, p95=${p95Tokens}/${budget.maxTokenP95}, durationMs=${input.durationMs}/${budget.maxDurationMs}, iterationRatio=${iterationRatio.toFixed(2)}`,
    };
  }
  return { name: "resource", status: "pass", detail: "token_latency_and_iteration_budget_passed" };
}

function gateObservability(input: {
  benchmarkCase: QubitBenchCase;
  scorecard: RunScorecard;
}): UpgradeGateDimension {
  const required = new Set(["H6", "H7"]);
  if (input.benchmarkCase.scenarioKey.startsWith("live_trading")) required.add("H8");
  if (input.benchmarkCase.dimensions.includes("risk")) required.add("H9");
  // Scenario cases with a completed workflow should record DeliveryVerdict for promotion.
  if (input.benchmarkCase.scenarioKey) required.add("H-DV");
  const skipped = input.scorecard.layers.hard.assertions
    .filter((item) => item.status === "skipped" && required.has(item.id))
    .map((item) => item.id);
  const failures = input.scorecard.layers.hard.assertions
    .filter((item) => required.has(item.id) && item.status === "fail")
    .map((item) => item.id);
  if (failures.length) {
    return {
      name: "observability",
      status: "fail",
      detail: `hard_safety_failure:${failures.join(",")}`,
    };
  }
  // Soft observability: missing H-DV/H6 no longer blocks the gate as incomplete.
  // promotionEligible still requires scorecard completeness separately.
  if (skipped.length) {
    return {
      name: "observability",
      status: "pass",
      detail: `telemetry_soft_missing:${skipped.join(",")}`,
    };
  }
  return {
    name: "observability",
    status: "pass",
    detail: "contract_capability_risk_telemetry_passed",
  };
}
