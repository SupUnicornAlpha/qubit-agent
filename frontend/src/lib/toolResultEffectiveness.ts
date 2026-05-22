/**
 * 工具 / MCP / Connector 调用结果"有效性"判定。
 *
 * 业务背景：协议层 status='success'（HTTP 200 / MCP OK）不等于"Agent 拿到了有用内容"——
 * 行情连接器可能返回 `{exchange:"UNKNOWN", periods:[]}`、MCP 可能 response_json 为 null，
 * 模型若把这种情形误判为"已拿到数据"会输出空中楼阁。
 *
 * 这个文件提供一份 *启发式* 规则把 `status` 进一步细分为：
 *  - "ok"      ：成功且数据非空
 *  - "empty"   ：成功但语义为空（黄色提醒）
 *  - "failed"  ：协议层失败（红色，由调用方传入）
 *  - "suspect" ：协议成功但延迟极短/无 payload，疑似早夭
 *
 * 规则故意保守：只有明确判断为"空"或"早夭"才降级，其他保持 ok。
 */

export type ToolResultBadge = "ok" | "empty" | "failed" | "suspect";

export type ToolResultVerdict = {
  badge: ToolResultBadge;
  /** 简短中文文案，用于徽章 hover / 状态行。 */
  reason: string;
};

const SUSPECT_LATENCY_MS = 3;
const EMPTY_KEY_HINTS = ["periods", "bars", "items", "rows", "data", "results"] as const;
const ERROR_TEXT_PATTERNS = [
  /no\s+data/i,
  /not\s+found/i,
  /empty/i,
  /no\s+result/i,
  /unavailable/i,
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikePlaceholder(s: string): boolean {
  const norm = s.trim().toUpperCase();
  return norm === "" || norm === "UNKNOWN" || norm === "N/A" || norm === "NULL" || norm === "NONE";
}

/**
 * 判定一个解构后的 payload（已 JSON.parse）是否实质为空。
 * 只判定"显然空"，模糊情况返回 false（即 ok）。
 */
function payloadLooksEmpty(payload: unknown): { empty: boolean; reason?: string } {
  if (payload == null) return { empty: true, reason: "返回 payload 为 null" };
  if (typeof payload === "string") {
    return looksLikePlaceholder(payload)
      ? { empty: true, reason: `返回字符串占位（${payload || "空"}）` }
      : { empty: false };
  }
  if (Array.isArray(payload)) {
    return payload.length === 0 ? { empty: true, reason: "返回数组为空 []" } : { empty: false };
  }
  if (!isPlainObject(payload)) return { empty: false };

  // 1. 错误关键字
  const errorText =
    (typeof payload.error === "string" && payload.error) ||
    (typeof payload.message === "string" && payload.message) ||
    "";
  if (errorText && ERROR_TEXT_PATTERNS.some((p) => p.test(errorText))) {
    return { empty: true, reason: `返回错误关键字："${errorText.slice(0, 60)}"` };
  }

  // 2. 嵌套 connectorResult / result / data 内的核心数组全部为空
  const inner =
    (isPlainObject(payload.connectorResult) && payload.connectorResult) ||
    (isPlainObject(payload.result) && payload.result) ||
    (isPlainObject(payload.data) && payload.data) ||
    null;
  if (inner) {
    let sawArray = false;
    let allEmpty = true;
    for (const key of EMPTY_KEY_HINTS) {
      const v = (inner as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        sawArray = true;
        if (v.length > 0) allEmpty = false;
      }
    }
    if (sawArray && allEmpty) {
      return { empty: true, reason: "数据集合（periods/bars/items/...）全部为空" };
    }
    // 全是占位字符串
    const stringEntries = Object.entries(inner as Record<string, unknown>).filter(
      ([, v]) => typeof v === "string"
    );
    if (
      stringEntries.length > 0 &&
      stringEntries.every(([, v]) => looksLikePlaceholder(v as string))
    ) {
      return { empty: true, reason: "字段全部为占位符（UNKNOWN/N/A/空）" };
    }
  }

  // 3. 顶层 keys 全空
  const keys = Object.keys(payload);
  if (keys.length === 0) return { empty: true, reason: "返回 payload 为 {}" };

  return { empty: false };
}

export function analyzeToolEffectiveness(input: {
  status: string;
  responseJson: unknown;
  latencyMs?: number | null;
  errorMessage?: string | null;
  errorCode?: string | null;
}): ToolResultVerdict {
  const status = (input.status ?? "").toLowerCase();
  if (status !== "success") {
    const detail = input.errorMessage || input.errorCode || status || "调用失败";
    return { badge: "failed", reason: detail };
  }

  // status=success 但 response 整体为空：MCP 经典"假成功"
  if (input.responseJson == null) {
    if (input.latencyMs != null && input.latencyMs <= SUSPECT_LATENCY_MS) {
      return {
        badge: "suspect",
        reason: `成功但响应未落库且延迟仅 ${input.latencyMs}ms，疑似调用早夭`,
      };
    }
    return { badge: "empty", reason: "调用成功但 response_json 为空" };
  }

  const verdict = payloadLooksEmpty(input.responseJson);
  if (verdict.empty) {
    return { badge: "empty", reason: verdict.reason ?? "返回内容为空" };
  }

  return { badge: "ok", reason: "成功且包含有效内容" };
}

export const TOOL_BADGE_STYLE: Record<
  ToolResultBadge,
  { label: string; color: string; bg: string; icon: string }
> = {
  ok: { label: "成功", color: "#86efac", bg: "rgba(34,197,94,0.12)", icon: "✓" },
  empty: { label: "成功 · 空数据", color: "#fbbf24", bg: "rgba(251,191,36,0.12)", icon: "⚠" },
  suspect: { label: "成功 · 可疑", color: "#fb923c", bg: "rgba(251,146,60,0.12)", icon: "?" },
  failed: { label: "失败", color: "#f87171", bg: "rgba(248,113,113,0.12)", icon: "✗" },
};
