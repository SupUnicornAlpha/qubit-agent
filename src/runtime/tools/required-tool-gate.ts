/**
 * Scenario required-tool completion gate helpers.
 *
 * Capability availability and attempt evidence are evaluated at **workflow**
 * scope: any enabled agent tool counts as authorized, and any tool_call_log
 * row (parent or A2A child) counts as attempted. This prevents orchestrator
 * `tool:none` from marking factor/strategy as unconfigured when research
 * already registered artifacts on the same workflow.
 */

import type { Database } from "bun:sqlite";
import { REQUIRED_CAPABILITY_PRIMARY_TOOL } from "../research-scenario/scenario-key-aliases";
import {
  buildNotAttemptedDataGaps,
  toolMatchesRequiredCapability,
  type DataGap,
} from "./data-gap";

export type RequiredToolGateAssessment = {
  unavailableRequired: DataGap[];
  notAttempted: DataGap[];
  authorizedTools: string[];
  attemptedTools: string[];
};

function parseToolsJson(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof raw === "string") {
    try {
      return parseToolsJson(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

/** Union of tools authorized on enabled agent definitions (+ current agent). */
export function listAuthorizedToolsFromSqlite(
  sqlite: Database,
  currentAgentTools: readonly string[]
): string[] {
  const rows = sqlite
    .prepare(
      `SELECT tools_json AS toolsJson
       FROM agent_definition
       WHERE coalesce(enabled, 1) = 1`
    )
    .all() as Array<{ toolsJson: string }>;
  const authorized = new Set<string>(currentAgentTools);
  for (const row of rows) {
    for (const tool of parseToolsJson(row.toolsJson)) {
      authorized.add(tool);
    }
  }
  return [...authorized];
}

/** Distinct tool names already invoked on this workflow (any agent instance). */
export function listWorkflowAttemptedToolsFromSqlite(
  sqlite: Database,
  workflowRunId: string,
  stateToolCalls: readonly string[]
): string[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT tool_name AS toolName
       FROM tool_call_log
       WHERE workflow_run_id = ?`
    )
    .all(workflowRunId) as Array<{ toolName: string }>;
  const attempted = new Set<string>(stateToolCalls.filter(Boolean));
  for (const row of rows) {
    if (row.toolName) attempted.add(row.toolName);
  }
  return [...attempted];
}

/** Distinct tool names with semantic success on this workflow. */
export function listWorkflowSuccessfulToolsFromSqlite(
  sqlite: Database,
  workflowRunId: string,
  stateSuccessfulTools: readonly string[] = []
): string[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT tool_name AS toolName
       FROM tool_call_log
       WHERE workflow_run_id = ?
         AND lower(coalesce(status, '')) IN ('success', 'ok', 'completed')`
    )
    .all(workflowRunId) as Array<{ toolName: string }>;
  const successful = new Set<string>(stateSuccessfulTools.filter(Boolean));
  for (const row of rows) {
    if (row.toolName) successful.add(row.toolName);
  }
  return [...successful];
}

export function assessRequiredToolGate(input: {
  requiredTools: readonly string[];
  authorizedTools: readonly string[];
  attemptedTools: readonly string[];
  /** Tools still advertised after connector/manifest filtering for the current agent. */
  runnableTools: readonly string[];
  unavailableManifestTools: ReadonlyArray<{ toolName: string; status: string; provider?: string | null; reason?: string }>;
  market: string;
}): RequiredToolGateAssessment {
  const authorized = [...new Set([...input.authorizedTools, ...input.runnableTools])];
  const unavailableRequired = input.requiredTools.flatMap((capability) => {
    const runnableHere = input.runnableTools.some((toolName) =>
      toolMatchesRequiredCapability(toolName, capability)
    );
    const authorizedSomewhere = authorized.some((toolName) =>
      toolMatchesRequiredCapability(toolName, capability)
    );
    if (runnableHere || authorizedSomewhere) return [];
    const blocked = input.unavailableManifestTools.find((entry) =>
      toolMatchesRequiredCapability(entry.toolName, capability)
    );
    return [
      {
        kind: blocked?.status === "no_coverage" ? ("no_coverage" as const) : ("unconfigured" as const),
        capability,
        market: input.market,
        provider: blocked?.provider ?? null,
        reason:
          blocked?.reason ??
          `当前项目已启用 Agent 的工具集中没有可完成 ${capability} 的工具；这不是“无数据”。`,
        retryable: false,
      },
    ];
  });

  const attemptableRequired = input.requiredTools.filter((capability) => {
    if (unavailableRequired.some((gap) => gap.capability === capability)) return false;
    return (
      input.runnableTools.some((toolName) => toolMatchesRequiredCapability(toolName, capability)) ||
      authorized.some((toolName) => toolMatchesRequiredCapability(toolName, capability))
    );
  });

  const notAttempted = buildNotAttemptedDataGaps({
    requiredCapabilities: attemptableRequired,
    attemptedTools: input.attemptedTools,
    market: input.market,
  });

  return {
    unavailableRequired,
    notAttempted,
    authorizedTools: authorized,
    attemptedTools: [...input.attemptedTools],
  };
}

/** Human-readable next action when required capabilities remain not_attempted. */
export function buildRequiredToolNextActionHint(input: {
  notAttempted: readonly DataGap[];
}): string | null {
  if (input.notAttempted.length === 0) return null;
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const gap of input.notAttempted) {
    const tool = REQUIRED_CAPABILITY_PRIMARY_TOOL[gap.capability] ?? gap.capability;
    if (seen.has(tool)) continue;
    seen.add(tool);
    steps.push(`${gap.capability} → 立即调用 \`${tool}\``);
  }
  return [
    "## 合同工具尚未调用（禁止继续探活/重复 list）",
    `未满足能力：${input.notAttempted.map((g) => g.capability).join("、")}。`,
    ...steps.map((s) => `- ${s}`),
    "下一动作必须是上表中的合同工具之一；禁止 market.readiness / resolve_symbol / 重复 factor.list / 空 update_plan。",
  ].join("\n");
}
