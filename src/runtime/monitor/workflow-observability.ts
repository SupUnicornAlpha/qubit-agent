import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  llmCallLog,
  mcpCallLog,
  toolCallLog,
} from "../../db/sqlite/schema";
import { loadWorkflowTokenBudgetStatus } from "../llm/workflow-token-budget";

/**
 * Per-workflow observability 汇总。
 *
 * F-P0-05 修复（2026-06）：之前 LLM/per-role token 统计仅读 `agent_step.tokenCount`，
 * 漏算了所有走 `runLlmGateway` 但不经过 reason 节点的内部调用（orchestrator
 * planning / runDebateSession / summarize_team_decision），
 * 导致前端看到 totalTokenCount=null 或 per-role tokens=0。
 *
 * 现在用 `llm_call_log` 作为权威源（每次真实 LLM 调用一行，自带
 * workflowRunId + agentDefinitionId + totalTokens + costUsd）；agent_step
 * 字段保留兼容。
 */
export type WorkflowObservability = {
  workflowRunId: string;
  llm: {
    /**
     * 经过 reason 节点的 LLM 步骤数（来自 agent_step.phase='reason'）。
     * 不包含 orchestrator planning / debate / summarize_team_decision 等
     * 直走 gateway 的"内部"LLM 调用——后者用 `llmCalls` 字段反映。
     */
    reasonSteps: number;
    /** P0-05：所有真实 LLM 调用计数（包含 reason 节点 + 内部直调），来自 llm_call_log */
    llmCalls: number;
    totalTokenCount: number | null;
    /** P0-05：合计 prompt / completion 拆分 + cost，来自 llm_call_log */
    totalPromptTokens: number | null;
    totalCompletionTokens: number | null;
    totalCostUsd: number | null;
    totalReasonLatencyMs: number | null;
  };
  efficiency: {
    averageTokensPerCall: number | null;
    promptTokenShare: number | null;
    cachedPromptTokenShare: number | null;
    nativeToolCallingRate: number | null;
    compactedCalls: number;
    tokenBudget: {
      usedTokens: number;
      maxTotalTokens: number;
      utilization: number;
      softLimitReached: boolean;
      hardLimitReached: boolean;
    };
    promptComponentsChars: Record<string, number>;
    estimatedWasteTokens: {
      parseRetry: number;
      failedToolRecovery: number;
      repeatedStaticContext: number;
      total: number;
    };
  };
  tools: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    topTools: Array<{ name: string; count: number }>;
  };
  mcp: {
    total: number;
    byStatus: Record<string, number>;
    byServer: Array<{ server: string; count: number; success: number; failed: number }>;
  };
  byAgentRole: Array<{
    role: string;
    reasonSteps: number;
    toolCalls: number;
    mcpCalls: number;
    /**
     * P0-05：roll-up from `llm_call_log.totalTokens` (主源) →
     * 回退到 agent_step.tokenCount (老字段)；不再两边一起空。
     */
    tokens: number | null;
    /** P0-05：真实 LLM 调用次数（按 def，含内部调用） */
    llmCalls: number;
    llmPromptTokens: number;
    llmCompletionTokens: number;
    llmCostUsd: number;
  }>;
};

export async function getWorkflowObservability(workflowRunId: string): Promise<WorkflowObservability> {
  const db = await getDb();

  /**
   * P0-05：把 llm_call_log 拉进观测口径。一次性 4 个 query 减少 round-trip；
   * llm_call_log 在生产基本与 agent_step 行数同数量级，全表 fetch 不是瓶颈。
   */
  const [steps, instances, mcpRows, llmRows, tokenBudget] = await Promise.all([
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowRunId)),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowRunId)),
    db.select().from(mcpCallLog).where(eq(mcpCallLog.workflowRunId, workflowRunId)),
    db.select().from(llmCallLog).where(eq(llmCallLog.workflowRunId, workflowRunId)),
    loadWorkflowTokenBudgetStatus(db, workflowRunId),
  ]);

  /**
   * defIds 现在合并两个源：
   *   - agent_instance.definitionId（reason 节点路径）
   *   - llm_call_log.agentDefinitionId（内部直调路径，比如 orchestrator planning）
   * 一次 query 拿齐全部用到的 def role。
   */
  const defIdsRaw = [
    ...instances.map((i) => i.definitionId),
    ...llmRows.map((r) => r.agentDefinitionId).filter((x): x is string => !!x),
  ];
  const defIds = [...new Set(defIdsRaw)];
  const defs =
    defIds.length > 0
      ? await db.select().from(agentDefinition).where(inArray(agentDefinition.id, defIds))
      : [];
  const roleByDef = new Map<string, string>();
  for (const d of defs) {
    roleByDef.set(d.id, d.role);
  }
  const roleByInst = new Map<string, string>();
  for (const inst of instances) {
    const role = roleByDef.get(inst.definitionId) ?? "unknown";
    roleByInst.set(inst.id, role);
  }

  const stepIds = steps.map((s) => s.id);
  const toolRows =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];

  const reasonSteps = steps.filter((s) => s.phase === "reason");
  const totalReasonLatencyMs = reasonSteps.reduce((acc, s) => acc + (s.latencyMs ?? 0), 0) || null;

  /**
   * P0-05：LLM token / cost 全部从 llm_call_log 走（权威源）。
   * 老字段 totalTokenCount 用 llm_call_log.totalTokens 求和；如果该表没行
   * （非常老的 workflow 或 P1 之前的），回退到 agent_step.tokenCount 兼容。
   */
  const llmCallsTotal = llmRows.length;
  const sumLlmTokens = llmRows.reduce((a, r) => a + (r.totalTokens ?? 0), 0);
  const sumLlmPromptTokens = llmRows.reduce((a, r) => a + (r.promptTokens ?? 0), 0);
  const sumLlmCompletionTokens = llmRows.reduce((a, r) => a + (r.completionTokens ?? 0), 0);
  const sumLlmCostUsd = llmRows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const sumAgentStepTokens =
    reasonSteps.reduce((acc, s) => acc + (s.tokenCount ?? 0), 0) || 0;
  const totalTokenCount =
    sumLlmTokens > 0 ? sumLlmTokens : sumAgentStepTokens > 0 ? sumAgentStepTokens : null;
  const totalPromptTokens = sumLlmPromptTokens > 0 ? sumLlmPromptTokens : null;
  const totalCompletionTokens = sumLlmCompletionTokens > 0 ? sumLlmCompletionTokens : null;
  const totalCostUsd = sumLlmCostUsd > 0 ? sumLlmCostUsd : null;
  const sumCachedPromptTokens = llmRows.reduce((a, r) => a + (r.promptCachedTokens ?? 0), 0);

  const promptComponentsChars: Record<string, number> = {};
  let parseRetryEstimatedTokens = 0;
  let nativeToolCallingCalls = 0;
  let compactedCalls = 0;
  let repeatedStaticContextTokens = 0;
  for (const row of llmRows) {
    const meta =
      row.requestMetaJson && typeof row.requestMetaJson === "object"
        ? (row.requestMetaJson as Record<string, unknown>)
        : {};
    if (meta["parseRetryUsed"] === true) {
      parseRetryEstimatedTokens += Math.floor((row.totalTokens ?? 0) / 2);
    }
    if (meta["nativeToolCallingUsed"] === true) nativeToolCallingCalls += 1;
    if (meta["promptCompacted"] === true) compactedCalls += 1;
    const components = meta["promptComponentChars"];
    if (components && typeof components === "object" && !Array.isArray(components)) {
      for (const [key, value] of Object.entries(components as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          promptComponentsChars[key] = (promptComponentsChars[key] ?? 0) + value;
        }
      }
      const iteration = Number(meta["iteration"] ?? 1);
      if (iteration > 1) {
        const componentMap = components as Record<string, unknown>;
        const repeatedChars =
          Number(componentMap["systemFinal"] ?? 0) +
          Number(componentMap["userGoalAndContext"] ?? 0);
        repeatedStaticContextTokens += Math.max(0, Math.floor(repeatedChars / 3));
      }
    }
  }

  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const toolNameCount = new Map<string, number>();
  for (const t of toolRows) {
    byKind[t.toolKind] = (byKind[t.toolKind] ?? 0) + 1;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    toolNameCount.set(t.toolName, (toolNameCount.get(t.toolName) ?? 0) + 1);
  }
  const failedToolCalls = toolRows.filter((row) => row.status !== "success").length;
  const averagePromptTokens =
    llmRows.length > 0 ? Math.floor(sumLlmPromptTokens / llmRows.length) : 0;
  const failedToolRecoveryEstimatedTokens = failedToolCalls * averagePromptTokens;
  const totalEstimatedWasteTokens =
    parseRetryEstimatedTokens +
    failedToolRecoveryEstimatedTokens +
    repeatedStaticContextTokens;

  const mcpByStatus: Record<string, number> = {};
  const mcpServerAgg = new Map<string, { count: number; success: number; failed: number }>();
  for (const m of mcpRows) {
    mcpByStatus[m.status] = (mcpByStatus[m.status] ?? 0) + 1;
    const cur = mcpServerAgg.get(m.serverName) ?? { count: 0, success: 0, failed: 0 };
    cur.count += 1;
    if (m.status === "success") cur.success += 1;
    else cur.failed += 1;
    mcpServerAgg.set(m.serverName, cur);
  }

  const stepByInst = new Map<string, typeof steps>();
  for (const s of steps) {
    const arr = stepByInst.get(s.agentInstanceId) ?? [];
    arr.push(s);
    stepByInst.set(s.agentInstanceId, arr);
  }

  /**
   * P0-05：用一个 Map<role, aggregated> 收集，避免老实现 O(role^2 × instances)
   * 重复扫描。所有 role 来源：
   *   - agent_instance.definitionId → role
   *   - llm_call_log.agentDefinitionId → role
   * 后者承载内部直调 LLM（orchestrator planning / debate / summarize）。
   */
  type RoleAgg = {
    role: string;
    reasonSteps: number;
    toolCalls: number;
    mcpCalls: number;
    legacyStepTokens: number;
    llmCalls: number;
    llmTokens: number;
    llmPromptTokens: number;
    llmCompletionTokens: number;
    llmCostUsd: number;
  };
  const ensure = (m: Map<string, RoleAgg>, role: string): RoleAgg => {
    let agg = m.get(role);
    if (!agg) {
      agg = {
        role,
        reasonSteps: 0,
        toolCalls: 0,
        mcpCalls: 0,
        legacyStepTokens: 0,
        llmCalls: 0,
        llmTokens: 0,
        llmPromptTokens: 0,
        llmCompletionTokens: 0,
        llmCostUsd: 0,
      };
      m.set(role, agg);
    }
    return agg;
  };
  const roleAggMap = new Map<string, RoleAgg>();

  for (const inst of instances) {
    const role = roleByInst.get(inst.id) ?? "unknown";
    const agg = ensure(roleAggMap, role);
    const roleSteps = stepByInst.get(inst.id) ?? [];
    for (const s of roleSteps) {
      if (s.phase === "reason") {
        agg.reasonSteps += 1;
        agg.legacyStepTokens += s.tokenCount ?? 0;
      }
    }
    const roleStepIds = new Set(roleSteps.map((s) => s.id));
    for (const t of toolRows) if (roleStepIds.has(t.agentStepId)) agg.toolCalls += 1;
    for (const m of mcpRows) {
      const st = m.agentStepId ? steps.find((s) => s.id === m.agentStepId) : undefined;
      if (st && roleStepIds.has(st.id)) agg.mcpCalls += 1;
    }
  }

  /**
   * 用 llm_call_log.agentDefinitionId 回标 role；行内 agentDefinitionId 可能
   * 为 null（早期未冗余 / 路径未传 def），归到 'internal_llm' 桶——这样
   * orchestrator planning / debate / summarize_team_decision 这种"准内部
   * 调用"也能在 byAgentRole 里被审计，而不是悄悄消失在总数里。
   */
  for (const r of llmRows) {
    const role = r.agentDefinitionId ? (roleByDef.get(r.agentDefinitionId) ?? "unknown") : "internal_llm";
    const agg = ensure(roleAggMap, role);
    agg.llmCalls += 1;
    agg.llmTokens += r.totalTokens ?? 0;
    agg.llmPromptTokens += r.promptTokens ?? 0;
    agg.llmCompletionTokens += r.completionTokens ?? 0;
    agg.llmCostUsd += r.costUsd ?? 0;
  }

  const byAgentRole: WorkflowObservability["byAgentRole"] = [...roleAggMap.values()]
    .map((agg) => ({
      role: agg.role,
      reasonSteps: agg.reasonSteps,
      toolCalls: agg.toolCalls,
      mcpCalls: agg.mcpCalls,
      tokens: agg.llmTokens > 0 ? agg.llmTokens : agg.legacyStepTokens > 0 ? agg.legacyStepTokens : null,
      llmCalls: agg.llmCalls,
      llmPromptTokens: agg.llmPromptTokens,
      llmCompletionTokens: agg.llmCompletionTokens,
      llmCostUsd: agg.llmCostUsd,
    }))
    .sort((a, b) => a.role.localeCompare(b.role));

  return {
    workflowRunId,
    llm: {
      reasonSteps: reasonSteps.length,
      llmCalls: llmCallsTotal,
      totalTokenCount,
      totalPromptTokens,
      totalCompletionTokens,
      totalCostUsd,
      totalReasonLatencyMs,
    },
    efficiency: {
      averageTokensPerCall:
        llmCallsTotal > 0 && totalTokenCount !== null
          ? totalTokenCount / llmCallsTotal
          : null,
      promptTokenShare:
        sumLlmTokens > 0 ? sumLlmPromptTokens / sumLlmTokens : null,
      cachedPromptTokenShare:
        sumLlmPromptTokens > 0 ? sumCachedPromptTokens / sumLlmPromptTokens : null,
      nativeToolCallingRate:
        llmCallsTotal > 0 ? nativeToolCallingCalls / llmCallsTotal : null,
      compactedCalls,
      tokenBudget: {
        usedTokens: tokenBudget.usedTokens,
        maxTotalTokens: tokenBudget.policy.maxTotalTokens,
        utilization: tokenBudget.utilization,
        softLimitReached: tokenBudget.softLimitReached,
        hardLimitReached: tokenBudget.hardLimitReached,
      },
      promptComponentsChars,
      estimatedWasteTokens: {
        parseRetry: parseRetryEstimatedTokens,
        failedToolRecovery: failedToolRecoveryEstimatedTokens,
        repeatedStaticContext: repeatedStaticContextTokens,
        total: totalEstimatedWasteTokens,
      },
    },
    tools: {
      total: toolRows.length,
      byKind,
      byStatus,
      topTools: [...toolNameCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => ({ name, count })),
    },
    mcp: {
      total: mcpRows.length,
      byStatus: mcpByStatus,
      byServer: [...mcpServerAgg.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([server, v]) => ({ server, ...v })),
    },
    byAgentRole,
  };
}
