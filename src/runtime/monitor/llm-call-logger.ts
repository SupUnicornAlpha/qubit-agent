/**
 * 监控 V2 P1 — LLM 调用日志写入器。
 *
 * 设计目标：
 *   - 每次 LLM 调用（reason 节点 / 未来的 perceive 等）写一条 `llm_call_log`；
 *   - 不污染 gateway 本身（保持 src/runtime/llm/gateway.ts 纯请求逻辑）；
 *   - 失败不阻塞主链路（try/catch + warn）；
 *   - 严格 secret strip：systemPrompt / userPrompt 只存长度与字符指纹，
 *     不存原文（设计文档 §7.1：「unconditional strip Authorization / api_key」）。
 *
 * 用法（在 reason 节点 / execute-agent-react.ts 调完 invokeWithFallback 之后）：
 *
 *   await writeLlmCallLog({
 *     workflowRunId,
 *     agentStepId: reasonStepId,
 *     provider: result.modelUsed.provider,
 *     model: result.modelUsed.model,
 *     usage: result.usage,
 *     latencyMs: result.latencyMs,
 *     status: result.fallbackUsed ? "fallback" : "success",
 *     systemPromptLen: systemPrompt.length,
 *     userPromptLen: userPrompt.length,
 *   });
 *
 * 失败路径：catch 后用 status='error' 调一次，传 errorMessage（已截断 500 字）。
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/sqlite/client";
import { llmCallLog } from "../../db/sqlite/schema";
import { estimateLlmCostUsd } from "../../util/llm-pricing";

export type LlmCallLogInput = {
  workflowRunId: string;
  /** 来源 step；reason 节点是 reasonStepId；外部 cli loop 也可写但无 step 时传 null */
  agentStepId: string | null;
  /**
   * 监控 v3 P0：来源 Agent 的 definitionId。冗余到 llm_call_log 让
   * /monitor/timeseries?source=llm_call_log&groupBy=agentDefinitionId 直接走索引,
   * 不必反查 agent_step → agent_instance → agent_definition。
   * CLI loop 路径暂时没有 def 概念，可传 null。
   */
  agentDefinitionId?: string | null;
  provider: string;
  model: string;
  /**
   * 来自 gateway / provider 返回；缺失字段写 null 不写 0，避免和「真实 0 token」混淆。
   *
   * 字段：
   *   - promptTokens / completionTokens / totalTokens：标准用量
   *   - cachedPromptTokens：OpenAI Responses / Anthropic prompt cache **命中** token 数
   *   - cacheCreationInputTokens（P3-1）：Anthropic prompt cache **写入** token 数；
   *     落到 requestMetaJson 而不是单独列 — 出现频率有限，加列性价比低
   *   - reasoningTokens：o-series / gpt-5 / DeepSeek-R1 链式思考 token 数（已计入 completionTokens）
   */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedPromptTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
  };
  latencyMs: number;
  /** 流式首 token / 非流式整段 latency；不写 0，无信息时写 null。 */
  firstTokenLatencyMs?: number;
  /**
   * 'stop' / 'length' / 'tool_calls' / 'content_filter' / 'incomplete' 等。
   * 用于诊断 truncation / 拒答 / max_tokens 截断等问题；与 status（成功/失败口径）正交。
   */
  finishReason?: string;
  /** 服务端 response id：chatcmpl-* / resp_* / msg_*。用于跨日志追溯。 */
  responseId?: string;
  status: "success" | "error" | "timeout" | "fallback";
  errorMessage?: string;
  /** 计算 cost / token 命中率用；不存原文 */
  systemPromptLen?: number;
  userPromptLen?: number;
  /** 已 redact 的额外元信息（可选；调用方应自己跑 redactPayload 后再传入） */
  extraMeta?: Record<string, unknown>;
};

/** 错误消息截断长度，防止把 LLM 异常堆栈整体写进 sqlite */
const ERR_MSG_MAX = 500;

export async function writeLlmCallLog(input: LlmCallLogInput): Promise<void> {
  try {
    const db = await getDb();
    const usage = input.usage ?? {};
    const prompt = isNonNegInt(usage.promptTokens) ? usage.promptTokens : null;
    const completion = isNonNegInt(usage.completionTokens) ? usage.completionTokens : null;
    let total = isNonNegInt(usage.totalTokens) ? usage.totalTokens : null;
    if (total === null && (prompt !== null || completion !== null)) {
      total = (prompt ?? 0) + (completion ?? 0);
    }
    const cached = isNonNegInt(usage.cachedPromptTokens) ? usage.cachedPromptTokens : null;
    const reasoning = isNonNegInt(usage.reasoningTokens) ? usage.reasoningTokens : null;
    /**
     * P3-1：cache_creation_input_tokens（Anthropic 写 cache 的 token 数）。
     * 落到 requestMetaJson.cacheCreationInputTokens，让监控分清"miss + 写"与
     * "miss 不写"。cost 函数也吃这个字段（写 cache 1.25× 加价）。
     */
    const cacheCreation = isNonNegInt(usage.cacheCreationInputTokens)
      ? usage.cacheCreationInputTokens
      : null;
    /**
     * P2/P3：把 cached / cacheCreation 透传给 cost 函数：
     *   - cached: OpenAI 50% / Anthropic 10% read 折扣
     *   - cacheCreation: Anthropic 1.25× 写加价
     * reasoningTokens 已计入 completionTokens，不重复计费，仅作为打点字段。
     */
    const cost =
      prompt !== null || completion !== null
        ? estimateLlmCostUsd({
            provider: input.provider,
            model: input.model,
            promptTokens: prompt ?? 0,
            completionTokens: completion ?? 0,
            ...(cached !== null ? { cachedPromptTokens: cached } : {}),
            ...(cacheCreation !== null ? { cacheCreationInputTokens: cacheCreation } : {}),
          })
        : null;

    const requestMeta: Record<string, unknown> = {
      systemPromptLen: input.systemPromptLen ?? null,
      userPromptLen: input.userPromptLen ?? null,
      ...(cacheCreation !== null ? { cacheCreationInputTokens: cacheCreation } : {}),
      ...(input.extraMeta ?? {}),
    };

    const ttft =
      typeof input.firstTokenLatencyMs === "number" && Number.isFinite(input.firstTokenLatencyMs)
        ? Math.max(0, Math.round(input.firstTokenLatencyMs))
        : null;
    const finishReason =
      typeof input.finishReason === "string" && input.finishReason.trim()
        ? input.finishReason.trim().slice(0, 64)
        : null;
    const responseId =
      typeof input.responseId === "string" && input.responseId.trim()
        ? input.responseId.trim().slice(0, 128)
        : null;

    await db.insert(llmCallLog).values({
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      agentStepId: input.agentStepId,
      agentDefinitionId: input.agentDefinitionId ?? null,
      provider: input.provider,
      model: input.model,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      promptCachedTokens: cached,
      reasoningTokens: reasoning,
      firstTokenLatencyMs: ttft,
      finishReason,
      responseId,
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      status: input.status,
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, ERR_MSG_MAX) : null,
      costUsd: cost,
      requestMetaJson: requestMeta as Record<string, unknown>,
    });
  } catch (err) {
    /**
     * 监控失败**绝不**抛出 — reason node 的主流程已经完成了，不该因为日志写库
     * 失败被回滚。打一条 warn 让 dev/运维定位 sqlite busy / disk full 即可。
     */
    console.warn(`[llmCallLog] insert failed: ${(err as Error).message}`);
  }
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
