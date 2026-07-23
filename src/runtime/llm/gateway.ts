import OpenAI from "openai";
import type { RuntimeModelConfig } from "../config/model-config";
import { executeWithPolicy } from "../external-call/policy";
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from "../../util/fetch-with-timeout";
import { modelCapability, sanitizeChatCompletionsBody } from "./model-capabilities";
import { readSseEvents } from "./sse-stream";

/**
 * 调用方对单次 LLM 请求的采样偏好（可选）。
 *
 * 设计思路（低耦合）：
 *   - 完全 optional：所有 caller 不传等价于走网关默认值（0.1 / 1024 / undefined）；
 *   - 网关内部按模型能力 sanitize（reasoning 模型自动忽略 temperature/topP）；
 *   - reason 节点 / 未来 agent_definition.llmConfig 加列后，可逐步把字段填进来。
 */
export interface LlmSamplingOverrides {
  /** 0~2，未传时各 provider 用历史默认 0.1（passthrough 模型）；reasoning 模型忽略。 */
  temperature?: number;
  /** 0~1，未传时不发；reasoning 模型忽略。 */
  topP?: number;
  /**
   * 输出 token 上限：
   *   - chat.completions：写到 `max_tokens`
   *   - responses：写到 `max_output_tokens`
   *   - Anthropic：写到 `max_tokens`（默认 4096，旧版本是 1024 上限太低）
   */
  maxOutputTokens?: number;
  /**
   * 仅 Responses API + 推理模型族生效。'low'/'medium'/'high'。其它路径忽略。
   */
  reasoningEffort?: "low" | "medium" | "high";
}

/**
 * P3-3：网关层原生 tools 入参（基础设施，opt-in）。
 *
 * 设计原则：
 *   - 调用方完全 optional —— 不传 = 与 P2 行为零差异（reason 节点目前仍走
 *     `<TOOL_CALL>` 文本协议）。
 *   - 网关负责 schema 翻译：把统一的 `LlmToolDefinition` 翻译成各 provider 的 wire format。
 *   - **不会** 把 tool 调用结果 round-trip 回模型（那是 caller / agent loop 的职责）。
 *     网关只把模型「想调的工具」解析成 `LlmGatewayResult.toolCalls` 透出去。
 *
 * Provider 支持矩阵：
 *   - OpenAI Chat Completions（GPT-4 / GPT-4o / GPT-4.1）：传入 `tools=[{type:'function',...}]`，
 *     从 choices[0].message.tool_calls 解析。
 *   - OpenAI Responses（gpt-5 / o-series）：传入 `tools=[{type:'function',name,parameters}]`，
 *     从 output[].type='function_call' 解析。
 *   - Anthropic Messages：传入 `tools=[{name,input_schema}]`，从 content[].type='tool_use' 解析。
 *   - Ollama / OpenAI-compatible 通用网关（DeepSeek、智谱）：维持 chat.completions 协议，
 *     若 provider 不支持会被 sanitize 掉（P3-3 阶段不强校验，由 caller 选模型时承担）。
 */
export interface LlmToolDefinition {
  /** 工具名（snake_case 推荐，符合 OpenAI / Anthropic 命名约束 ^[a-zA-Z0-9_-]+$）。 */
  name: string;
  /** 工具用途的人类可读描述；模型会读它决定何时调用。 */
  description?: string;
  /** JSON Schema（draft-07 子集），描述该工具入参 shape。空对象 = 无参。 */
  parameters: Record<string, unknown>;
}

export interface LlmToolCallRequest {
  /**
   * 服务端给的 call id。OpenAI 写在 `tool_calls[].id`；Anthropic 写在 `content[].id`；
   * Responses 写在 `output[].call_id`。下一步把工具结果回传时必须带回。
   *
   * **注意**：网关不会校验唯一性 / 编码规则，原样透传。
   */
  id: string;
  name: string;
  /**
   * 解析后的入参 object。OpenAI 给的是 stringified JSON，网关已 parse；
   * 解析失败时 args = {} 并把原始字符串放在 `rawArgs`，避免 caller 因 JSON 报错挂掉。
   */
  args: Record<string, unknown>;
  rawArgs?: string;
}

export interface LlmGatewayInput {
  config: RuntimeModelConfig;
  systemPrompt: string;
  userPrompt: string;
  onToken: (token: string) => void;
  /** P0-3：调用方自定义采样参数；不传走默认值。 */
  sampling?: LlmSamplingOverrides;
  /**
   * P3-3：可选的 tools 列表。传了之后：
   *   - 网关把 tools 翻译成 provider wire format 一并发送；
   *   - response 中的 tool_calls 会解析到 `LlmGatewayResult.toolCalls`。
   * 不传 = 完全保持 P2 行为，answer 字段照常给文本（含 `<TOOL_CALL>` sentinel）。
   */
  tools?: LlmToolDefinition[];
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * 命中 prompt cache 的 token 数：
   *   - OpenAI Responses：`input_tokens_details.cached_tokens`（≈ 1/2 标准输入价）
   *   - Anthropic Messages（启用 prompt-caching beta 时）：`cache_read_input_tokens`（≈ 1/10 标准输入价）
   *   - 其它路径（chat.completions / Ollama）不会有此字段
   */
  cachedPromptTokens?: number;
  /**
   * Anthropic prompt-caching 专属：本次请求**写入**缓存的 token 数。Anthropic
   * 计费按 1.25× 标准输入价收（写一次缓存，后续 5 分钟内同 hash 读以 0.1× 价收回本）。
   *
   * 我们落库为单独字段是为了：
   *   1) 监控 cache hit/miss 比例时区分"miss + 写"与"miss 不写"；
   *   2) 后续做"是否值得开 caching"决策时有依据。
   *
   * 若没启用 prompt caching，字段始终缺省。
   */
  cacheCreationInputTokens?: number;
  /**
   * Responses API 专属：模型用于 chain-of-thought 的推理 token 数（计费按
   * completion 价）。`completionTokens` 已经包含这一份，本字段单独存便于做
   * "reasoning ratio" 监控。
   */
  reasoningTokens?: number;
}

export interface LlmGatewayResult {
  answer: string;
  /** Token consumption reported by provider (when available). */
  usage?: LlmTokenUsage;
  /** Wall-clock latency of the LLM call, measured at gateway boundary. */
  latencyMs: number;
  /**
   * 首 token 到达延迟（streaming 模式下从请求 start 到第一个 content delta；
   * 非流式则等于 latencyMs）。可选，未实现的 provider 不写。
   */
  firstTokenLatencyMs?: number;
  /**
   * 服务端 response id（OpenAI: chatcmpl-* / resp_*；Anthropic: msg_*；
   * 其它 provider 当前不返回）。用于跨日志追溯。
   */
  responseId?: string;
  /**
   * 终止原因（OpenAI/Anthropic 字面量直透；缺失置 undefined）。常见值：
   *   stop / length / max_tokens / max_output_tokens / tool_calls / content_filter / error
   */
  finishReason?: string;
  /**
   * P3-3：模型主动请求调用的工具列表。仅在调用方传了 `LlmGatewayInput.tools`
   * 且模型确实返回 tool 调用时存在；否则 undefined。
   *
   * 网关**不**执行工具，只把意图透传。caller 负责执行 + 把结果通过新的请求
   * 回传给模型（多轮 tool-use loop）。
   */
  toolCalls?: LlmToolCallRequest[];
}

function splitForPseudoStreaming(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * P3-3 helpers：tool definition / tool_calls 解析。
 *
 * 拆成独立 function 而不是 inline，是为了：
 *   1) 三条 provider 路径（OpenAI Chat / Anthropic / Responses）共用同一组 schema 翻译；
 *   2) 单测可以脱网验证 schema 生成正确性；
 *   3) 解析 tool_calls 时 args 可能是 stringified JSON（OpenAI）也可能是 object（Anthropic），
 *      统一在这里 normalize。
 */
type OpenAIToolWire = { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } };
type AnthropicToolWire = { name: string; description?: string; input_schema: Record<string, unknown> };
type ResponsesToolWire = { type: "function"; name: string; description?: string; parameters: Record<string, unknown> };

function toOpenAITools(tools: LlmToolDefinition[] | undefined): OpenAIToolWire[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters ?? {},
    },
  }));
}

function toAnthropicTools(tools: LlmToolDefinition[] | undefined): AnthropicToolWire[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    /** Anthropic 字段名是 input_schema（不是 parameters） */
    input_schema: t.parameters ?? {},
  }));
}

function toResponsesTools(tools: LlmToolDefinition[] | undefined): ResponsesToolWire[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.parameters ?? {},
  }));
}

/**
 * 把 OpenAI/Responses 风格的 stringified arguments 解析成对象。失败时不抛错，
 * 返回 args={} 并把原文落 rawArgs，让 caller 自己决定 fail-fast 还是 fail-soft。
 */
function parseToolArguments(raw: unknown): { args: Record<string, unknown>; rawArgs?: string } {
  if (raw == null) return { args: {} };
  if (typeof raw === "object") {
    return { args: raw as Record<string, unknown> };
  }
  if (typeof raw === "string") {
    if (raw.trim().length === 0) return { args: {}, rawArgs: raw };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { args: parsed as Record<string, unknown>, rawArgs: raw };
      }
      return { args: {}, rawArgs: raw };
    } catch {
      return { args: {}, rawArgs: raw };
    }
  }
  return { args: {} };
}

/**
 * P3-3：增量 tool_calls 累积器（OpenAI Chat Completions 流式）。
 *
 * OpenAI 在 stream 模式把 tool_calls 切分成多帧 delta：
 *   帧 1: { index:0, id:'call_abc', function:{ name:'fetch' } }
 *   帧 2: { index:0, function:{ arguments:'{"sym' } }
 *   帧 N: { index:0, function:{ arguments:'bol":"BTC"}' } }
 * 我们按 `index` 累积，最终在 stream 结束后 parse arguments 字符串。
 */
type ToolCallAccumulator = Map<
  number,
  { id?: string; name?: string; argsBuf: string }
>;

function accumulateOpenAIToolCallDelta(
  acc: ToolCallAccumulator,
  delta: unknown,
): void {
  if (!Array.isArray(delta)) return;
  for (const item of delta) {
    if (!item || typeof item !== "object") continue;
    const obj = item as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
    const idx = typeof obj.index === "number" ? obj.index : 0;
    let cur = acc.get(idx);
    if (!cur) {
      cur = { argsBuf: "" };
      acc.set(idx, cur);
    }
    if (typeof obj.id === "string" && obj.id.length > 0) cur.id = obj.id;
    if (obj.function) {
      if (typeof obj.function.name === "string" && obj.function.name.length > 0) {
        cur.name = obj.function.name;
      }
      if (typeof obj.function.arguments === "string") {
        cur.argsBuf += obj.function.arguments;
      }
    }
  }
}

function finalizeOpenAIToolCalls(acc: ToolCallAccumulator): LlmToolCallRequest[] | undefined {
  if (acc.size === 0) return undefined;
  const out: LlmToolCallRequest[] = [];
  /** 按 index 排序，保持模型给出的调用顺序（多 tool 调用时必要） */
  const sorted = [...acc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, cur] of sorted) {
    if (!cur.id || !cur.name) continue; // 帧丢失/顺序错乱的兜底，丢弃半成品
    const { args, rawArgs } = parseToolArguments(cur.argsBuf);
    out.push({
      id: cur.id,
      name: cur.name,
      args,
      ...(rawArgs !== undefined ? { rawArgs } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Rough fallback estimator when provider does not report usage (e.g. Ollama
 * without prompt_eval_count, partial Anthropic streams, mock). 4 chars≈1 token
 * is the conventional OpenAI rule of thumb.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeUsage(usage: LlmTokenUsage | undefined): LlmTokenUsage | undefined {
  if (!usage) return undefined;
  const {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  } = usage;
  if (
    (promptTokens === undefined || promptTokens === 0) &&
    (completionTokens === undefined || completionTokens === 0) &&
    (totalTokens === undefined || totalTokens === 0)
  ) {
    return undefined;
  }
  const total =
    totalTokens ??
    ((promptTokens ?? 0) + (completionTokens ?? 0) || undefined);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * 把 chat.completions 的 finish_reason 字面量原样返回；空值收敛成 undefined
 * 便于上游"无信息"判定。
 */
function pickFinishReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v ? v : undefined;
}

/**
 * P2：DeepSeek-R1 / deepseek-reasoner 在 chat.completions 流里的
 * `delta.reasoning_content` 字符数 → reasoning tokens 粗估。
 *
 * 估算规则：`ceil(chars / 4)`。理由：
 *   - DeepSeek 用 BPE tokenizer，中英混合时一个 token 平均 ≈ 3–5 chars；
 *   - 我们没法在客户端跑 tokenizer，但 chars/4 在常见 reasoning 文本上偏差 < 30%；
 *   - 该值仅用于监控（reasoning ratio 维度），不参与计费 / 决策，精度足够。
 *
 * 仅在上游 usage.reasoning_tokens 缺失时调用。导出给单测覆盖。
 */
export function estimateReasoningTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/**
 * P0-1 路由：openai provider 入口。按 model capability 决定走 chat.completions
 * 还是 responses。`QUBIT_LLM_USE_RESPONSES_API="0"` 可强制全部回到 chat（兜底
 * 给 baseURL 指到老代理 / litellm 还没接 /v1/responses 的场景）。
 */
async function runOpenAI(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const cap = modelCapability(input.config.model);
  if (cap.apiPath === "responses" && process.env["QUBIT_LLM_USE_RESPONSES_API"] !== "0") {
    return runOpenAIResponses(input);
  }
  return runOpenAIChat(input);
}

/**
 * 经典 chat.completions 路径（gpt-4o / gpt-3.5 / 老 OpenAI 兼容代理）。
 * 推理模型走这里时通过 sanitize 兜底 strip 受限字段，但官方推荐应该走 responses。
 */
async function runOpenAIChat(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const apiKey = input.config.apiKey || process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai provider");
  }
  const client = new OpenAI({ apiKey, baseURL: input.config.baseUrl });
  const startedAt = Date.now();
  const sampling = input.sampling ?? {};
  const temperature = sampling.temperature ?? 0.1;
  /**
   * 推理类模型族（gpt-5* / o1-3-4*）只接受 default temperature；用 sanitize
   * 去掉受限字段，避免 400 + 重试 + 熔断器误开。
   */
  const oaiTools = toOpenAITools(input.tools);
  const requestBody = sanitizeChatCompletionsBody(input.config.model, {
    model: input.config.model,
    messages: [
      { role: "system" as const, content: input.systemPrompt },
      { role: "user" as const, content: input.userPrompt },
    ],
    temperature,
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling.maxOutputTokens !== undefined ? { max_tokens: sampling.maxOutputTokens } : {}),
    /** P3-3：可选 tools。不传时与 P2 行为零差。 */
    ...(oaiTools ? { tools: oaiTools } : {}),
    stream: true as const,
    stream_options: { include_usage: true },
  });
  const stream = await client.chat.completions.create(requestBody);
  let answer = "";
  let usage: LlmTokenUsage | undefined;
  let firstTokenLatencyMs: number | undefined;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  /** P3-3：tool_calls 增量累积器；空 = 模型未发起 tool 调用 */
  const toolCallAcc: ToolCallAccumulator = new Map();
  for await (const chunk of stream) {
    if (!responseId && typeof (chunk as { id?: string }).id === "string") {
      responseId = (chunk as { id: string }).id;
    }
    const delta = chunk.choices[0]?.delta as
      | { content?: string; tool_calls?: unknown }
      | undefined;
    const token = delta?.content ?? "";
    if (token) {
      if (firstTokenLatencyMs === undefined) {
        firstTokenLatencyMs = Date.now() - startedAt;
      }
      answer += token;
      input.onToken(token);
    }
    /** P3-3：原生 tool_calls delta 增量入账 */
    if (delta && Array.isArray(delta.tool_calls)) {
      accumulateOpenAIToolCallDelta(toolCallAcc, delta.tool_calls);
    }
    const choiceFinish = chunk.choices[0]?.finish_reason;
    const fr = pickFinishReason(choiceFinish);
    if (fr) finishReason = fr;
    const chunkUsage = (chunk as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    }).usage;
    if (chunkUsage) {
      const cached = chunkUsage.prompt_tokens_details?.cached_tokens;
      const reasoning = chunkUsage.completion_tokens_details?.reasoning_tokens;
      usage = {
        ...(chunkUsage.prompt_tokens !== undefined ? { promptTokens: chunkUsage.prompt_tokens } : {}),
        ...(chunkUsage.completion_tokens !== undefined ? { completionTokens: chunkUsage.completion_tokens } : {}),
        ...(chunkUsage.total_tokens !== undefined ? { totalTokens: chunkUsage.total_tokens } : {}),
        ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      };
    }
  }
  const normalized = normalizeUsage(usage);
  const toolCalls = finalizeOpenAIToolCalls(toolCallAcc);
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs: Date.now() - startedAt,
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

/**
 * OpenAI Responses API 路径（gpt-5* / o-series 官方推荐）。
 *
 * - P0：fetch 直调 `/v1/responses`，非流式 + 伪流式 onToken。
 * - P1：升级真流式 SSE。事件 `response.output_text.delta` → onToken 实时推；
 *   `response.completed` 一次性拿到 usage（含 cached_tokens / reasoning_tokens）。
 *   ENV `QUBIT_LLM_RESPONSES_NON_STREAM="1"` 可回退非流式（debug / 老代理兜底）。
 */
async function runOpenAIResponses(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const apiKey = input.config.apiKey || process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai provider");
  }
  const baseUrl = (input.config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  const sampling = input.sampling ?? {};
  const cap = modelCapability(input.config.model);
  const useStream = process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] !== "1";
  /**
   * Responses 入参用 `input` 数组而不是 `messages`；system 用 role:system 即可，
   * 行为与 chat.completions 等价。
   */
  const reqBody: Record<string, unknown> = {
    model: input.config.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    /** Responses API 字段名是 max_output_tokens，与 chat.completions 的 max_tokens 区分。 */
    max_output_tokens: sampling.maxOutputTokens ?? 4096,
    stream: useStream,
  };
  /** P3-3：可选 tools。Responses 用 type:'function' 风格但字段在 top-level（不是 nested function 对象）。 */
  const respTools = toResponsesTools(input.tools);
  if (respTools) {
    reqBody["tools"] = respTools;
  }
  if (cap.reasoningEffort) {
    reqBody["reasoning"] = { effort: sampling.reasoningEffort ?? "medium" };
  }
  if (cap.customTemperature && sampling.temperature !== undefined) {
    reqBody["temperature"] = sampling.temperature;
  }
  if (cap.customTopP && sampling.topP !== undefined) {
    reqBody["top_p"] = sampling.topP;
  }
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/responses`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(useStream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(reqBody),
    },
    LLM_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`OpenAI Responses request failed: ${res.status} ${await res.text()}`);
  }
  if (!useStream) {
    return await consumeResponsesNonStream(res, startedAt);
  }
  if (!res.body) {
    throw new Error("OpenAI Responses stream response has no body");
  }
  return await consumeResponsesStream(res.body, input, startedAt);
}

type ResponsesPayload = {
  id?: string;
  status?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    /** P3-3：function_call 在 output[] 里独立 item，与 message item 同级 */
    name?: string;
    arguments?: string;
    call_id?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  incomplete_details?: { reason?: string };
};

/**
 * P3-3：从 Responses API 完整 output 数组里抽 function_call items。
 * 同时兼容流式 / 非流式（两种 schema 一致）。
 */
function pickResponsesToolCalls(json: ResponsesPayload): LlmToolCallRequest[] | undefined {
  const out = json.output;
  if (!Array.isArray(out)) return undefined;
  const calls: LlmToolCallRequest[] = [];
  for (const item of out) {
    if (!item || item.type !== "function_call") continue;
    if (typeof item.name !== "string" || typeof item.call_id !== "string") continue;
    const { args, rawArgs } = parseToolArguments(item.arguments);
    calls.push({
      id: item.call_id,
      name: item.name,
      args,
      ...(rawArgs !== undefined ? { rawArgs } : {}),
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function pickResponsesUsage(json: ResponsesPayload): LlmTokenUsage | undefined {
  const rawUsage = json.usage;
  if (!rawUsage) return undefined;
  return {
    ...(rawUsage.input_tokens !== undefined ? { promptTokens: rawUsage.input_tokens } : {}),
    ...(rawUsage.output_tokens !== undefined ? { completionTokens: rawUsage.output_tokens } : {}),
    ...(rawUsage.total_tokens !== undefined ? { totalTokens: rawUsage.total_tokens } : {}),
    ...(rawUsage.input_tokens_details?.cached_tokens !== undefined
      ? { cachedPromptTokens: rawUsage.input_tokens_details.cached_tokens }
      : {}),
    ...(rawUsage.output_tokens_details?.reasoning_tokens !== undefined
      ? { reasoningTokens: rawUsage.output_tokens_details.reasoning_tokens }
      : {}),
  };
}

function pickResponsesFinishReason(json: ResponsesPayload): string | undefined {
  if (json.status === "incomplete") {
    return json.incomplete_details?.reason ?? "incomplete";
  }
  if (json.status === "completed") return "stop";
  return json.status;
}

async function consumeResponsesNonStream(
  res: Response,
  startedAt: number,
): Promise<LlmGatewayResult> {
  const json = (await res.json()) as ResponsesPayload;
  /** `output_text` 便捷字段；兜底再走 output[].content[].text 自己拼。 */
  const answer =
    json.output_text ??
    json.output
      ?.filter((part) => part.type === "message")
      .flatMap((part) => part.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("") ??
    "";
  const latencyMs = Date.now() - startedAt;
  const normalized = normalizeUsage(pickResponsesUsage(json));
  const finishReason = pickResponsesFinishReason(json);
  const toolCalls = pickResponsesToolCalls(json);
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs,
    firstTokenLatencyMs: latencyMs,
    ...(json.id ? { responseId: json.id } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

/**
 * Responses 流式事件 schema（subset）：
 *   - response.created：{ response: { id, ... } } —— 拿到 response id
 *   - response.output_text.delta：{ delta: string } —— 主 token 流
 *   - response.completed：{ response: { id, status, usage, incomplete_details } } —— 终态
 *   - response.failed / response.error / error：错误事件 → 抛错走外层熔断
 */
async function consumeResponsesStream(
  body: ReadableStream<Uint8Array>,
  input: LlmGatewayInput,
  startedAt: number,
): Promise<LlmGatewayResult> {
  let answer = "";
  let firstTokenLatencyMs: number | undefined;
  let responseId: string | undefined;
  let finishReason: string | undefined;
  let usage: LlmTokenUsage | undefined;
  /**
   * P3-3：Responses 流式 function_call 增量。事件序列：
   *   response.output_item.added (item.type=function_call) → 拿到 call_id + name
   *   response.function_call_arguments.delta (output_index, delta) → 拼 args 字符串
   *   response.function_call_arguments.done / response.completed → 收尾
   * 我们按 output_index 累积；最后用 pickResponsesToolCalls 兜底（response.completed 里
   * 通常有完整 output[]）。
   */
  const respToolAcc = new Map<number, { id?: string; name?: string; argsBuf: string }>();
  let toolCallsFromCompleted: LlmToolCallRequest[] | undefined;

  for await (const ev of readSseEvents(body)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    /** Responses 同时把 type 写在 event line 与 data.type，二者通常一致 */
    const t = (parsed["type"] as string | undefined) ?? ev.event ?? "";
    if (t === "response.created") {
      const r = parsed["response"] as Record<string, unknown> | undefined;
      if (r && typeof r["id"] === "string") responseId = r["id"] as string;
    } else if (t === "response.output_text.delta") {
      const delta = parsed["delta"];
      if (typeof delta === "string" && delta.length > 0) {
        if (firstTokenLatencyMs === undefined) {
          firstTokenLatencyMs = Date.now() - startedAt;
        }
        answer += delta;
        input.onToken(delta);
      }
    } else if (t === "response.output_item.added") {
      const item = parsed["item"] as
        | { type?: string; call_id?: string; name?: string }
        | undefined;
      const idx = typeof parsed["output_index"] === "number" ? (parsed["output_index"] as number) : 0;
      if (item && item.type === "function_call") {
        const cur = respToolAcc.get(idx) ?? { argsBuf: "" };
        if (typeof item.call_id === "string") cur.id = item.call_id;
        if (typeof item.name === "string") cur.name = item.name;
        respToolAcc.set(idx, cur);
      }
    } else if (t === "response.function_call_arguments.delta") {
      const idx = typeof parsed["output_index"] === "number" ? (parsed["output_index"] as number) : 0;
      const delta = parsed["delta"];
      if (typeof delta === "string") {
        const cur = respToolAcc.get(idx) ?? { argsBuf: "" };
        cur.argsBuf += delta;
        respToolAcc.set(idx, cur);
      }
    } else if (t === "response.completed") {
      const r = parsed["response"] as ResponsesPayload | undefined;
      if (r) {
        if (typeof r.id === "string" && !responseId) responseId = r.id;
        const u = pickResponsesUsage(r);
        if (u) usage = u;
        const fr = pickResponsesFinishReason(r);
        if (fr) finishReason = fr;
        /** response.completed 里的 output[] 已经包含完整 function_call，直接抽 */
        toolCallsFromCompleted = pickResponsesToolCalls(r);
      }
    } else if (t === "response.failed" || t === "response.error" || t === "error") {
      const err = parsed["error"] as Record<string, unknown> | undefined;
      const msg = (err?.["message"] as string | undefined) ?? "responses stream error";
      throw new Error(`OpenAI Responses stream error: ${msg}`);
    }
  }

  const latencyMs = Date.now() - startedAt;
  const normalized = normalizeUsage(usage);
  /**
   * P3-3：tool_calls 优先用 response.completed 给的完整版（args 已是终态字符串）；
   * 没有时拼增量累积器（极少数 provider 不在 completed 里塞 output[]）。
   */
  let toolCalls: LlmToolCallRequest[] | undefined = toolCallsFromCompleted;
  if (!toolCalls && respToolAcc.size > 0) {
    const sorted = [...respToolAcc.entries()].sort((a, b) => a[0] - b[0]);
    const arr: LlmToolCallRequest[] = [];
    for (const [, cur] of sorted) {
      if (!cur.id || !cur.name) continue;
      const { args, rawArgs } = parseToolArguments(cur.argsBuf);
      arr.push({
        id: cur.id,
        name: cur.name,
        args,
        ...(rawArgs !== undefined ? { rawArgs } : {}),
      });
    }
    if (arr.length > 0) toolCalls = arr;
  }
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs,
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
}

export function resolveOpenAICompatibleChatCompletionsUrl(baseUrl: string): string {
  return `${normalizeOpenAICompatibleBaseUrl(baseUrl)}/chat/completions`;
}

export function normalizeOpenAICompatibleModel(provider: string, model: string): string {
  const normalized = model.trim();
  if (provider === "zhipu") {
    return normalized.replace(/^glm(?=\d)/i, "glm-");
  }
  return normalized;
}

async function runOpenAICompatible(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const provider = input.config.provider;
  const defaults: Record<string, { envKey: string; baseUrl: string; model: string }> = {
    deepseek: {
      envKey: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
    },
    qwen: {
      envKey: "DASHSCOPE_API_KEY",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
    },
    zhipu: {
      envKey: "ZHIPU_API_KEY",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-flash",
    },
  };
  const def = defaults[provider] ?? defaults.deepseek!;
  const apiKey = input.config.apiKey || process.env[def.envKey];
  if (!apiKey) {
    throw new Error(`${def.envKey} is required for ${provider} provider`);
  }
  const configuredBaseUrl = input.config.baseUrl ?? def.baseUrl;
  const normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(configuredBaseUrl);
  const client = new OpenAI({
    apiKey,
    baseURL: normalizedBaseUrl,
  });
  const startedAt = Date.now();
  const resolvedModel = normalizeOpenAICompatibleModel(provider, input.config.model || def.model);
  const sampling = input.sampling ?? {};
  const temperature = sampling.temperature ?? 0.1;
  /**
   * deepseek/qwen/zhipu 等 OpenAI-compatible 提供商目前都接受 temperature；
   * 但有用户把 baseURL 指到 litellm/azure 这类代理 → 后端可能接的是
   * gpt-5 / o3 推理模型。同样走 sanitize 兜底。
   */
  const oaiCompatTools = toOpenAITools(input.tools);
  const requestBody = sanitizeChatCompletionsBody(resolvedModel, {
    model: resolvedModel,
    messages: [
      { role: "system" as const, content: input.systemPrompt },
      { role: "user" as const, content: input.userPrompt },
    ],
    temperature,
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling.maxOutputTokens !== undefined ? { max_tokens: sampling.maxOutputTokens } : {}),
    /** P3-3：DeepSeek-Chat / Qwen / Zhipu 都接受 OpenAI tools schema（DeepSeek-R1 不接，模型选时承担）。 */
    ...(oaiCompatTools ? { tools: oaiCompatTools } : {}),
    stream: true as const,
    stream_options: { include_usage: true },
  });
  if (process.env["QUBIT_LLM_COMPAT_STREAM"] !== "1") {
    return runOpenAICompatibleNonStream(input, {
      baseUrl: normalizedBaseUrl,
      apiKey,
      requestBody,
      resolvedModel,
      startedAt,
    });
  }
  const stream = await client.chat.completions.create(requestBody);
  let answer = "";
  let usage: LlmTokenUsage | undefined;
  let firstTokenLatencyMs: number | undefined;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  const compatToolCallAcc: ToolCallAccumulator = new Map();
  /**
   * P2：DeepSeek-R1 / deepseek-reasoner 在 chat.completions 流里把推理过程放在
   * `delta.reasoning_content`（不是 `delta.content`）。我们刻意**不**把这部分推到
   * onToken / answer：
   *   1) 它是模型的内部独白，不该污染最终输出 / 前端 UI / 下游 schema 校验；
   *   2) 上游 DeepSeek 不暴露 `reasoning_tokens`，需要自己按字符估算（≈chars/4）。
   * 累积长度后，如果 chunkUsage 没给 reasoning_tokens，再用估算值兜底填到
   * usage.reasoningTokens，让监控能看到 reasoning ratio。
   */
  let reasoningContentChars = 0;
  for await (const chunk of stream) {
    if (!responseId && typeof (chunk as { id?: string }).id === "string") {
      responseId = (chunk as { id: string }).id;
    }
    const delta = chunk.choices[0]?.delta as
      | { content?: string; reasoning_content?: string; tool_calls?: unknown }
      | undefined;
    const token = delta?.content ?? "";
    if (token) {
      if (firstTokenLatencyMs === undefined) {
        firstTokenLatencyMs = Date.now() - startedAt;
      }
      answer += token;
      input.onToken(token);
    }
    if (delta && Array.isArray(delta.tool_calls)) {
      accumulateOpenAIToolCallDelta(compatToolCallAcc, delta.tool_calls);
    }
    const reasoningDelta = delta?.reasoning_content;
    if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
      reasoningContentChars += reasoningDelta.length;
    }
    const fr = pickFinishReason(chunk.choices[0]?.finish_reason);
    if (fr) finishReason = fr;
    const chunkUsage = (chunk as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    }).usage;
    if (chunkUsage) {
      const cached = chunkUsage.prompt_tokens_details?.cached_tokens;
      const reasoning = chunkUsage.completion_tokens_details?.reasoning_tokens;
      usage = {
        ...(chunkUsage.prompt_tokens !== undefined ? { promptTokens: chunkUsage.prompt_tokens } : {}),
        ...(chunkUsage.completion_tokens !== undefined ? { completionTokens: chunkUsage.completion_tokens } : {}),
        ...(chunkUsage.total_tokens !== undefined ? { totalTokens: chunkUsage.total_tokens } : {}),
        ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      };
    }
  }
  /**
   * 上游没给 reasoning_tokens 但确实输出了 reasoning_content 时，按 chars/4 粗估。
   * 详见 estimateReasoningTokensFromChars。
   */
  if (reasoningContentChars > 0 && (!usage || usage.reasoningTokens === undefined)) {
    const estimated = estimateReasoningTokensFromChars(reasoningContentChars);
    if (estimated > 0) {
      usage = { ...(usage ?? {}), reasoningTokens: estimated };
    }
  }
  const normalized = normalizeUsage(usage);
  const toolCalls = finalizeOpenAIToolCalls(compatToolCallAcc);
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs: Date.now() - startedAt,
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

async function runOpenAICompatibleNonStream(
  input: LlmGatewayInput,
  resolved: {
    baseUrl: string;
    apiKey: string;
    requestBody: Record<string, unknown>;
    resolvedModel: string;
    startedAt: number;
  }
): Promise<LlmGatewayResult> {
  const body = {
    ...resolved.requestBody,
    stream: false,
  };
  delete (body as Record<string, unknown>)["stream_options"];
  const res = await fetchWithTimeout(
    resolveOpenAICompatibleChatCompletionsUrl(resolved.baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    LLM_FETCH_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error(`OpenAI-compatible request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    id?: string;
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const choice = json.choices?.[0];
  const answer = choice?.message?.content ?? "";
  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  const toolCalls = choice?.message?.tool_calls
    ?.map((call) => {
      const parsed = parseToolArguments(call.function?.arguments);
      return call.id && call.function?.name
        ? {
            id: call.id,
            name: call.function.name,
            args: parsed.args,
            ...(parsed.rawArgs !== undefined ? { rawArgs: parsed.rawArgs } : {}),
          }
        : null;
    })
    .filter((call): call is LlmToolCallRequest => Boolean(call));
  const cached = json.usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens;
  const usage: LlmTokenUsage | undefined = json.usage
    ? {
        ...(json.usage.prompt_tokens !== undefined ? { promptTokens: json.usage.prompt_tokens } : {}),
        ...(json.usage.completion_tokens !== undefined
          ? { completionTokens: json.usage.completion_tokens }
          : {}),
        ...(json.usage.total_tokens !== undefined ? { totalTokens: json.usage.total_tokens } : {}),
        ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      }
    : undefined;
  const latencyMs = Date.now() - resolved.startedAt;
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs,
    firstTokenLatencyMs: latencyMs,
    ...(json.id ? { responseId: json.id } : {}),
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/**
 * P1：Anthropic Messages 真流式 SSE 实现。
 *
 * 事件 schema（subset）：
 *   - message_start：{ message: { id, usage: { input_tokens, cache_read_input_tokens, output_tokens } } }
 *   - content_block_delta：{ delta: { type: 'text_delta', text } } —— 主 token 流
 *   - message_delta：{ delta: { stop_reason }, usage: { output_tokens } } —— 终止 + 出量更新
 *   - message_stop：流末尾标记
 *
 * 兼容兜底：如果 ENV `QUBIT_LLM_ANTHROPIC_NON_STREAM="1"`，回退到非流式（debug
 * 用，例如某代理不支持 stream）。
 */
/**
 * Anthropic prompt-caching 启用判定（P3-1，opt-in）：
 *
 * 触发条件**任一满足**即开启：
 *   1) ENV `QUBIT_LLM_ANTHROPIC_PROMPT_CACHE` 显式设为 `"1"`；
 *   2) systemPrompt 长度 ≥ ENV `QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS`（默认 4096
 *      ≈ 1k token，低于此长度上行 cache write 1.25× 不划算）。
 *
 * 启用后会做两件事：
 *   - HTTP header 加 `anthropic-beta: prompt-caching-2024-07-31`；
 *   - request body 把 `system` 字段从 string 改成 array：
 *       [{ type: 'text', text: <prompt>, cache_control: { type: 'ephemeral' } }]
 *     这是 Anthropic 标记 cache 边界的 schema —— 同一 hash 的 system block 在 5
 *     分钟 TTL 内复用 → cache_read 命中（10% 输入价）。
 *
 * 关闭：不传 ENV / 短 prompt → 与 P0/P1/P2 行为完全一致。
 */
function shouldEnableAnthropicPromptCache(systemPrompt: string): boolean {
  if (process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"] === "1") return true;
  const raw = process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS"];
  if (raw && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && systemPrompt.length >= n) return true;
  }
  return false;
}

async function runAnthropic(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const apiKey = input.config.apiKey || process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for anthropic provider");
  }
  const baseUrl = input.config.baseUrl ?? "https://api.anthropic.com";
  const sampling = input.sampling ?? {};
  /**
   * Claude 3.5/4 系列在新版 API（messages-2023-06-01）下 max_tokens 上限：
   *   - claude-3-5-sonnet / claude-3-5-haiku：8192
   *   - claude-3-opus：4096
   *
   * 旧网关默认 1024 经常被截断；这里默认拉到 4096。
   */
  const maxTokens = sampling.maxOutputTokens ?? 4096;
  const temperature = sampling.temperature ?? 0.1;
  const useStream = process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] !== "1";
  const useCaching = shouldEnableAnthropicPromptCache(input.systemPrompt);
  /**
   * caching 启用时 system 必须是带 cache_control 的 block 数组；不启用走老的
   * string 字段，保持 schema 100% 兼容。
   */
  const systemField: unknown = useCaching
    ? [
        {
          type: "text",
          text: input.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ]
    : input.systemPrompt;
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(useCaching ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
        ...(useStream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        model: input.config.model || "claude-3-5-sonnet-latest",
        max_tokens: maxTokens,
        temperature,
        ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
        system: systemField,
        messages: [{ role: "user", content: input.userPrompt }],
        /** P3-3：可选 tools（Anthropic 字段 input_schema 与 OpenAI 不同） */
        ...(toAnthropicTools(input.tools) ? { tools: toAnthropicTools(input.tools) } : {}),
        ...(useStream ? { stream: true } : {}),
      }),
    },
    LLM_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  }

  if (!useStream) {
    return await consumeAnthropicNonStream(res, startedAt);
  }
  if (!res.body) {
    throw new Error("Anthropic stream response has no body");
  }
  return await consumeAnthropicStream(res.body, input, startedAt);
}

async function consumeAnthropicNonStream(
  res: Response,
  startedAt: number,
): Promise<LlmGatewayResult> {
  const json = (await res.json()) as {
    id?: string;
    content?: Array<{
      type: string;
      text?: string;
      /** P3-3：tool_use block schema */
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    stop_reason?: string;
  };
  const answer =
    json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
  /** P3-3：抽 tool_use blocks → LlmToolCallRequest[] */
  const toolCalls: LlmToolCallRequest[] | undefined = (() => {
    const blocks = json.content?.filter((c) => c.type === "tool_use") ?? [];
    if (blocks.length === 0) return undefined;
    const arr: LlmToolCallRequest[] = [];
    for (const b of blocks) {
      if (typeof b.id !== "string" || typeof b.name !== "string") continue;
      const { args, rawArgs } = parseToolArguments(b.input);
      arr.push({
        id: b.id,
        name: b.name,
        args,
        ...(rawArgs !== undefined ? { rawArgs } : {}),
      });
    }
    return arr.length > 0 ? arr : undefined;
  })();
  const rawUsage = json.usage;
  const usage: LlmTokenUsage | undefined = rawUsage
    ? {
        ...(rawUsage.input_tokens !== undefined ? { promptTokens: rawUsage.input_tokens } : {}),
        ...(rawUsage.output_tokens !== undefined ? { completionTokens: rawUsage.output_tokens } : {}),
        ...(rawUsage.cache_read_input_tokens !== undefined
          ? { cachedPromptTokens: rawUsage.cache_read_input_tokens }
          : {}),
        ...(rawUsage.cache_creation_input_tokens !== undefined
          ? { cacheCreationInputTokens: rawUsage.cache_creation_input_tokens }
          : {}),
      }
    : undefined;
  const latencyMs = Date.now() - startedAt;
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs,
    firstTokenLatencyMs: latencyMs,
    ...(json.id ? { responseId: json.id } : {}),
    ...(json.stop_reason ? { finishReason: json.stop_reason } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  input: LlmGatewayInput,
  startedAt: number,
): Promise<LlmGatewayResult> {
  let answer = "";
  let firstTokenLatencyMs: number | undefined;
  let responseId: string | undefined;
  let finishReason: string | undefined;
  /**
   * Anthropic 把 input_tokens 在 message_start 给一次（含 cache_read），
   * output_tokens 在 message_delta 累计更新；最终 message_stop 时是终值。
   */
  let promptTokens: number | undefined;
  let cachedPromptTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let outputTokens: number | undefined;
  /**
   * P3-3：tool_use 增量。Anthropic 流式 tool_use schema：
   *   content_block_start: { index, content_block: { type:'tool_use', id, name, input:{} } }
   *   content_block_delta: { index, delta: { type:'input_json_delta', partial_json:'...' } }
   *   content_block_stop:  { index }
   * 我们按 index 累积；最终 partial_json 拼成完整 JSON 再 parse。
   */
  const anthToolAcc = new Map<number, { id: string; name: string; argsBuf: string }>();

  for await (const ev of readSseEvents(body)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const t = (parsed["type"] as string | undefined) ?? ev.event;
    switch (t) {
      case "message_start": {
        const msg = parsed["message"] as Record<string, unknown> | undefined;
        if (msg) {
          if (typeof msg["id"] === "string") responseId = msg["id"] as string;
          const u = msg["usage"] as Record<string, unknown> | undefined;
          if (u) {
            if (typeof u["input_tokens"] === "number") promptTokens = u["input_tokens"];
            if (typeof u["cache_read_input_tokens"] === "number") {
              cachedPromptTokens = u["cache_read_input_tokens"];
            }
            if (typeof u["cache_creation_input_tokens"] === "number") {
              cacheCreationInputTokens = u["cache_creation_input_tokens"];
            }
            if (typeof u["output_tokens"] === "number") outputTokens = u["output_tokens"];
          }
        }
        break;
      }
      case "content_block_start": {
        const block = parsed["content_block"] as Record<string, unknown> | undefined;
        const idx =
          typeof parsed["index"] === "number" ? (parsed["index"] as number) : 0;
        if (
          block &&
          block["type"] === "tool_use" &&
          typeof block["id"] === "string" &&
          typeof block["name"] === "string"
        ) {
          anthToolAcc.set(idx, {
            id: block["id"] as string,
            name: block["name"] as string,
            argsBuf: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = parsed["delta"] as Record<string, unknown> | undefined;
        if (delta && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          const token = delta["text"] as string;
          if (token) {
            if (firstTokenLatencyMs === undefined) {
              firstTokenLatencyMs = Date.now() - startedAt;
            }
            answer += token;
            input.onToken(token);
          }
        } else if (
          delta &&
          delta["type"] === "input_json_delta" &&
          typeof delta["partial_json"] === "string"
        ) {
          const idx =
            typeof parsed["index"] === "number" ? (parsed["index"] as number) : 0;
          const cur = anthToolAcc.get(idx);
          if (cur) cur.argsBuf += delta["partial_json"] as string;
        }
        break;
      }
      case "message_delta": {
        const delta = parsed["delta"] as Record<string, unknown> | undefined;
        if (delta && typeof delta["stop_reason"] === "string") {
          finishReason = delta["stop_reason"] as string;
        }
        const u = parsed["usage"] as Record<string, unknown> | undefined;
        if (u && typeof u["output_tokens"] === "number") {
          outputTokens = u["output_tokens"];
        }
        break;
      }
      case "message_stop":
        break;
      default:
        break;
    }
  }

  const usage: LlmTokenUsage | undefined =
    promptTokens !== undefined || outputTokens !== undefined
      ? {
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(outputTokens !== undefined ? { completionTokens: outputTokens } : {}),
          ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
          ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
        }
      : undefined;
  const normalized = normalizeUsage(usage);
  /** P3-3：把累积的 tool_use 拼成 LlmToolCallRequest[] */
  const toolCalls: LlmToolCallRequest[] | undefined = (() => {
    if (anthToolAcc.size === 0) return undefined;
    const sorted = [...anthToolAcc.entries()].sort((a, b) => a[0] - b[0]);
    const arr: LlmToolCallRequest[] = [];
    for (const [, cur] of sorted) {
      const { args, rawArgs } = parseToolArguments(cur.argsBuf);
      arr.push({
        id: cur.id,
        name: cur.name,
        args,
        ...(rawArgs !== undefined ? { rawArgs } : {}),
      });
    }
    return arr.length > 0 ? arr : undefined;
  })();
  const latencyMs = Date.now() - startedAt;
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs,
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

async function runOllama(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const baseUrl = input.config.baseUrl ?? "http://127.0.0.1:11434";
  const sampling = input.sampling ?? {};
  /**
   * Ollama 的采样参数走 `options` 字段（与 OpenAI 字段名不同）。
   * 只在调用方显式给出时下发，避免改变默认行为。
   */
  const options: Record<string, unknown> = {};
  if (sampling.temperature !== undefined) options.temperature = sampling.temperature;
  if (sampling.topP !== undefined) options.top_p = sampling.topP;
  if (sampling.maxOutputTokens !== undefined) options.num_predict = sampling.maxOutputTokens;
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    `${baseUrl}/api/chat`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.config.model || "llama3.1",
        stream: false,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
        ...(Object.keys(options).length ? { options } : {}),
      }),
    },
    LLM_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    message?: { content?: string };
    response?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    done_reason?: string;
  };
  const answer = json.message?.content ?? json.response ?? "";
  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  const usage: LlmTokenUsage | undefined =
    json.prompt_eval_count !== undefined || json.eval_count !== undefined
      ? {
          ...(json.prompt_eval_count !== undefined ? { promptTokens: json.prompt_eval_count } : {}),
          ...(json.eval_count !== undefined ? { completionTokens: json.eval_count } : {}),
        }
      : undefined;
  const latencyMs = Date.now() - startedAt;
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs,
    firstTokenLatencyMs: latencyMs,
    ...(json.done_reason ? { finishReason: json.done_reason } : {}),
  };
}

function runMock(input: LlmGatewayInput): LlmGatewayResult {
  const startedAt = Date.now();
  const goalMatch = input.userPrompt.match(/\*\*任务目标\*\*：(.*)/);
  const goal = goalMatch?.[1]?.trim().slice(0, 80) ?? input.userPrompt.slice(0, 60);

  const answer = [
    `【Mock 模式】收到任务：「${goal}」`,
    ``,
    `当前 LLM 提供商为 mock，未调用真实 AI 模型。`,
    `请在「配置中心 → 模型配置」中填写真实 API Key（支持 OpenAI / DeepSeek / Qwen 等），`,
    `保存后重新发送消息即可获得真实 AI 回复。`,
  ].join("\n");

  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  const promptTokens = estimateTokens(`${input.systemPrompt}\n${input.userPrompt}`);
  const completionTokens = estimateTokens(answer);
  return {
    answer,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    latencyMs: Date.now() - startedAt,
  };
}

export async function runLlmGateway(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const provider = input.config.provider;
  return executeWithPolicy(
    {
      scopeKey: `llm:${provider}:${input.config.model}`,
      // 流式输出场景默认不重试，避免 token 重复写入前端流。
      retry: { maxAttempts: 1, backoffMs: 200, backoffMultiplier: 2 },
      circuitBreaker: { failureThreshold: 4, cooldownMs: 20_000 },
    },
    async () => {
      if (provider === "openai") return runOpenAI(input);
      if (provider === "anthropic") return runAnthropic(input);
      if (provider === "ollama") return runOllama(input);
      if (provider === "deepseek" || provider === "qwen" || provider === "zhipu") {
        return runOpenAICompatible(input);
      }
      return runMock(input);
    }
  );
}
