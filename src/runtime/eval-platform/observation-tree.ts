import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import type { ObservationNode, ObservationTree, ObservationType } from "./contracts";

type WorkflowRow = {
  id: string;
  sessionId: string | null;
  status: string;
  researchScenarioId: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

function obsId(workflowRunId: string, suffix: string): string {
  return `${workflowRunId}:${suffix}`;
}

function leaf(
  workflowRunId: string,
  suffix: string,
  type: ObservationType,
  name: string,
  extra?: Partial<ObservationNode>
): ObservationNode {
  return {
    id: obsId(workflowRunId, suffix),
    type,
    name,
    ...extra,
  };
}

/**
 * 只读投影：从现有 log 表构建 Observation 树，不写 DB、不复制 prompt/response。
 */
export async function buildObservationTree(workflowRunId: string): Promise<ObservationTree | null> {
  await getDb();
  const sqlite = getSqliteForTesting();

  const workflow = sqlite
    .prepare(
      `SELECT id, session_id AS sessionId, status, research_scenario_id AS researchScenarioId,
              created_at AS startedAt, ended_at AS endedAt
       FROM workflow_run WHERE id = ?`
    )
    .get(workflowRunId) as WorkflowRow | undefined;
  if (!workflow) return null;

  const llmRows = sqlite
    .prepare(
      `SELECT id, provider, model, status, prompt_tokens AS promptTokens,
              completion_tokens AS completionTokens, latency_ms AS latencyMs, created_at AS createdAt
       FROM llm_call_log
       WHERE workflow_run_id = ?
       ORDER BY created_at ASC`
    )
    .all(workflowRunId) as Array<{
    id: string;
    provider: string;
    model: string;
    status: string;
    promptTokens: number | null;
    completionTokens: number | null;
    latencyMs: number | null;
    createdAt: string;
  }>;

  const toolRows = sqlite
    .prepare(
      `SELECT id, tool_name AS toolName, tool_kind AS toolKind, status,
              latency_ms AS latencyMs, created_at AS createdAt
       FROM tool_call_log
       WHERE workflow_run_id = ?
       ORDER BY created_at ASC`
    )
    .all(workflowRunId) as Array<{
    id: string;
    toolName: string;
    toolKind: string;
    status: string;
    latencyMs: number | null;
    createdAt: string;
  }>;

  const mcpRows = sqlite
    .prepare(
      `SELECT id, server_name AS serverName, tool_name AS toolName, status,
              latency_ms AS latencyMs, created_at AS createdAt
       FROM mcp_call_log
       WHERE workflow_run_id = ?
       ORDER BY created_at ASC`
    )
    .all(workflowRunId) as Array<{
    id: string;
    serverName: string;
    toolName: string;
    status: string;
    latencyMs: number | null;
    createdAt: string;
  }>;

  const skillRows = sqlite
    .prepare(
      `SELECT srl.id, COALESCE(s.name, srl.skill_id) AS skillName, srl.executed, srl.created_at AS createdAt
       FROM skill_recall_log srl
       LEFT JOIN agent_skill s ON s.id = srl.skill_id
       WHERE srl.workflow_run_id = ?
       ORDER BY srl.created_at ASC`
    )
    .all(workflowRunId) as Array<{
    id: string;
    skillName: string;
    executed: number;
    createdAt: string;
  }>;

  const artifactRows = sqlite
    .prepare(
      `SELECT id, symbol, side, status, created_at AS createdAt
       FROM recommendation_snapshot
       WHERE workflow_run_id = ?
       ORDER BY created_at ASC`
    )
    .all(workflowRunId) as Array<{
    id: string;
    symbol: string;
    side: string;
    status: string;
    createdAt: string;
  }>;

  const rootId = obsId(workflowRunId, "root");
  const children: ObservationNode[] = [
    ...llmRows.map((row, index) =>
      leaf(workflowRunId, `llm:${row.id}`, "llm.generation", `${row.provider}/${row.model}`, {
        parentId: rootId,
        status: row.status,
        latencyMs: row.latencyMs,
        tokenCount: (row.promptTokens ?? 0) + (row.completionTokens ?? 0),
        startedAt: row.createdAt,
        metadata: { provider: row.provider, model: row.model, index },
      })
    ),
    ...toolRows.map((row, index) =>
      leaf(workflowRunId, `tool:${row.id}`, "tool.invocation", row.toolName, {
        parentId: rootId,
        status: row.status,
        latencyMs: row.latencyMs,
        startedAt: row.createdAt,
        metadata: { toolKind: row.toolKind, index },
      })
    ),
    ...mcpRows.map((row, index) =>
      leaf(workflowRunId, `mcp:${row.id}`, "mcp.invocation", `${row.serverName}/${row.toolName}`, {
        parentId: rootId,
        status: row.status,
        latencyMs: row.latencyMs,
        startedAt: row.createdAt,
        metadata: { serverName: row.serverName, index },
      })
    ),
    ...skillRows.map((row, index) =>
      leaf(workflowRunId, `skill:${row.id}`, "skill.recall", row.skillName, {
        parentId: rootId,
        status: row.executed ? "executed" : "recalled",
        startedAt: row.createdAt,
        metadata: { executed: row.executed === 1, index },
      })
    ),
    ...artifactRows.map((row, index) =>
      leaf(workflowRunId, `artifact:${row.id}`, "artifact.emitted", `recommendation/${row.symbol}`, {
        parentId: rootId,
        status: row.status,
        startedAt: row.createdAt,
        metadata: { side: row.side, index },
      })
    ),
  ];

  const root: ObservationNode = {
    id: rootId,
    type: "workflow.root",
    name: workflow.researchScenarioId ?? "workflow",
    status: workflow.status,
    startedAt: workflow.startedAt ?? undefined,
    metadata: {
      scenarioKey: workflow.researchScenarioId,
    },
    children,
  };

  return {
    workflowRunId,
    sessionId: workflow.sessionId,
    scenarioKey: workflow.researchScenarioId,
    workflowStatus: workflow.status,
    root,
  };
}

export function flattenObservations(root: ObservationNode): ObservationNode[] {
  const out: ObservationNode[] = [];
  const walk = (node: ObservationNode) => {
    out.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return out;
}
