import OpenAI from "openai";
import type { RuntimeModelConfig } from "../config/model-config";
import { executeWithPolicy } from "../external-call/policy";
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from "../../util/fetch-with-timeout";
import { modelCapability, sanitizeChatCompletionsBody } from "./model-capabilities";

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

export interface LlmGatewayInput {
  config: RuntimeModelConfig;
  systemPrompt: string;
  userPrompt: string;
  onToken: (token: string) => void;
  /** P0-3：调用方自定义采样参数；不传走默认值。 */
  sampling?: LlmSamplingOverrides;
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /**
   * Responses API（gpt-5 / o-series）专属：被 OpenAI 服务端缓存的 prompt
   * token 数。命中缓存的部分按更低费率计价（约 1/4 standard 输入价）。
   * 其它路径（chat.completions / Anthropic / Ollama）不会有此字段。
   */
  cachedPromptTokens?: number;
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
}

function splitForPseudoStreaming(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
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
  const { promptTokens, completionTokens, totalTokens, cachedPromptTokens, reasoningTokens } = usage;
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
  const requestBody = sanitizeChatCompletionsBody(input.config.model, {
    model: input.config.model,
    messages: [
      { role: "system" as const, content: input.systemPrompt },
      { role: "user" as const, content: input.userPrompt },
    ],
    temperature,
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling.maxOutputTokens !== undefined ? { max_tokens: sampling.maxOutputTokens } : {}),
    stream: true as const,
    stream_options: { include_usage: true },
  });
  const stream = await client.chat.completions.create(requestBody);
  let answer = "";
  let usage: LlmTokenUsage | undefined;
  let firstTokenLatencyMs: number | undefined;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  for await (const chunk of stream) {
    if (!responseId && typeof (chunk as { id?: string }).id === "string") {
      responseId = (chunk as { id: string }).id;
    }
    const token = chunk.choices[0]?.delta?.content ?? "";
    if (token) {
      if (firstTokenLatencyMs === undefined) {
        firstTokenLatencyMs = Date.now() - startedAt;
      }
      answer += token;
      input.onToken(token);
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
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs: Date.now() - startedAt,
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}

/**
 * P0-1：OpenAI Responses API 路径（gpt-5* / o-series 官方推荐）。
 *
 * 实现策略（最小耦合）：
 *   - 不依赖 OpenAI SDK 的 `client.responses` 子模块（不同 SDK 版本签名差异大）；
 *     直接用项目内已有的 `fetchWithTimeout` 调 `/v1/responses` REST。
 *   - 暂走非流式：网关层用伪流式把整段答案 split 成 token 推给 onToken，与
 *     `runAnthropic` / `runOllama` 行为一致，先解决"能不能用"再优化"流式体验"。
 *   - usage 解析覆盖 cached_tokens / reasoning_tokens（Responses API 才暴露这两个）。
 *
 * 后续可在 P1/P2：换成真正的 SSE streaming（事件名 `response.output_text.delta`），
 * 把 firstTokenLatencyMs 升级成"首 delta"语义。
 */
async function runOpenAIResponses(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const apiKey = input.config.apiKey || process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai provider");
  }
  const baseUrl = (input.config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  const sampling = input.sampling ?? {};
  const cap = modelCapability(input.config.model);
  /**
   * Responses 入参用 `input` 数组而不是 `messages`；system 用 role:'system' 即可，
   * SDK 行为与 chat.completions 等价。
   */
  const reqBody: Record<string, unknown> = {
    model: input.config.model,
    input: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    /** Responses API 字段名是 max_output_tokens，与 chat.completions 的 max_tokens 区分。 */
    max_output_tokens: sampling.maxOutputTokens ?? 4096,
    /** stream 暂不开，先保证非流式通路稳定。开关留给后续升级。 */
    stream: false,
  };
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
      },
      body: JSON.stringify(reqBody),
    },
    LLM_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`OpenAI Responses request failed: ${res.status} ${await res.text()}`);
  }
  type ResponsesPayload = {
    id?: string;
    status?: string;
    output_text?: string;
    output?: Array<{
      type?: string;
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
  const json = (await res.json()) as ResponsesPayload;
  /**
   * Responses API 提供 `output_text` 便捷字段（拼接所有 message.text）；
   * 兜底再走 output[].content[].text 自己拼。
   */
  const answer =
    json.output_text ??
    json.output
      ?.filter((part) => part.type === "message")
      .flatMap((part) => part.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("") ??
    "";
  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  const rawUsage = json.usage;
  const usage: LlmTokenUsage | undefined = rawUsage
    ? {
        ...(rawUsage.input_tokens !== undefined ? { promptTokens: rawUsage.input_tokens } : {}),
        ...(rawUsage.output_tokens !== undefined ? { completionTokens: rawUsage.output_tokens } : {}),
        ...(rawUsage.total_tokens !== undefined ? { totalTokens: rawUsage.total_tokens } : {}),
        ...(rawUsage.input_tokens_details?.cached_tokens !== undefined
          ? { cachedPromptTokens: rawUsage.input_tokens_details.cached_tokens }
          : {}),
        ...(rawUsage.output_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningTokens: rawUsage.output_tokens_details.reasoning_tokens }
          : {}),
      }
    : undefined;
  /**
   * Responses 没有 finish_reason 字段；status='incomplete' 时 incomplete_details.reason
   * 给出原因（'max_output_tokens' / 'content_filter' 等），其它正常完成统一报 'stop'。
   */
  const finishReason: string | undefined =
    json.status === "incomplete"
      ? (json.incomplete_details?.reason ?? "incomplete")
      : json.status === "completed"
        ? "stop"
        : json.status;
  const latencyMs = Date.now() - startedAt;
  const normalized = normalizeUsage(usage);
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs,
    /** 非流式：firstTokenLatency == 整段 latency。stream 升级后改成"首 delta"。 */
    firstTokenLatencyMs: latencyMs,
    ...(json.id ? { responseId: json.id } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
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
  const def = defaults[provider] ?? defaults.deepseek;
  const apiKey = input.config.apiKey || process.env[def.envKey];
  if (!apiKey) {
    throw new Error(`${def.envKey} is required for ${provider} provider`);
  }
  const client = new OpenAI({
    apiKey,
    baseURL: input.config.baseUrl ?? def.baseUrl,
  });
  const startedAt = Date.now();
  const resolvedModel = input.config.model || def.model;
  const sampling = input.sampling ?? {};
  const temperature = sampling.temperature ?? 0.1;
  /**
   * deepseek/qwen/zhipu 等 OpenAI-compatible 提供商目前都接受 temperature；
   * 但有用户把 baseURL 指到 litellm/azure 这类代理 → 后端可能接的是
   * gpt-5 / o3 推理模型。同样走 sanitize 兜底。
   */
  const requestBody = sanitizeChatCompletionsBody(resolvedModel, {
    model: resolvedModel,
    messages: [
      { role: "system" as const, content: input.systemPrompt },
      { role: "user" as const, content: input.userPrompt },
    ],
    temperature,
    ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling.maxOutputTokens !== undefined ? { max_tokens: sampling.maxOutputTokens } : {}),
    stream: true as const,
    stream_options: { include_usage: true },
  });
  const stream = await client.chat.completions.create(requestBody);
  let answer = "";
  let usage: LlmTokenUsage | undefined;
  let firstTokenLatencyMs: number | undefined;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  for await (const chunk of stream) {
    if (!responseId && typeof (chunk as { id?: string }).id === "string") {
      responseId = (chunk as { id: string }).id;
    }
    const token = chunk.choices[0]?.delta?.content ?? "";
    if (token) {
      if (firstTokenLatencyMs === undefined) {
        firstTokenLatencyMs = Date.now() - startedAt;
      }
      answer += token;
      input.onToken(token);
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
  const normalized = normalizeUsage(usage);
  return {
    answer,
    ...(normalized ? { usage: normalized } : {}),
    latencyMs: Date.now() - startedAt,
    ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
    ...(responseId ? { responseId } : {}),
    ...(finishReason ? { finishReason } : {}),
  };
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
   *   - claude-3-5-sonnet：8192
   *   - claude-3-5-haiku：8192
   *   - claude-3-opus：4096
   *
   * 旧网关默认 1024 经常被截断（user-prompt 短的研究任务都会报 "max_tokens"），
   * 这里默认拉到 4096，给出空间。caller 想要更长输出可通过 sampling.maxOutputTokens 覆写。
   */
  const maxTokens = sampling.maxOutputTokens ?? 4096;
  const temperature = sampling.temperature ?? 0.1;
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: input.config.model || "claude-3-5-sonnet-latest",
        max_tokens: maxTokens,
        temperature,
        ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt }],
      }),
    },
    LLM_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    id?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    stop_reason?: string;
  };
  const answer =
    json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  const rawUsage = json.usage;
  const usage: LlmTokenUsage | undefined = rawUsage
    ? {
        ...(rawUsage.input_tokens !== undefined ? { promptTokens: rawUsage.input_tokens } : {}),
        ...(rawUsage.output_tokens !== undefined ? { completionTokens: rawUsage.output_tokens } : {}),
        ...(rawUsage.cache_read_input_tokens !== undefined
          ? { cachedPromptTokens: rawUsage.cache_read_input_tokens }
          : {}),
      }
    : undefined;
  const latencyMs = Date.now() - startedAt;
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs,
    /** 非流式：firstTokenLatency == 整段 latency。 */
    firstTokenLatencyMs: latencyMs,
    ...(json.id ? { responseId: json.id } : {}),
    ...(json.stop_reason ? { finishReason: json.stop_reason } : {}),
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
