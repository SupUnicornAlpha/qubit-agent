import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { resolveResearchScope, type ResearchScopeInput } from "../../types/research-scope";
import { completeAnalystResearchJob, failAnalystResearchJob } from "./analyst-research-jobs";
import { RESEARCH_TEAM_SLOT_SET, runAnalystTeam, type AnalystTeamResult } from "./analyst-team";

export type ParsedResearchTeamExecute = {
  jobId: string;
  ticker: string;
  scope?: ResearchScopeInput | null;
  context?: string;
  agentGroupId?: string | null;
  analystDefinitionIds?: string[];
  analystRoles?: AgentRole[];
};

export type ResearchTeamExecuteParseResult =
  | { ok: true; params: ParsedResearchTeamExecute }
  | { ok: false; jobId: string; error: Error };

export function parseResearchTeamExecutePayload(
  payload: TaskAssignPayload
): ResearchTeamExecuteParseResult {
  const pr = payload.params as Record<string, unknown>;
  const jobId = typeof pr.jobId === "string" ? pr.jobId : "";
  const ticker = typeof pr.ticker === "string" ? pr.ticker.trim() : "";
  const scope = (pr.scope as ResearchScopeInput | null | undefined) ?? undefined;
  const resolved = resolveResearchScope({ ticker, scope });

  if (!jobId || (!ticker && !scope && resolved.primarySymbol === "UNKNOWN")) {
    return {
      ok: false,
      jobId,
      error: new Error("research_team_execute requires params.jobId and params.ticker or scope"),
    };
  }

  let agentGroupId: string | null | undefined;
  if ("agentGroupId" in pr) {
    const ag = pr.agentGroupId;
    if (ag === null) agentGroupId = null;
    else if (typeof ag === "string") agentGroupId = ag.trim() || null;
  }

  const rawDefIds = pr.analystDefinitionIds;
  const analystDefinitionIds =
    Array.isArray(rawDefIds) && rawDefIds.length > 0
      ? rawDefIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : undefined;

  const rawRoles = pr.analystRoles;
  const analystRoles =
    Array.isArray(rawRoles) && rawRoles.length > 0
      ? (rawRoles.filter(
          (r): r is AgentRole => typeof r === "string" && RESEARCH_TEAM_SLOT_SET.has(r)
        ) as AgentRole[])
      : undefined;

  const context = typeof pr.context === "string" ? pr.context : undefined;

  return {
    ok: true,
    params: {
      jobId,
      ticker: ticker || resolved.primarySymbol,
      scope,
      context,
      agentGroupId,
      analystDefinitionIds,
      analystRoles,
    },
  };
}

export function failResearchTeamExecuteJob(jobId: string, error: unknown): void {
  if (!jobId) return;
  failAnalystResearchJob(jobId, error instanceof Error ? error : new Error(String(error)));
}

/** 运行研究团队并标记 job 完成（不含 workflow / A2A 消息副作用） */
export async function executeResearchTeamWorkflow(input: {
  workflowRunId: string;
  params: ParsedResearchTeamExecute;
}): Promise<AnalystTeamResult> {
  const teamResult = await runAnalystTeam({
    workflowRunId: input.workflowRunId,
    ticker: input.params.ticker,
    scope: input.params.scope,
    context: input.params.context,
    agentGroupId: input.params.agentGroupId,
    analystRoles: input.params.analystRoles,
    analystDefinitionIds: input.params.analystDefinitionIds,
  });
  completeAnalystResearchJob(input.params.jobId, teamResult);
  return teamResult;
}
