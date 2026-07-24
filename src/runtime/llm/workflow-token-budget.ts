import { eq, sql } from "drizzle-orm";
import type { getDb } from "../../db/sqlite/client";
import { llmCallLog, workflowRun } from "../../db/sqlite/schema";
import { type WorkflowTokenBudget, parseLoopOptionsJson } from "../../types/loop";

type Db = Awaited<ReturnType<typeof getDb>>;

export type ResolvedWorkflowTokenBudget = {
  maxTotalTokens: number;
  softLimitRatio: number;
  maxPromptTokensPerCall: number;
  maxSystemPromptChars: number;
  maxUserPromptChars: number;
};

export type WorkflowTokenBudgetStatus = {
  workflowRunId: string;
  usedTokens: number;
  remainingTokens: number;
  utilization: number;
  softLimitReached: boolean;
  hardLimitReached: boolean;
  policy: ResolvedWorkflowTokenBudget;
};

const DEFAULTS = {
  softLimitRatio: 0.8,
  maxPromptTokensPerCall: 18_000,
  maxSystemPromptChars: 20_000,
  maxUserPromptChars: 24_000,
} as const;

function positiveEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function defaultTotalTokens(input: {
  source: string | null;
  mode: string | null;
  researchScenarioId: string | null;
}): number {
  const envDefault = positiveEnv("QUBIT_WORKFLOW_TOKEN_BUDGET");
  if (envDefault) return envDefault;
  if (input.source === "chat") return 100_000;
  if (input.mode === "live") return 120_000;
  if (input.mode === "backtest" || input.mode === "simulation") return 250_000;
  if (input.researchScenarioId) return 300_000;
  return 400_000;
}

export function resolveWorkflowTokenBudget(
  override: WorkflowTokenBudget | undefined,
  workflow: {
    source: string | null;
    mode: string | null;
    researchScenarioId: string | null;
  }
): ResolvedWorkflowTokenBudget {
  return {
    maxTotalTokens: override?.maxTotalTokens ?? defaultTotalTokens(workflow),
    softLimitRatio: override?.softLimitRatio ?? DEFAULTS.softLimitRatio,
    maxPromptTokensPerCall:
      override?.maxPromptTokensPerCall ??
      positiveEnv("QUBIT_MAX_PROMPT_TOKENS_PER_CALL") ??
      DEFAULTS.maxPromptTokensPerCall,
    maxSystemPromptChars:
      override?.maxSystemPromptChars ??
      positiveEnv("QUBIT_MAX_SYSTEM_PROMPT_CHARS") ??
      DEFAULTS.maxSystemPromptChars,
    maxUserPromptChars:
      override?.maxUserPromptChars ??
      positiveEnv("QUBIT_MAX_USER_PROMPT_CHARS") ??
      DEFAULTS.maxUserPromptChars,
  };
}

export async function loadWorkflowTokenBudgetStatus(
  db: Db,
  workflowRunId: string
): Promise<WorkflowTokenBudgetStatus> {
  const [workflowRows, usageRows] = await Promise.all([
    db
      .select({
        source: workflowRun.source,
        mode: workflowRun.mode,
        researchScenarioId: workflowRun.researchScenarioId,
        loopOptionsJson: workflowRun.loopOptionsJson,
      })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowRunId))
      .limit(1),
    db
      .select({
        usedTokens: sql<number>`coalesce(sum(${llmCallLog.totalTokens}), 0)`,
      })
      .from(llmCallLog)
      .where(eq(llmCallLog.workflowRunId, workflowRunId)),
  ]);

  const workflow = workflowRows[0] ?? {
    source: null,
    mode: null,
    researchScenarioId: null,
    loopOptionsJson: {},
  };
  const options = parseLoopOptionsJson(workflow.loopOptionsJson);
  const policy = resolveWorkflowTokenBudget(options.tokenBudget, workflow);
  const usedTokens = Math.max(0, Number(usageRows[0]?.usedTokens ?? 0));
  const utilization = usedTokens / policy.maxTotalTokens;

  return {
    workflowRunId,
    usedTokens,
    remainingTokens: Math.max(0, policy.maxTotalTokens - usedTokens),
    utilization,
    softLimitReached: utilization >= policy.softLimitRatio,
    hardLimitReached: usedTokens >= policy.maxTotalTokens,
    policy,
  };
}
