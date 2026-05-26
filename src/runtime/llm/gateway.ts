import OpenAI from "openai";
import type { RuntimeModelConfig } from "../config/model-config";
import { executeWithPolicy } from "../external-call/policy";
import { fetchWithTimeout, LLM_FETCH_TIMEOUT_MS } from "../../util/fetch-with-timeout";

export interface LlmGatewayInput {
  config: RuntimeModelConfig;
  systemPrompt: string;
  userPrompt: string;
  onToken: (token: string) => void;
}

export interface LlmTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmGatewayResult {
  answer: string;
  /** Token consumption reported by provider (when available). */
  usage?: LlmTokenUsage;
  /** Wall-clock latency of the LLM call, measured at gateway boundary. */
  latencyMs: number;
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
  const { promptTokens, completionTokens, totalTokens } = usage;
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
  };
}

async function runOpenAI(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const apiKey = input.config.apiKey || process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai provider");
  }
  const client = new OpenAI({ apiKey, baseURL: input.config.baseUrl });
  const startedAt = Date.now();
  const stream = await client.chat.completions.create({
    model: input.config.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    temperature: 0.1,
    stream: true,
    stream_options: { include_usage: true },
  });
  let answer = "";
  let usage: LlmTokenUsage | undefined;
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content ?? "";
    if (token) {
      answer += token;
      input.onToken(token);
    }
    const chunkUsage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
    if (chunkUsage) {
      usage = {
        ...(chunkUsage.prompt_tokens !== undefined ? { promptTokens: chunkUsage.prompt_tokens } : {}),
        ...(chunkUsage.completion_tokens !== undefined ? { completionTokens: chunkUsage.completion_tokens } : {}),
        ...(chunkUsage.total_tokens !== undefined ? { totalTokens: chunkUsage.total_tokens } : {}),
      };
    }
  }
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs: Date.now() - startedAt,
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
  const stream = await client.chat.completions.create({
    model: input.config.model || def.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    temperature: 0.1,
    stream: true,
    stream_options: { include_usage: true },
  });
  let answer = "";
  let usage: LlmTokenUsage | undefined;
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content ?? "";
    if (token) {
      answer += token;
      input.onToken(token);
    }
    const chunkUsage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
    if (chunkUsage) {
      usage = {
        ...(chunkUsage.prompt_tokens !== undefined ? { promptTokens: chunkUsage.prompt_tokens } : {}),
        ...(chunkUsage.completion_tokens !== undefined ? { completionTokens: chunkUsage.completion_tokens } : {}),
        ...(chunkUsage.total_tokens !== undefined ? { totalTokens: chunkUsage.total_tokens } : {}),
      };
    }
  }
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs: Date.now() - startedAt,
  };
}

async function runAnthropic(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const apiKey = input.config.apiKey || process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for anthropic provider");
  }
  const baseUrl = input.config.baseUrl ?? "https://api.anthropic.com";
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
        max_tokens: 1024,
        temperature: 0.1,
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
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
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
      }
    : undefined;
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs: Date.now() - startedAt,
  };
}

async function runOllama(input: LlmGatewayInput): Promise<LlmGatewayResult> {
  const baseUrl = input.config.baseUrl ?? "http://127.0.0.1:11434";
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
  return {
    answer,
    ...(normalizeUsage(usage) ? { usage: normalizeUsage(usage)! } : {}),
    latencyMs: Date.now() - startedAt,
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
