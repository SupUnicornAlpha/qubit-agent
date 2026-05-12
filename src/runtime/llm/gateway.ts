import OpenAI from "openai";
import type { RuntimeModelConfig } from "../config/model-config";
import { executeWithPolicy } from "../external-call/policy";

export interface LlmGatewayInput {
  config: RuntimeModelConfig;
  systemPrompt: string;
  userPrompt: string;
  onToken: (token: string) => void;
}

function splitForPseudoStreaming(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

async function runOpenAI(input: LlmGatewayInput): Promise<string> {
  const apiKey = input.config.apiKey || process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for openai provider");
  }
  const client = new OpenAI({ apiKey, baseURL: input.config.baseUrl });
  const stream = await client.chat.completions.create({
    model: input.config.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    temperature: 0.1,
    stream: true,
  });
  let answer = "";
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content ?? "";
    if (!token) continue;
    answer += token;
    input.onToken(token);
  }
  return answer;
}

async function runOpenAICompatible(input: LlmGatewayInput): Promise<string> {
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
  const stream = await client.chat.completions.create({
    model: input.config.model || def.model,
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPrompt },
    ],
    temperature: 0.1,
    stream: true,
  });
  let answer = "";
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content ?? "";
    if (!token) continue;
    answer += token;
    input.onToken(token);
  }
  return answer;
}

async function runAnthropic(input: LlmGatewayInput): Promise<string> {
  const apiKey = input.config.apiKey || process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for anthropic provider");
  }
  const baseUrl = input.config.baseUrl ?? "https://api.anthropic.com";
  const res = await fetch(`${baseUrl}/v1/messages`, {
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
  });
  if (!res.ok) {
    throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const answer =
    json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  return answer;
}

async function runOllama(input: LlmGatewayInput): Promise<string> {
  const baseUrl = input.config.baseUrl ?? "http://127.0.0.1:11434";
  const res = await fetch(`${baseUrl}/api/chat`, {
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
  });
  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    message?: { content?: string };
    response?: string;
  };
  const answer = json.message?.content ?? json.response ?? "";
  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  return answer;
}

function runMock(input: LlmGatewayInput): string {
  // Extract goal/task from userPrompt for a more helpful placeholder response.
  const goalMatch = input.userPrompt.match(/\*\*任务目标\*\*：(.*)/);
  const goal = goalMatch?.[1]?.trim().slice(0, 80) ?? input.userPrompt.slice(0, 60);

  const answer = [
    `【Mock 模式】收到任务：「${goal}」`,
    ``,
    `当前 LLM 提供商为 mock，未调用真实 AI 模型。`,
    `请在「配置中心 → 模型配置」中填写真实 API Key（支持 OpenAI / DeepSeek / Qwen 等），`,
    `保存后重新发送消息即可获得真实 AI 回复。`,
    ``,
    `计划执行：task_decompose`,
  ].join("\n");

  for (const token of splitForPseudoStreaming(answer)) {
    input.onToken(token);
  }
  return answer;
}

export async function runLlmGateway(input: LlmGatewayInput): Promise<string> {
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

