/** NDJSON line contract emitted by external CLIs (optional). */
export const QUBIT_LOOP_PROTOCOL = "qubit.loop.v1" as const;

export type CliLoopLineType = "log" | "tool" | "error" | "final" | "session";

export interface CliLoopNdjsonLine {
  v: typeof QUBIT_LOOP_PROTOCOL;
  type: CliLoopLineType;
  message?: string;
  tool?: string;
  payload?: Record<string, unknown>;
  /** Phase 2.5: session 行携带的可恢复会话 id。 */
  sessionId?: string;
}

export function parseCliLoopLine(line: string): CliLoopNdjsonLine | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t) as {
      v?: unknown;
      type?: string;
      message?: unknown;
      tool?: unknown;
      payload?: unknown;
      sessionId?: unknown;
    };
    if (o.v !== QUBIT_LOOP_PROTOCOL || typeof o.type !== "string") return null;
    const type = o.type as CliLoopLineType;
    if (!["log", "tool", "error", "final", "session"].includes(type)) return null;
    return {
      v: QUBIT_LOOP_PROTOCOL,
      type,
      message: typeof o.message === "string" ? o.message : undefined,
      tool: typeof o.tool === "string" ? o.tool : undefined,
      payload:
        o.payload && typeof o.payload === "object" && !Array.isArray(o.payload)
          ? (o.payload as Record<string, unknown>)
          : undefined,
      sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 2.5: 嗅探 Claude/Codex CLI 原生 stream-json 行里的 session_id。
 * - Claude: `{"type":"system","subtype":"init","session_id":"..."}`
 * - Codex:  `{"type":"session_configured","session_id":"..."}`（rollout 0.x+）
 *
 * 不要求严格匹配——任何顶层 JSON 含 session_id（string）的行都被认为是会话标识。
 */
export function sniffNativeSessionId(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t) as { session_id?: unknown; sessionId?: unknown };
    if (typeof o.session_id === "string" && o.session_id) return o.session_id;
    if (typeof o.sessionId === "string" && o.sessionId) return o.sessionId;
    return null;
  } catch {
    return null;
  }
}
