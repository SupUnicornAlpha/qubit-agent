import { and, eq, gte, sql } from "drizzle-orm";
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
  // 对话中的一次用户请求可能同时驱动 Orchestrator 和多个 A2A 专家。
  // 这里统计的是整条任务树的 token 总和，而不是单次模型调用；100K 会让一个正常的
  // 多 Agent 研究在第二、三个专家处被误杀。预算仍按 workflow.startedAt 隔离到当前
  // 对话轮次，因此提高单轮上限不会让长对话的历史 token 永久累积。
  if (input.source === "chat") return 400_000;
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
  const workflowRows = await db
    .select({
      source: workflowRun.source,
      mode: workflowRun.mode,
      researchScenarioId: workflowRun.researchScenarioId,
      loopOptionsJson: workflowRun.loopOptionsJson,
      startedAt: workflowRun.startedAt,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);

  const workflow = workflowRows[0] ?? {
    source: null,
    mode: null,
    researchScenarioId: null,
    loopOptionsJson: {},
    startedAt: null,
  };
  /**
   * workflow_run 会被同一 chat session 的后续消息复用，复用时 startedAt 会刷新，
   * 而 llm_call_log 会保留用于历史监控。预算属于“本轮执行”的安全护栏，不能按
   * workflowRunId 终身累计，否则长对话累计超过上限后将永久无法继续。
   *
   * 老数据或异常缺失 workflow 时保留原来的全量汇总降级，避免悄悄放开保护。
   */
  const usageWhere = workflow.startedAt
    ? and(
        eq(llmCallLog.workflowRunId, workflowRunId),
        gte(llmCallLog.createdAt, workflow.startedAt)
      )
    : eq(llmCallLog.workflowRunId, workflowRunId);
  const usageRows = await db
    .select({
      usedTokens: sql<number>`coalesce(sum(${llmCallLog.totalTokens}), 0)`,
    })
    .from(llmCallLog)
    .where(usageWhere);

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
