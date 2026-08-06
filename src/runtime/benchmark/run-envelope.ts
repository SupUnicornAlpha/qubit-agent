import { createHash } from "node:crypto";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { checkRequiredArtifacts } from "../agent-readiness/quality/artifact-checker";
import { SCENARIO_EXPECTATIONS } from "../agent-readiness/quality/scenario-expectations";
import type { ScenarioRecipe } from "../agent-readiness/scenarios";
import { readLatestDeliveryVerdict } from "../policy/delivery-ledger";
import type {
  RunEnvelope,
  RunMemoryTelemetry,
  RunOrchestrationTelemetry,
  RunRecipeTelemetry,
  RunTool,
} from "./contracts";
import {
  isInvokeToolName,
  isMemoryToolName,
  looksLikeStubNarrative,
} from "./soft-dimensions";

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

type Sqlite = ReturnType<typeof getSqliteForTesting>;

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
  const memory = deriveMemoryTelemetry(toolTelemetry.tools);
  const orchestration = readOrchestration(sqlite, input.workflowRunId, toolTelemetry.tools);
  const recipe = deriveRecipeTelemetry(scenarioKey, toolTelemetry.tools);

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
    memory,
    orchestration,
    ...(recipe ? { recipe } : {}),
  };
}

function knownScenario(value: string | null): ScenarioRecipe["key"] | null {
  if (!value || !(value in SCENARIO_EXPECTATIONS)) return null;
  return value as ScenarioRecipe["key"];
}

function readTools(
  sqlite: Sqlite,
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
      ...(isMemoryToolName(row.name)
        ? { memoryHitCount: countMemoryHits(row.responseJson) }
        : {}),
    })),
    ...(contractCovered ? { contract: { telemetryAvailable: true, permanentExecutionCount } } : {}),
    ...(capabilityCovered
      ? { capability: { telemetryAvailable: true, disabledMcpExecutionCount: 0 } }
      : {}),
  };
}

function deriveMemoryTelemetry(tools: RunTool[]): RunMemoryTelemetry {
  const recall = tools.filter((t) => /^memory\.recall$/i.test(t.name));
  const search = tools.filter((t) => /^workspace\.memory\.search$/i.test(t.name));
  return {
    telemetryAvailable: true,
    recallAttempts: recall.length,
    recallSuccesses: recall.filter((t) => t.status === "success").length,
    recallHits: recall.reduce((sum, t) => sum + (t.memoryHitCount ?? 0), 0),
    searchAttempts: search.length,
    searchSuccesses: search.filter((t) => t.status === "success").length,
    searchHits: search.reduce((sum, t) => sum + (t.memoryHitCount ?? 0), 0),
    errorCount: [...recall, ...search].filter((t) => t.status !== "success").length,
  };
}

function deriveRecipeTelemetry(
  scenarioKey: ScenarioRecipe["key"] | null,
  tools: RunTool[]
): RunRecipeTelemetry | undefined {
  if (!scenarioKey) return undefined;
  const expectation = SCENARIO_EXPECTATIONS[scenarioKey];
  const required = [...expectation.requiredTools];
  if (required.length === 0) {
    return {
      telemetryAvailable: true,
      requiredTools: [],
      matchedTools: [],
      missedTools: [],
    };
  }
  const names = tools.map((t) => t.name);
  const matched: string[] = [];
  const missed: string[] = [];
  for (const req of required) {
    const hit = names.some(
      (name) =>
        name === req ||
        name.endsWith(`.${req}`) ||
        name.includes(req) ||
        req.includes(name)
    );
    if (hit) matched.push(req);
    else missed.push(req);
  }
  return {
    telemetryAvailable: true,
    requiredTools: required,
    matchedTools: matched,
    missedTools: missed,
  };
}

function readOrchestration(
  sqlite: Sqlite,
  workflowRunId: string,
  tools: RunTool[]
): RunOrchestrationTelemetry {
  const invokeTools = tools.filter((t) => isInvokeToolName(t.name));
  let stubNarrativeCount = 0;
  let narrativeChars = 0;
  let invokeAttempts = invokeTools.length;
  let invokeSuccesses = invokeTools.filter((t) => t.status === "success").length;

  // Prefer interaction log narratives when present (Core handoff projection).
  try {
    const rows = sqlite
      .prepare(
        `SELECT content_text AS content, payload_json AS payloadJson
         FROM research_team_interaction
         WHERE workflow_run_id = ?
           AND kind = 'tool_call'
           AND (
             tool_name = 'agent.invoke'
             OR content_text LIKE 'invoke completed:%'
           )`
      )
      .all(workflowRunId) as Array<{ content: string | null; payloadJson: string | null }>;
    if (rows.length > 0) {
      invokeAttempts = Math.max(invokeAttempts, rows.length);
      let ok = 0;
      for (const row of rows) {
        const text = row.content ?? "";
        const payloadStatus = readPayloadStatus(row.payloadJson);
        const failed =
          payloadStatus === "error" ||
          payloadStatus === "failed" ||
          /^invoke\s+(failed|error)\b/i.test(text);
        if (!failed) {
          ok += 1;
          if (looksLikeStubNarrative(text)) stubNarrativeCount += 1;
          else narrativeChars += text.trim().length;
        }
      }
      invokeSuccesses = Math.max(invokeSuccesses, ok);
    }
  } catch {
    /* table/columns may differ in older DBs — tool_call_log path still works */
  }

  return {
    telemetryAvailable: true,
    invokeAttempts,
    invokeSuccesses,
    stubNarrativeCount,
    narrativeChars,
  };
}

function countMemoryHits(responseJson: string | null): number {
  if (!responseJson) return 0;
  try {
    const parsed = JSON.parse(responseJson) as unknown;
    return countHitsInPayload(parsed);
  } catch {
    return 0;
  }
}

function countHitsInPayload(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    // Prefer outer array of hits when present.
    if (value.length > 0 && value.every((item) => item && typeof item === "object")) {
      return value.length;
    }
    return value.reduce<number>((sum, item) => sum + countHitsInPayload(item), 0);
  }
  const record = value as Record<string, unknown>;
  for (const key of ["hits", "items", "results", "memories", "entries"]) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
  }
  if (typeof record.hitCount === "number") return Math.max(0, record.hitCount);
  if (typeof record.count === "number" && Array.isArray(record.data)) {
    return record.data.length;
  }
  return 0;
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
  sqlite: Sqlite,
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
  sqlite: Sqlite,
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

function readPayloadStatus(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    const status = parsed.status ?? parsed.state ?? parsed.phase;
    return typeof status === "string" ? status.toLowerCase() : null;
  } catch {
    return null;
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
