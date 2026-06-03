/**
 * 各模型对 OpenAI Chat Completions 请求体字段的能力差异。
 *
 * 为什么需要？
 *   OpenAI 的「推理类」模型族（o1 / o3 / o4 / gpt-5* 等）对采样参数做了硬性
 *   限制：temperature 只能用默认 1、top_p 也是 1、不接受 frequency_penalty /
 *   presence_penalty。一旦传 0.1 这种自定义值就直接 400：
 *
 *     400 litellm.BadRequestError: OpenAIException -
 *       Unsupported value: 'temperature' does not support 0.1 with this model.
 *       Only the default (1) value is supported.
 *
 *   3 次 retry 后熔断器打开 → 整个 workflow 挂掉。我们网关层之前对所有 openai
 *   调用都硬编码 `temperature: 0.1`（gateway.ts），新模型一上来就废。
 *
 * 解决方案：发请求前按模型族裁掉受限字段。passthrough 模型（gpt-4o / gpt-4o-mini /
 * gpt-3.5 等老一代）行为完全不变。litellm 代理也复用同一份能力表，因为底层
 * 错误是 OpenAI 校验器抛的、与代理无关。
 *
 * 参考：
 *   - OpenAI o1 docs: temperature 必须 = 1
 *   - OpenAI gpt-5 系列与上同步
 *   - litellm 把 BadRequestError 透传，不做额外参数清理
 */

/**
 * 模型名前缀 → 该族支持哪些采样字段。
 *
 * - `null` 字段：必须从请求体中删除（否则 400）。
 * - 字段不在表里：默认允许传（passthrough）。
 *
 * 命中规则：模型名小写后 startsWith(prefix)。
 *
 * 注意：列表保守扩展，遇到新模型族时优先看 OpenAI / Azure 公告再加。
 */
export interface ModelCapabilityProfile {
  /** 是否允许 temperature ≠ 1（推理模型为 false） */
  customTemperature: boolean;
  /** 是否允许 top_p ≠ 1 */
  customTopP: boolean;
  /** 是否接受 frequency_penalty / presence_penalty */
  penalties: boolean;
  /**
   * 推荐走的 OpenAI 端点：
   *
   * - `"chat"`（默认）：传统 `/v1/chat/completions`，所有 gpt-4o / gpt-3.5 系列
   *   及 OpenAI-compatible 第三方（deepseek/qwen/zhipu）都用这个。
   * - `"responses"`：新一代 `/v1/responses`，OpenAI 官方推荐 o-series 与 gpt-5*
   *   使用，能拿到 `reasoning_tokens` / `cached_input_tokens` 等附加 usage 字段。
   *
   * 网关只在 provider === 'openai' 时使用本字段做路由；OpenAI-compatible
   * 第三方代理大多不支持 /v1/responses，强制走 chat.completions。
   */
  apiPath: "chat" | "responses";
  /**
   * 是否支持 `reasoning.effort` 参数（responses API 才有）。`reasoning` 是
   * o-series / gpt-5 暴露给调用方的 'low/medium/high' 推理预算开关。
   */
  reasoningEffort: boolean;
}

const FULL: ModelCapabilityProfile = {
  customTemperature: true,
  customTopP: true,
  penalties: true,
  apiPath: "chat",
  reasoningEffort: false,
};

const REASONING: ModelCapabilityProfile = {
  customTemperature: false,
  customTopP: false,
  penalties: false,
  apiPath: "responses",
  reasoningEffort: true,
};

/**
 * 已知**强制 default-only 采样**的模型族。
 *
 * 顺序无关；命中第一个匹配前缀即生效。
 */
const REASONING_PREFIXES: readonly string[] = [
  // OpenAI o-series（含 o1, o1-mini, o1-preview, o1-pro, o3, o3-mini, o4-mini）
  "o1",
  "o3",
  "o4",
  // OpenAI gpt-5 / gpt-5.x / gpt-5-mini 等下一代
  "gpt-5",
  // Azure 命名习惯：azure/o1, azure/gpt-5 等也按相同 family 走
  "azure/o1",
  "azure/o3",
  "azure/o4",
  "azure/gpt-5",
];

/** 给定模型名返回能力 profile（小写不敏感） */
export function modelCapability(model: string | undefined | null): ModelCapabilityProfile {
  if (!model) return FULL;
  const m = model.trim().toLowerCase();
  if (!m) return FULL;
  for (const p of REASONING_PREFIXES) {
    if (m.startsWith(p)) return REASONING;
  }
  return FULL;
}

/**
 * 在发出 OpenAI Chat Completions 请求之前，按模型能力裁掉**不被该模型支持**的
 * 采样字段。已支持的字段保持原样。
 *
 * 用法：
 *   const body = sanitizeChatCompletionsBody(model, {
 *     model,
 *     messages,
 *     temperature: 0.1,
 *     stream: true,
 *   });
 *   await client.chat.completions.create(body);
 *
 * 不可变：返回值是浅拷贝，原入参不会被修改。
 */
export function sanitizeChatCompletionsBody<T extends object>(model: string | undefined | null, body: T): T {
  const cap = modelCapability(model);
  if (cap.customTemperature && cap.customTopP && cap.penalties) {
    /** 全 passthrough，无需拷贝 —— 也不修改原对象 */
    return body;
  }
  /**
   * 用 Record<string, unknown> 视图做删除操作，规避 OpenAI SDK
   * `ChatCompletionCreateParamsBase` 等具名类型上的 in/delete 限制；
   * 调用点仍以原泛型 T 接收，无需 cast。
   */
  const next = { ...body } as Record<string, unknown>;
  if (!cap.customTemperature && "temperature" in next) {
    delete next["temperature"];
  }
  if (!cap.customTopP && "top_p" in next) {
    delete next["top_p"];
  }
  if (!cap.penalties) {
    if ("frequency_penalty" in next) delete next["frequency_penalty"];
    if ("presence_penalty" in next) delete next["presence_penalty"];
  }
  return next as T;
}
