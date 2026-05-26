/**
 * v2 HITL 触发器单测：三档模式 × 硬规则 × LLM 自评。
 * 参考 docs/HITL_REDESIGN.md §3-§5。
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateChatHitlTrigger,
  evaluateTeamHitlTrigger,
  isHighRiskChatTool,
} from "../hitl-service";
import { workflowRun } from "../../../db/sqlite/schema";

/**
 * 防御：`getRecentSameTickerStatus` 历史上误用 `workflowRun.createdAt`（不存在），
 * 导致 drizzle `_prepare → orderSelectedFields(undefined)` 抛
 * "Object.entries requires that input parameter not be null or undefined"。
 * 这里强制断言 schema 字段：用 `startedAt`，不要再写 `createdAt`。
 */
describe("workflowRun schema 字段（防御回归）", () => {
  test("有 startedAt（drizzle column object）", () => {
    expect(workflowRun.startedAt).toBeDefined();
  });

  test("没有 createdAt（避免 drizzle 拿到 undefined 字段递归抛错）", () => {
    expect((workflowRun as unknown as Record<string, unknown>).createdAt).toBeUndefined();
  });
});

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

/**
 * v2 对话 HITL 触发器：高危工具硬规则 + 三档模式。
 * 关键回归：默认 'ai' 模式下，普通读数据 / 计算 / 报告生成不应触发；只有下单、自修改 prompt、
 * 删除类工具才走 HITL，避免"每调一个工具都得点确认"。
 */
describe("evaluateChatHitlTrigger - 三档模式 × 高危工具", () => {
  const chatBase = {
    workflow: { source: "chat", mode: "research" },
    role: "orchestrator",
  };

  test("默认（未设 hitlChatMode 也未设 hitlChat）= 'ai'，普通工具不触发", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: {},
      toolName: "fetch_klines",
    });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("none");
  });

  test("'ai' 模式 + fetch_news 不触发（常规读数据）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "ai" },
      toolName: "fetch_news",
    });
    expect(d.trigger).toBe(false);
  });

  test("'ai' 模式 + 高危工具 place_order 仍触发（硬规则兜底）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "ai" },
      toolName: "broker_place_order",
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_high_risk");
  });

  test("'off' 模式 + 普通工具不触发", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "off" },
      toolName: "compute_indicators",
    });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("mode_off");
  });

  test("'off' 模式 + 高危工具仍触发（硬规则无视 mode）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "off" },
      toolName: "edit_agent_pack",
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_high_risk");
  });

  test("'always' 模式 + 任意工具都触发（v1 行为）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "always" },
      toolName: "fetch_klines",
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("mode_always");
  });

  test("v1 兼容：hitlChat=true 等价 mode='always'", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChat: true },
      toolName: "fetch_klines",
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("mode_always");
  });

  test("v1 兼容：hitlChat=false 等价 mode='off'", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChat: false },
      toolName: "fetch_klines",
    });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("mode_off");
  });

  test("非 orchestrator 角色一律不触发（防止误拦其他 agent）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      role: "analyst_fundamental",
      loopOptions: { hitlChatMode: "always" },
      toolName: "fetch_klines",
    });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("none");
  });
});

describe("isHighRiskChatTool - 高危工具识别", () => {
  test("识别下单类（broker / place_order / submit_order / cancel_order）", () => {
    expect(isHighRiskChatTool("place_order")).toBe(true);
    expect(isHighRiskChatTool("submit_order")).toBe(true);
    expect(isHighRiskChatTool("cancel_order")).toBe(true);
    expect(isHighRiskChatTool("broker_place_order")).toBe(true);
    expect(isHighRiskChatTool("broker_order_create")).toBe(true);
    expect(isHighRiskChatTool("futu/place_order")).toBe(true);
  });

  test("识别自修改 prompt / agent 定义类", () => {
    expect(isHighRiskChatTool("edit_agent_pack")).toBe(true);
    expect(isHighRiskChatTool("update_agent_definition")).toBe(true);
  });

  test("识别删除 / 清理类", () => {
    expect(isHighRiskChatTool("delete_strategy")).toBe(true);
    expect(isHighRiskChatTool("purge_workflow")).toBe(true);
    expect(isHighRiskChatTool("wipe_session")).toBe(true);
    expect(isHighRiskChatTool("reset_pipeline")).toBe(true);
  });

  test("不误伤常规读数据 / 计算 / 报告类（关键回归 — 避免每个工具都拦）", () => {
    expect(isHighRiskChatTool("fetch_klines")).toBe(false);
    expect(isHighRiskChatTool("fetch_news")).toBe(false);
    expect(isHighRiskChatTool("compute_indicators")).toBe(false);
    expect(isHighRiskChatTool("detect_patterns")).toBe(false);
    expect(isHighRiskChatTool("run_backtest")).toBe(false);
    expect(isHighRiskChatTool("run_screener")).toBe(false);
    expect(isHighRiskChatTool("generate_report")).toBe(false);
    expect(isHighRiskChatTool("call_team_market_data")).toBe(false);
    expect(isHighRiskChatTool("run_analyst_team")).toBe(false);
    expect(isHighRiskChatTool("task_decompose")).toBe(false);
    expect(isHighRiskChatTool("assign_task")).toBe(false);
    expect(isHighRiskChatTool("fuse_signals")).toBe(false);
    expect(isHighRiskChatTool("write_memory")).toBe(false); // 写内存非外部状态变更
    expect(isHighRiskChatTool("search_memory")).toBe(false);
  });

  test("空 / 空白工具名不算高危", () => {
    expect(isHighRiskChatTool("")).toBe(false);
    expect(isHighRiskChatTool("   ")).toBe(false);
  });
});
