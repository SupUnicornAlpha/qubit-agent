/**
 * v2 HITL 触发器单测：三档模式 × 硬规则 × LLM 自评。
 * 参考 docs/HITL_REDESIGN.md §3-§5。
 */
import { describe, expect, test } from "bun:test";
import { evaluateTeamHitlTrigger } from "../hitl-service";

const baseInput = {
  workflow: { mode: "long" },
  symbols: ["AAPL"],
  analystSlotCount: 3,
  recentSameTickerStatus: null as null,
};

describe("evaluateTeamHitlTrigger - 三档模式", () => {
  test("mode='off' + 无硬规则 → 不触发", () => {
    const d = evaluateTeamHitlTrigger({ ...baseInput, loopOptions: { hitlMode: "off" } });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("none");
  });

  test("mode='ai' + LLM hint needed=false → 不触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      loopOptions: { hitlMode: "ai" },
      hitlHint: { needed: false, reason: "常规多头任务" },
    });
    expect(d.trigger).toBe(false);
  });

  test("mode='ai' + LLM hint needed=true → 触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      loopOptions: { hitlMode: "ai" },
      hitlHint: { needed: true, reason: "策略涉及做空衍生品", inputKind: "single_choice" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("ai");
    expect(d.reason).toContain("做空");
    expect(d.inputKind).toBe("single_choice");
  });

  test("mode='always' + 无 hint → 触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      loopOptions: { hitlMode: "always" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("mode_always");
    expect(d.inputKind).toBe("approve_only");
  });

  test("v1 兼容：hitlTeam=true 等价 mode='always'", () => {
    const d = evaluateTeamHitlTrigger({ ...baseInput, loopOptions: { hitlTeam: true } });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("mode_always");
  });

  test("默认（未设 hitlMode 也未设 hitlTeam）= 'ai'，LLM 没说要 → 不触发", () => {
    const d = evaluateTeamHitlTrigger({ ...baseInput, loopOptions: {} });
    expect(d.trigger).toBe(false);
  });
});

describe("evaluateTeamHitlTrigger - 硬规则（无视 mode）", () => {
  test("rule_money：trade mode 无视 hitlMode='off' 必触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      workflow: { mode: "trade" },
      loopOptions: { hitlMode: "off" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_money");
    expect(d.reason).toContain("下单");
  });

  test("rule_scale：6 个标的无视 hitlMode='off' 必触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      symbols: ["A", "B", "C", "D", "E", "F"],
      loopOptions: { hitlMode: "off" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_scale");
    expect(d.reason).toContain("6 标的");
  });

  test("rule_scale：7 个分析师无视 hitlMode='off' 必触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      analystSlotCount: 7,
      loopOptions: { hitlMode: "off" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_scale");
    expect(d.reason).toContain("7 分析师");
  });

  test("rule_retry：同标的最近失败无视 hitlMode='off' 必触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      recentSameTickerStatus: "failed",
      loopOptions: { hitlMode: "off" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_retry");
    expect(d.reason).toContain("上次");
  });

  test("rule_retry：completed 不触发（只有 failed 才触发）", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      recentSameTickerStatus: "completed",
      loopOptions: { hitlMode: "off" },
    });
    expect(d.trigger).toBe(false);
  });

  test("硬规则优先级：money > scale > retry（money 命中后短路）", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      workflow: { mode: "trade" },
      symbols: ["A", "B", "C", "D", "E", "F", "G"],
      recentSameTickerStatus: "failed",
      loopOptions: { hitlMode: "always" },
    });
    expect(d.source).toBe("rule_money");
  });
});

describe("evaluateTeamHitlTrigger - LLM hint 传 inputKind/options", () => {
  test("AI 决定时透传 single_choice + options", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      loopOptions: { hitlMode: "ai" },
      hitlHint: {
        needed: true,
        inputKind: "single_choice",
        options: [
          { label: "走 A 路径", value: "a" },
          { label: "走 B 路径", value: "b" },
        ],
        reason: "两条都可行，请你选",
      },
    });
    expect(d.inputKind).toBe("single_choice");
    expect(d.options).toHaveLength(2);
    expect(d.options?.[0]?.value).toBe("a");
  });

  test("硬规则命中时仍尝试用 LLM 推荐的 inputKind/options（如有）", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      symbols: ["A", "B", "C", "D", "E", "F"],
      loopOptions: { hitlMode: "ai" },
      hitlHint: {
        needed: true,
        inputKind: "free_form",
        reason: "AI 之外的原因",
      },
    });
    expect(d.source).toBe("rule_scale");
    expect(d.inputKind).toBe("free_form");
  });

  test("硬规则 money 强制 approve_only（资金类不允许选择）", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      workflow: { mode: "trade" },
      loopOptions: { hitlMode: "ai" },
      hitlHint: { needed: true, inputKind: "single_choice" },
    });
    expect(d.source).toBe("rule_money");
    expect(d.inputKind).toBe("approve_only");
  });
});
