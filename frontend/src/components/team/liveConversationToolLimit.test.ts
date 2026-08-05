import { describe, expect, test } from "bun:test";
import { limitConsecutiveToolParts } from "./liveConversationToolLimit";

describe("limitConsecutiveToolParts", () => {
  test("keeps at most 3 consecutive tools and inserts overflow hint", () => {
    const parts = [1, 2, 3, 4, 5].map((n) => ({
      kind: "tool" as const,
      ev: { id: String(n) },
    }));
    const limited = limitConsecutiveToolParts(parts, 3);
    expect(limited[0]).toMatchObject({ kind: "tool_overflow", hiddenCount: 2 });
    expect(limited.filter((p) => p.kind === "tool")).toHaveLength(3);
    expect((limited[1] as { ev: { id: string } }).ev.id).toBe("3");
  });

  test("resets streak after assistant narrative", () => {
    const parts = [
      { kind: "tool" as const, ev: { id: "1" } },
      { kind: "tool" as const, ev: { id: "2" } },
      { kind: "tool" as const, ev: { id: "3" } },
      { kind: "tool" as const, ev: { id: "4" } },
      { kind: "assistant" as const, key: "a1" },
      { kind: "tool" as const, ev: { id: "5" } },
      { kind: "tool" as const, ev: { id: "6" } },
    ];
    const limited = limitConsecutiveToolParts(parts, 3);
    const overflow = limited.filter((p) => p.kind === "tool_overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({ hiddenCount: 1 });
    expect(limited.filter((p) => p.kind === "tool")).toHaveLength(5);
  });
});
