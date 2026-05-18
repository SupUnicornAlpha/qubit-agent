import type { KlinesErrorPayload } from "../api/types";

/** 状态行末尾展示：错误类型 + 简要说明 */
export function formatKlinesErrorTail(error: KlinesErrorPayload): string {
  return `错误类型 ${error.type} · ${error.code}`;
}

/** 完整错误文案（含 hint，用于错误条） */
export function formatKlinesErrorMessage(error: KlinesErrorPayload): string {
  const hint = error.hint ? ` ${error.hint}` : "";
  return `${error.message}（${error.type} / ${error.code}）${hint}`;
}

export function isKlinesErrorPayload(v: unknown): v is KlinesErrorPayload {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.type === "string" && typeof o.code === "string" && typeof o.message === "string";
}

/** 解析 API 失败响应中的包装错误 */
export function parseKlinesApiError(body: unknown): KlinesErrorPayload | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (isKlinesErrorPayload(err)) return err;
  if (typeof err === "string") {
    return { type: "klines_upstream_failed", code: "api_error", message: err };
  }
  return null;
}
