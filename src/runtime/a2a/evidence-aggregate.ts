/**
 * Aggregate A2A task facts for parent Snapshot / DeliveryVerdict.
 * Sync reads via bun:sqlite (same connection as FactsPort).
 */

import type { Database } from "bun:sqlite";

export type A2aTaskFact = {
  taskId: string;
  status: string;
  receiverRole: string;
  parentTaskId: string | null;
  updatedAt: string;
};

export type ChildEvidenceFact = {
  taskId: string;
  status: string;
  receiverRole: string;
  capabilities: string[];
  toolNames: string[];
  summary: string | null;
};

export type A2aFactsBundle = {
  openTasks: A2aTaskFact[];
  childEvidence: ChildEvidenceFact[];
  a2aGap: boolean;
};

const OPEN_STATUSES = new Set(["submitted", "working", "input_required", "auth_required"]);
const TERMINAL_STATUSES = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "canceled",
  "rejected",
]);

/**
 * A root TASK_ASSIGN is the workflow transport envelope, not delegated work.
 * While its handler is running it is necessarily `working`; counting it as a
 * child made every in-flight workflow look as though it had missing A2A
 * evidence and forced DeliveryVerdict to partial at finalize.
 */
export function isDelegatedA2aChild(parentTaskId: string | null | undefined): boolean {
  return typeof parentTaskId === "string" && parentTaskId.trim().length > 0;
}

export function loadA2aFactsForWorkflow(sqlite: Database, workflowId: string): A2aFactsBundle {
  try {
    const rows = sqlite
      .prepare(
        `SELECT id AS taskId, status AS status, receiver_role AS receiverRole,
                parent_task_id AS parentTaskId, updated_at AS updatedAt,
                result_json AS resultJson
         FROM a2a_task
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC
         LIMIT 200`
      )
      .all(workflowId) as Array<{
      taskId: string;
      status: string;
      receiverRole: string;
      parentTaskId: string | null;
      updatedAt: string;
      resultJson: string | null;
    }>;

    const openTasks: A2aTaskFact[] = [];
    const childEvidence: ChildEvidenceFact[] = [];

    for (const row of rows) {
      const fact: A2aTaskFact = {
        taskId: row.taskId,
        status: row.status,
        receiverRole: row.receiverRole ?? "",
        parentTaskId: row.parentTaskId,
        updatedAt: row.updatedAt,
      };
      const delegatedChild = isDelegatedA2aChild(row.parentTaskId);
      if (delegatedChild && OPEN_STATUSES.has(row.status)) openTasks.push(fact);

      if (delegatedChild && TERMINAL_STATUSES.has(row.status)) {
        const parsed = parseResult(row.resultJson);
        childEvidence.push({
          taskId: row.taskId,
          status: row.status,
          receiverRole: row.receiverRole ?? "",
          capabilities: parsed.capabilities,
          toolNames: parsed.toolNames,
          summary: parsed.summary,
        });
      }
    }

    // Also pull successful tools from child agent instances on this workflow.
    const childTools = listChildSuccessfulTools(sqlite, workflowId);
    if (childTools.length > 0 && childEvidence.length === 0) {
      childEvidence.push({
        taskId: "workflow-tool-log",
        status: "completed",
        receiverRole: "aggregate",
        capabilities: [],
        toolNames: childTools,
        summary: "aggregated from tool_call_log",
      });
    } else if (childTools.length > 0) {
      const firstEvidence = childEvidence[0];
      if (firstEvidence) {
        childEvidence[0] = {
          ...firstEvidence,
          toolNames: [...new Set([...firstEvidence.toolNames, ...childTools])],
        };
      }
    }

    return {
      openTasks,
      childEvidence,
      a2aGap: openTasks.length > 0,
    };
  } catch {
    return { openTasks: [], childEvidence: [], a2aGap: false };
  }
}

function parseResult(raw: string | null): {
  capabilities: string[];
  toolNames: string[];
  summary: string | null;
} {
  if (!raw) return { capabilities: [], toolNames: [], summary: null };
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const evidence =
      json.evidence && typeof json.evidence === "object"
        ? (json.evidence as Record<string, unknown>)
        : json;
    const capabilities = Array.isArray(evidence.capabilities)
      ? evidence.capabilities.filter((item): item is string => typeof item === "string")
      : [];
    const toolNames = Array.isArray(evidence.toolNames)
      ? evidence.toolNames.filter((item): item is string => typeof item === "string")
      : Array.isArray(evidence.tools)
        ? evidence.tools.filter((item): item is string => typeof item === "string")
        : [];
    const summary =
      typeof evidence.summary === "string"
        ? evidence.summary
        : typeof json.answerText === "string"
          ? json.answerText.slice(0, 240)
          : null;
    return { capabilities, toolNames, summary };
  } catch {
    return { capabilities: [], toolNames: [], summary: null };
  }
}

function listChildSuccessfulTools(sqlite: Database, workflowId: string): string[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT DISTINCT tool_name AS toolName
         FROM tool_call_log
         WHERE workflow_run_id = ?
           AND lower(coalesce(status, '')) IN ('success', 'ok', 'completed')`
      )
      .all(workflowId) as Array<{ toolName: string }>;
    return rows.map((row) => row.toolName).filter(Boolean);
  } catch {
    return [];
  }
}
