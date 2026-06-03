/**
 * 解析 `agent_definition.llm_config_json` → `AgentLlmConfig`。
 *
 * 设计思路：
 *   - DB 列声明 `mode: "json"`，drizzle 会把 TEXT 自动反序列化成 JS 值；
 *     但读端拿到的是 `unknown`（默认 `"{}"` 解析后是空对象，老行手写 NULL/字符串等
 *     退化形态我们也兜底）。
 *   - 只 whitelist 已知字段：未识别的 key 全部忽略，避免把脏数据透到 gateway。
 *   - 类型守卫：数字必须 finite；reasoningEffort 必须是 'low/medium/high' 之一；
 *     违反时不抛错，直接 drop 该字段（让网关走默认值即可）。
 *
 * 这样配置端写错 / DB 老行混乱也不会让 reason 节点崩。
 */

import type { AgentLlmConfig } from "../types";

const ALLOWED_REASONING_EFFORT: ReadonlySet<string> = new Set(["low", "medium", "high"]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveInt(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0 && Math.floor(v) === v;
}

/**
 * 把任意值（DB 反序列化结果 / JSON 字符串 / null）规范成 AgentLlmConfig。
 * 失败时返回空对象 `{}`（语义=完全走网关默认）。
 */
export function parseLlmConfigJson(raw: unknown): AgentLlmConfig {
  if (raw === null || raw === undefined) return {};
  let obj: Record<string, unknown>;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      obj = parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else {
    return {};
  }

  const out: AgentLlmConfig = {};
  /**
   * temperature 合法区间：[0, 2]（OpenAI 公开范围；Anthropic 是 [0,1]，超界让上游
   * 报 400 而不是这里 silently clip，避免"配置写了但行为没生效"的迷惑）。
   */
  if (isFiniteNumber(obj["temperature"]) && obj["temperature"] >= 0 && obj["temperature"] <= 2) {
    out.temperature = obj["temperature"];
  }
  if (isFiniteNumber(obj["topP"]) && obj["topP"] >= 0 && obj["topP"] <= 1) {
    out.topP = obj["topP"];
  } else if (isFiniteNumber(obj["top_p"]) && obj["top_p"] >= 0 && obj["top_p"] <= 1) {
    /** 兼容 snake_case 写法（对应 OpenAI 字段名） */
    out.topP = obj["top_p"];
  }
  if (isPositiveInt(obj["maxOutputTokens"])) {
    out.maxOutputTokens = obj["maxOutputTokens"];
  } else if (isPositiveInt(obj["max_tokens"])) {
    out.maxOutputTokens = obj["max_tokens"];
  } else if (isPositiveInt(obj["max_output_tokens"])) {
    out.maxOutputTokens = obj["max_output_tokens"];
  }
  const re = obj["reasoningEffort"] ?? obj["reasoning_effort"];
  if (typeof re === "string" && ALLOWED_REASONING_EFFORT.has(re)) {
    /**
     * `re` 已被 `ALLOWED_REASONING_EFFORT.has` 收窄为 'low'|'medium'|'high'
     * 之一，这里 cast 一次让 exactOptionalPropertyTypes 满意（不让 string union
     * 含 undefined）。
     */
    out.reasoningEffort = re as "low" | "medium" | "high";
  }
  return out;
}

/**
 * `AgentLlmConfig` → 网关 `LlmSamplingOverrides` 的转换器。
 * 形状一致，但保留独立函数便于将来字段扩展时只动一处。
 */
export function agentLlmConfigToSampling(cfg: AgentLlmConfig | undefined): AgentLlmConfig {
  if (!cfg) return {};
  return { ...cfg };
}
