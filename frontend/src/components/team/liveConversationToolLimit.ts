/**
 * 正文流里连续 tool_call 卡片限流：每段 streak 最多保留最近 N 条。
 * 「调用过程」区仍展示全量，不受此限制。
 */

export type ToolLimitPart =
  | { kind: "tool"; id: string }
  | { kind: "tool_overflow"; key: string; hiddenCount: number }
  | { kind: string; [key: string]: unknown };

export const MAX_CONSECUTIVE_TOOL_CARDS = 3;

export function limitConsecutiveToolParts<T extends { kind: string }>(
  parts: T[],
  maxVisible = MAX_CONSECUTIVE_TOOL_CARDS
): Array<T | { kind: "tool_overflow"; key: string; hiddenCount: number }> {
  const out: Array<T | { kind: "tool_overflow"; key: string; hiddenCount: number }> = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (part.kind !== "tool") {
      out.push(part);
      i += 1;
      continue;
    }
    let j = i;
    while (j < parts.length && parts[j]!.kind === "tool") j += 1;
    const streak = parts.slice(i, j);
    if (streak.length > maxVisible) {
      const hidden = streak.length - maxVisible;
      const firstId =
        "ev" in streak[0]! &&
        streak[0]!.ev &&
        typeof (streak[0]!.ev as { id?: unknown }).id === "string"
          ? String((streak[0]!.ev as { id: string }).id)
          : String(i);
      out.push({
        kind: "tool_overflow",
        key: `tool-overflow:${firstId}:${hidden}`,
        hiddenCount: hidden,
      });
      out.push(...streak.slice(-maxVisible));
    } else {
      out.push(...streak);
    }
    i = j;
  }
  return out;
}
