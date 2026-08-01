import { createHash } from "node:crypto";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { checkRequiredArtifacts } from "../agent-readiness/quality/artifact-checker";
import { SCENARIO_EXPECTATIONS } from "../agent-readiness/quality/scenario-expectations";
import type { ScenarioRecipe } from "../agent-readiness/scenarios";
import { readLatestDeliveryVerdict } from "../policy/delivery-ledger";
import type { RunEnvelope, RunTool } from "./contracts";

export interface BuildRunEnvelopeInput {
  workflowRunId: string;
  suite?: RunEnvelope["suite"];
  /** 调用方应传入 prompt / skill / gate 配置的稳定哈希；未知时明确标 unknown。 */
  harnessVersion?: string;
}

type WorkflowRow = {
  status: string;
  mode: string;
  researchScenarioId: string | null;
};

/**
 * 从现有事实表构建轻量 Envelope。这里不写 DB、也不复制敏感 request/response；缺少
 * 的新 telemetry 将被 scorecard 标成 skipped，从而阻止不完整历史 run 参与晋级。
 */
export async function buildRunEnvelope(input: BuildRunEnvelopeInput): Promise<RunEnvelope> {
  await getDb();
  const sqlite = getSqliteForTesting();
  const workflow = sqlite
    .prepare(
      `SELECT status, mode, research_scenario_id AS researchScenarioId
       FROM workflow_run WHERE id = ?`
    )
    .get(input.workflowRunId) as WorkflowRow | undefined;
  if (!workflow) throw new Error(`workflow_run_not_found:${input.workflowRunId}`);

  const scenarioKey = knownScenario(workflow.researchScenarioId);
  const artifactCheck = scenarioKey
    ? checkRequiredArtifacts(sqlite, scenarioKey, input.workflowRunId)
    : null;
  const toolTelemetry = readTools(sqlite, input.workflowRunId);
  const artifacts = sqlite
    .prepare(
      `SELECT id, asof, data_asof AS dataAsof, side, stop_loss AS stopLoss,
              take_profit AS takeProfit, invalidation_json AS invalidationJson
       FROM recommendation_snapshot WHERE workflow_run_id = ?`
    )
    .all(input.workflowRunId) as Array<{
    id: string;
    asof: string;
    dataAsof: string | null;
    side: "long" | "short" | "neutral";
    stopLoss: number | null;
    takeProfit: number | null;
    invalidationJson: string;
  }>;
  const delivery = readDelivery(sqlite, input.workflowRunId);
  const executionRisk = readExecutionRisk(sqlite, input.workflowRunId, scenarioKey);
  const verdict = readLatestDeliveryVerdict(sqlite, input.workflowRunId);

  return {
    workflowRunId: input.workflowRunId,
    suite: input.suite ?? "production",
    scenarioKey,
    harnessVersion: input.harnessVersion ?? "unknown",
    terminal: { status: workflow.status },
    tools: toolTelemetry.tools,
    artifacts: artifacts.map((artifact) => ({
      kind: "recommendation_snapshot",
      id: artifact.id,
      ok: true,
      asof: artifact.asof,
      ...(artifact.dataAsof ? { dataAsof: artifact.dataAsof } : {}),
      side: artifact.side,
      hasStopLoss: artifact.stopLoss !== null,
      hasTakeProfit: artifact.takeProfit !== null,
      hasInvalidation: artifact.invalidationJson !== "[]",
    })),
    artifactGate: {
      available: artifactCheck !== null,
      ...(artifactCheck ? { ok: artifactCheck.ok } : {}),
      missing: artifactCheck?.missing.map((item) => item.table) ?? [],
    },
    delivery,
    deliveryVerdict: verdict
      ? {
          available: true,
          state: verdict.state,
          reasonCodes: verdict.reasonCodes,
        }
      : { available: false },
    ...(toolTelemetry.contract ? { contract: toolTelemetry.contract } : {}),
    ...(toolTelemetry.capability ? { capability: toolTelemetry.capability } : {}),
    ...(executionRisk.risk ? { risk: executionRisk.risk } : {}),
    ...(executionRisk.shortRisk ? { shortRisk: executionRisk.shortRisk } : {}),
  };
}

function knownScenario(value: string | null): ScenarioRecipe["key"] | null {
  if (!value || !(value in SCENARIO_EXPECTATIONS)) return null;
  return value as ScenarioRecipe["key"];
}

function readTools(
  sqlite: ReturnType<typeof getSqliteForTesting>,
  workflowRunId: string
): {
  tools: RunTool[];
  contract?: { telemetryAvailable: boolean; permanentExecutionCount: number };
  capability?: { telemetryAvailable: boolean; disabledMcpExecutionCount: number };
} {
  const rows = sqlite
    .prepare(
      `SELECT tool_name AS name, status, error_class AS errorClass, error_message AS errorMessage, latency_ms AS latencyMs,
              request_json AS requestJson, response_json AS responseJson
       FROM tool_call_log WHERE workflow_run_id = ? ORDER BY created_at ASC`
    )
    .all(workflowRunId) as Array<{
    name: string;
    status: RunTool["status"];
    errorClass: RunTool["errorClass"] | null;
    errorMessage: string | null;
    latencyMs: number | null;
    requestJson: string;
    responseJson: string | null;
  }>;
  const governance = rows.map((row) => parseGovernance(row.requestJson));
  const contractCovered = governance.some((item) => Boolean(item.contractName));
  const capabilityCovered = governance.some((item) => item.capabilityGate !== undefined);
  const permanentExecutionCount = rows.filter((row, index) => {
    const message = row.errorMessage ?? "";
    return (
      row.errorClass === "permanent" &&
      /missing_(?:symbol|field)|required field|arity|invalid (?:argument|parameter)/i.test(
        message
      ) &&
      !governance[index]?.contractRejected
    );
  }).length;
  return {
    tools: rows.map((row) => ({
      name: row.name,
      status: row.status,
      ...(row.errorClass ? { errorClass: row.errorClass } : {}),
      ...(row.latencyMs !== null ? { latencyMs: row.latencyMs } : {}),
      requestFingerprint: fingerprint(row.requestJson),
      semanticEmpty: responseLooksSemanticallyEmpty(row.responseJson),
    })),
    ...(contractCovered ? { contract: { telemetryAvailable: true, permanentExecutionCount } } : {}),
    ...(capabilityCovered
      ? { capability: { telemetryAvailable: true, disabledMcpExecutionCount: 0 } }
      : {}),
  };
}

function parseGovernance(requestJson: string): {
  capabilityGate?: "allowed" | "denied";
  contractName?: string;
  contractRejected?: boolean;
} {
  try {
    const parsed = JSON.parse(requestJson) as { governance?: unknown };
    const raw = parsed.governance;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const governance = raw as Record<string, unknown>;
    return {
      ...(governance.capabilityGate === "allowed" || governance.capabilityGate === "denied"
        ? { capabilityGate: governance.capabilityGate }
        : {}),
      ...(typeof governance.contractName === "string"
        ? { contractName: governance.contractName }
        : {}),
      ...(governance.contractRejected === true ? { contractRejected: true } : {}),
    };
  } catch {
    return {};
  }
}

function readDelivery(
  sqlite: ReturnType<typeof getSqliteForTesting>,
  workflowRunId: string
): RunEnvelope["delivery"] {
  try {
    const row = sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM research_team_interaction
         WHERE workflow_run_id = ? AND from_role = 'orchestrator' AND to_role = 'user'
           AND kind = 'llm_message' AND LENGTH(TRIM(content_text)) > 0`
      )
      .get(workflowRunId) as { count: number };
    return { observed: true, hasUserFinalAnswer: row.count > 0 };
  } catch {
    return { observed: false };
  }
}

function readExecutionRisk(
  sqlite: ReturnType<typeof getSqliteForTesting>,
  workflowRunId: string,
  scenarioKey: ScenarioRecipe["key"] | null
): Pick<RunEnvelope, "risk" | "shortRisk"> {
  if (!scenarioKey?.startsWith("live_trading")) return {};
  try {
    const row = sqlite
      .prepare(
        `SELECT COUNT(rd.id) AS decisions,
                SUM(CASE WHEN oi.side = 'sell' AND
                  (LOWER(rd.reason) LIKE '%short%' OR LOWER(rd.reason) LIKE '%margin%' OR LOWER(rd.reason) LIKE '%borrow%')
                  THEN 1 ELSE 0 END) AS shortCoverage
           FROM order_intent oi
           LEFT JOIN risk_decision rd ON rd.order_intent_id = oi.id
          WHERE oi.workflow_run_id = ?`
      )
      .get(workflowRunId) as { decisions: number; shortCoverage: number | null };
    const risk = { telemetryAvailable: true, decisionRecorded: Number(row.decisions) > 0 };
    const shortRisk =
      scenarioKey === "live_trading_short"
        ? { telemetryAvailable: true, coverageRecorded: Number(row.shortCoverage ?? 0) > 0 }
        : undefined;
    return { risk, ...(shortRisk ? { shortRisk } : {}) };
  } catch {
    return {};
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function responseLooksSemanticallyEmpty(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return containsSemanticEmptyMarker(parsed);
  } catch {
    return false;
  }
}

function containsSemanticEmptyMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSemanticEmptyMarker);
  const record = value as Record<string, unknown>;
  return (
    record.items_empty === true ||
    record.no_bars === true ||
    record.errorCode === "market_data_unavailable" ||
    Object.values(record).some(containsSemanticEmptyMarker)
  );
}
