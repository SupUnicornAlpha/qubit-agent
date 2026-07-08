import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentGroup, workflowRun } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import {
  type ResearchScopeInput,
  classifyResearchInput,
  resolveResearchScope,
} from "../../types/research-scope";
import { dispatchTaskToRole } from "../agent-pool";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import {
  failAnalystResearchJob,
  getLatestJobTickerByWorkflow,
  registerAnalystResearchJob,
} from "./analyst-research-jobs";
import { RESEARCH_TEAM_SLOT_SET } from "./analyst-team";

export type LaunchAnalystTeamInput = {
  workflowRunId: string;
  ticker?: string;
  scope?: ResearchScopeInput | null;
  context?: string;
  agentGroupId?: string | null;
  analystRoles?: string[] | null;
  analystDefinitionIds?: string[] | null;
  hitlMode?: "off" | "ai" | "always";
  roleReasoner?: "native" | "claude_cli" | "codex_cli";
  researchScenarioKey?: string | null;
};

export type LaunchAnalystTeamResult = {
  ok: true;
  jobId: string;
  workflowRunId: string;
  taskId: string;
  ticker: string;
  scope: ReturnType<typeof resolveResearchScope>;
  agentGroupId: string | null;
};

export class LaunchAnalystTeamError extends Error {
  constructor(
    public code:
      | "workflow_required"
      | "scope_required"
      | "agent_group_not_found"
      | "workflow_not_found"
      | "dispatch_failed",
    message: string,
    public status = 400
  ) {
    super(message);
    this.name = "LaunchAnalystTeamError";
  }
}

export async function launchAnalystTeam(
  input: LaunchAnalystTeamInput
): Promise<LaunchAnalystTeamResult> {
  if (!input.workflowRunId) {
    throw new LaunchAnalystTeamError("workflow_required", "workflowRunId is required", 400);
  }

  let effectiveScope: ResearchScopeInput | null | undefined = input.scope;
  let effectiveTicker: string | undefined = input.ticker;
  let effectiveContext: string | undefined = input.context;
  const classification = classifyResearchInput({
    ticker: input.ticker ?? null,
    scope: input.scope ?? null,
  });
  if (classification.shouldPromoteToExplore && classification.theme) {
    effectiveScope = {
      ...(input.scope ?? {}),
      kind: "explore",
      theme: classification.theme,
    };
    effectiveTicker = undefined;
    const originalNote = `[auto-promoted to explore] 用户原始输入："${classification.theme}"。原因：${classification.reason}。请先调 run_screener / factor.list / skill.search 找候选 ticker（≤3 个），用 fetch_klines 验证存在性后再分析。`;
    effectiveContext = input.context ? `${input.context}\n\n${originalNote}` : originalNote;
    console.log(
      `[analyst.run] auto-promoted "${classification.theme}" → explore mode (workflow=${input.workflowRunId})`
    );
  }

  if (!effectiveTicker?.trim() && !effectiveScope) {
    const priorTicker = await getLatestJobTickerByWorkflow(input.workflowRunId);
    if (priorTicker) effectiveTicker = priorTicker;
  }

  const scope = resolveResearchScope({
    ...(effectiveTicker !== undefined ? { ticker: effectiveTicker } : {}),
    ...(effectiveScope !== undefined ? { scope: effectiveScope } : {}),
  });
  if (!effectiveTicker?.trim() && !effectiveScope && scope.primarySymbol === "UNKNOWN") {
    throw new LaunchAnalystTeamError("scope_required", "ticker or scope.symbols is required", 400);
  }

  const db = await getDb();
  if (input.agentGroupId) {
    const grp = await db
      .select()
      .from(agentGroup)
      .where(eq(agentGroup.id, input.agentGroupId))
      .limit(1);
    if (!grp[0]) {
      throw new LaunchAnalystTeamError("agent_group_not_found", "agent group not found", 404);
    }
  }

  const wf = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowRunId))
    .limit(1);
  if (!wf[0]) {
    throw new LaunchAnalystTeamError("workflow_not_found", "workflow not found", 404);
  }

  const loopPatch: Record<string, unknown> = {};
  if (input.hitlMode === "off" || input.hitlMode === "ai" || input.hitlMode === "always") {
    loopPatch.hitlMode = input.hitlMode;
  }
  if (
    input.roleReasoner === "native" ||
    input.roleReasoner === "claude_cli" ||
    input.roleReasoner === "codex_cli"
  ) {
    loopPatch.roleReasoner = input.roleReasoner;
  }
  const loopOptionsJson =
    Object.keys(loopPatch).length > 0
      ? { ...((wf[0].loopOptionsJson as Record<string, unknown> | null) ?? {}), ...loopPatch }
      : wf[0].loopOptionsJson;

  await db
    .update(workflowRun)
    .set({
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      loopOptionsJson: loopOptionsJson as never,
      ...(input.agentGroupId !== undefined ? { agentGroupId: input.agentGroupId } : {}),
      ...(input.researchScenarioKey ? { researchScenarioId: input.researchScenarioKey } : {}),
    })
    .where(eq(workflowRun.id, input.workflowRunId));

  const jobId = randomUUID();
  await registerAnalystResearchJob(jobId, {
    status: "running",
    workflowRunId: input.workflowRunId,
    ticker: scope.displayLabel,
    startedAt: Date.now(),
  });

  if (effectiveContext?.trim()) {
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "user",
      toRole: "orchestrator",
      kind: "llm_message",
      contentText: effectiveContext.trim().slice(0, 4000),
    });
  }

  const analystRoles =
    Array.isArray(input.analystRoles) && input.analystRoles.length > 0
      ? (input.analystRoles.filter(
          (role): role is AgentRole => typeof role === "string" && RESEARCH_TEAM_SLOT_SET.has(role)
        ) as AgentRole[])
      : undefined;

  const analystDefinitionIds =
    Array.isArray(input.analystDefinitionIds) && input.analystDefinitionIds.length > 0
      ? input.analystDefinitionIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0
        )
      : undefined;

  const taskId = randomUUID();
  try {
    await dispatchTaskToRole({
      workflowId: input.workflowRunId,
      role: "orchestrator",
      payload: {
        taskId,
        taskType: "research_team_execute",
        assignedRole: "orchestrator",
        params: {
          jobId,
          ticker: effectiveTicker ?? scope.primarySymbol,
          scope: effectiveScope ?? undefined,
          context: effectiveContext,
          agentGroupId: input.agentGroupId ?? undefined,
          analystRoles: analystRoles ?? undefined,
          analystDefinitionIds: analystDefinitionIds ?? undefined,
        },
      },
    });
  } catch (err) {
    await failAnalystResearchJob(jobId, err);
    throw new LaunchAnalystTeamError(
      "dispatch_failed",
      err instanceof Error ? err.message : String(err),
      500
    );
  }

  return {
    ok: true,
    jobId,
    workflowRunId: input.workflowRunId,
    taskId,
    ticker: effectiveTicker ?? scope.primarySymbol,
    scope,
    agentGroupId: input.agentGroupId ?? null,
  };
}
