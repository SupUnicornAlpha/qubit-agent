import { describe, expect, test } from "bun:test";
import {
  buildSessionChronicle,
  detectTaskSupersession,
  isDeliveryNarrative,
  mergeWorkspaceBackground,
  summarizeAssistantForChronicle,
} from "../turn-packet";

describe("turn-packet chronicle", () => {
  test("detects delivery narratives", () => {
    const manual = `# 📖 oversold_reversal_semi 人肉说明书（完整版）

## 一、打开 K 线
Factor ① bias_10d — 10-day bias
`.repeat(3);
    expect(isDeliveryNarrative(manual)).toBe(true);
    expect(isDeliveryNarrative("选股完成：A B C")).toBe(false);
  });

  test("summarizes assistant delivery as artifact stub", () => {
    const content = `# 🧭 oversold_reversal_semi —— 人肉操盘说明书（完整版）

先确认跌够了再确认跌不动了。
`.repeat(5);
    const s = summarizeAssistantForChronicle(content);
    expect(s).toContain("[delivered_artifact]");
    expect(s).not.toContain("跌够了");
    expect(s.length).toBeLessThan(200);
  });

  test("buildSessionChronicle omits full manual and flags supersession", () => {
    const manual = `# 📖 oversold_reversal_semi 人肉说明书（完整版）

| 序号 | 指标 |
|------|------|
| 1 | MA10 |

Factor ① bias — detail detail detail
`.repeat(4);

    const chronicle = buildSessionChronicle({
      currentUserMessageId: "u2",
      currentUserText: "我不是要人肉版，我要你帮我选股",
      messages: [
        {
          id: "u1",
          role: "user",
          content: "请用因子策略在半导体板块选股给5个标的",
        },
        {
          id: "a1",
          role: "assistant",
          sender: "orchestrator",
          content: manual,
        },
        {
          id: "u2",
          role: "user",
          content: "我不是要人肉版，我要你帮我选股",
        },
      ],
      recentTools: [
        { toolName: "factor.list", status: "ok" },
        { toolName: "strategy.compose", status: "fail", detail: "factor_ids" },
      ],
    });

    expect(chronicle).toContain("TASK_SUPERSESSION");
    expect(chronicle).toContain("[delivered_artifact]");
    expect(chronicle).toContain("OPTIONAL_BACKGROUND");
    expect(chronicle).toContain("strategy.compose: fail");
    expect(chronicle).not.toContain("Factor ①");
    expect(chronicle).not.toMatch(/跌够了|打开 K/);
  });

  test("detectTaskSupersession requires prior delivery", () => {
    expect(
      detectTaskSupersession(
        [{ id: "a", role: "assistant", content: "选了 5 只：xxx" }],
        "帮我选股"
      )
    ).toBeNull();
    expect(
      detectTaskSupersession(
        [
          {
            id: "a",
            role: "assistant",
            content: `人肉说明书\n\n${"指标说明\n".repeat(40)}`,
          },
        ],
        "我不是要人肉版，我要你帮我选股"
      )
    ).toContain("TASK_SUPERSESSION");
  });

  test("mergeWorkspaceBackground wraps and clips", () => {
    const out = mergeWorkspaceBackground(
      "OPTIONAL_BACKGROUND (session_chronicle) — do NOT override CURRENT_USER_TASK:\n- user: hi",
      `WS ${"x".repeat(5000)}`,
      100
    );
    expect(out).toContain("OPTIONAL_BACKGROUND (workspace)");
    expect(out.length).toBeLessThan(500);
  });

  test("overflow folds into compacted_prior", () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0
        ? {
            id: `u${i}`,
            role: "user" as const,
            content: `请分析标的 ${i}`,
          }
        : {
            id: `a${i}`,
            role: "assistant" as const,
            sender: "orchestrator",
            content: `简短结论 ${i}`,
          }
    );
    const chronicle = buildSessionChronicle({
      messages: [...messages, { id: "cur", role: "user", content: "下一步选股" }],
      currentUserMessageId: "cur",
      currentUserText: "下一步选股",
      maxMessages: 4,
      priorCompactedSummary: "seed-compact",
    });
    expect(chronicle).toContain("[compacted_prior]");
    expect(chronicle).toContain("seed-compact");
  });
});

describe("rolling chronicle", () => {
  test("rollChronicleWindow absorbs overflow", async () => {
    const { rollChronicleWindow, emptyRollingChronicle } = await import("../turn-packet");
    const messages = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i} content here`,
    }));
    const first = rollChronicleWindow({
      state: emptyRollingChronicle(),
      messages,
      currentUserMessageId: "none",
      maxEntries: 4,
    });
    expect(first.priorCompactedSummary.length).toBeGreaterThan(0);
    const second = rollChronicleWindow({
      state: first.state,
      messages,
      currentUserMessageId: "none",
      maxEntries: 4,
    });
    // Same overflow should not explode length.
    expect(second.priorCompactedSummary.length).toBeLessThanOrEqual(
      first.priorCompactedSummary.length + 20
    );
  });
});
