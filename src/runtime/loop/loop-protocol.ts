/** NDJSON line contract emitted by external CLIs (optional). */
export const QUBIT_LOOP_PROTOCOL = "qubit.loop.v1" as const;

export type CliLoopLineType = "log" | "tool" | "error" | "final";

export interface CliLoopNdjsonLine {
  v: typeof QUBIT_LOOP_PROTOCOL;
  type: CliLoopLineType;
  message?: string;
  tool?: string;
  payload?: Record<string, unknown>;
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
    };
    if (o.v !== QUBIT_LOOP_PROTOCOL || typeof o.type !== "string") return null;
    const type = o.type as CliLoopLineType;
    if (!["log", "tool", "error", "final"].includes(type)) return null;
    return {
      v: QUBIT_LOOP_PROTOCOL,
      type,
      message: typeof o.message === "string" ? o.message : undefined,
      tool: typeof o.tool === "string" ? o.tool : undefined,
      payload:
        o.payload && typeof o.payload === "object" && !Array.isArray(o.payload)
          ? (o.payload as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return null;
  }
}
