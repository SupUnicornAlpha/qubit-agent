/**
 * v2 HITL 触发器单测：三档模式 × 硬规则 × LLM 自评。
 * 参考 docs/HITL_REDESIGN.md §3-§5。
 *
 * 注：hitl-service 模块链触发 connectors/bootstrap，本地开发若 backend 持
 * 锁生产 sqlite 会 SQLITE_READONLY 直挂；用 tmpdir 把 DB 路径隔离掉。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-hitl-trigger-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { describe, expect, test } = await import("bun:test");
const {
  evaluateChatHitlTrigger,
  evaluateTeamHitlTrigger,
  isHighRiskChatTool,
} = await import("../hitl-service");
const { workflowRun } = await import("../../../db/sqlite/schema");

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

  test("默认（未设 hitlMode）= 'ai'，LLM 没说要 → 不触发", () => {
    const d = evaluateTeamHitlTrigger({ ...baseInput, loopOptions: {} });
    expect(d.trigger).toBe(false);
  });
});

describe("evaluateTeamHitlTrigger - 硬规则", () => {
  /**
   * rule_money 是资金安全底线，**不可** 被 'off' 抑制（守护用户钱包）。
   * 其它 rule_scale / rule_retry 在 P0-03 修复后会被 'off' 抑制——
   * 老断言"无视 mode 都触发"的设计被反转为 "off 视为用户已承担风险"。
   */
  test("rule_money：trade mode 无视 hitlMode='off' 必触发（资金安全底线，不可关闭）", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      workflow: { mode: "trade" },
      loopOptions: { hitlMode: "off" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_money");
    expect(d.reason).toContain("下单");
  });

  test("rule_scale：mode='ai' (default) 时 6 个标的仍触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      symbols: ["A", "B", "C", "D", "E", "F"],
      loopOptions: { hitlMode: "ai" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_scale");
    expect(d.reason).toContain("6 标的");
  });

  test("rule_scale：mode='ai' 时 7 个分析师仍触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      analystSlotCount: 7,
      loopOptions: { hitlMode: "ai" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_scale");
    expect(d.reason).toContain("7 分析师");
  });

  test("rule_retry：mode='ai' 时同标的最近失败仍触发", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      recentSameTickerStatus: "failed",
      loopOptions: { hitlMode: "ai" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_retry");
    expect(d.reason).toContain("上次");
  });

  test("rule_retry：completed 不触发（只有 failed 才触发）", () => {
    const d = evaluateTeamHitlTrigger({
      ...baseInput,
      recentSameTickerStatus: "completed",
      loopOptions: { hitlMode: "ai" },
    });
    expect(d.trigger).toBe(false);
  });

  /**
   * P0-03 行为反转回归：用户设 hitlMode='off' 必须能跳过 scale / retry 提醒。
   * 评估 case 4 实测 bug：7 个 symbol → rule_scale → 强制 HITL，
   * 但用户 hitlMode='off' 表达"我承担风险"。修复后这种场景必须 trigger=false。
   */
  describe("F-P0-03：hitlMode='off' 抑制 rule_scale / rule_retry（资金外的提醒型规则）", () => {
    test("hitlMode='off' + 6 标的（命中 rule_scale 阈值）→ 不触发", () => {
      const d = evaluateTeamHitlTrigger({
        ...baseInput,
        symbols: ["A", "B", "C", "D", "E", "F"],
        loopOptions: { hitlMode: "off" },
      });
      expect(d.trigger).toBe(false);
      expect(d.source).toBe("none");
      expect(d.reason).toContain("hitlMode='off'");
    });

    test("hitlMode='off' + 7 分析师（命中 rule_scale 阈值）→ 不触发", () => {
      const d = evaluateTeamHitlTrigger({
        ...baseInput,
        analystSlotCount: 7,
        loopOptions: { hitlMode: "off" },
      });
      expect(d.trigger).toBe(false);
      expect(d.source).toBe("none");
    });

    test("hitlMode='off' + 上次失败（命中 rule_retry）→ 不触发", () => {
      const d = evaluateTeamHitlTrigger({
        ...baseInput,
        recentSameTickerStatus: "failed",
        loopOptions: { hitlMode: "off" },
      });
      expect(d.trigger).toBe(false);
      expect(d.source).toBe("none");
    });

    test("hitlMode='off' + LLM hint needed=true → 仍不触发（用户意愿优先）", () => {
      const d = evaluateTeamHitlTrigger({
        ...baseInput,
        loopOptions: { hitlMode: "off" },
        hitlHint: { needed: true, reason: "Orchestrator 觉得需要确认" },
      });
      expect(d.trigger).toBe(false);
      expect(d.source).toBe("none");
    });
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

  test("默认（未设 hitlChatMode）= 'ai'，普通工具不触发", () => {
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

  test("'always' 模式 + 任意工具都触发", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "always" },
      toolName: "fetch_klines",
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("mode_always");
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

  /**
   * v2 P1：对话 orchestrator 的 hitlHint 透传不变式。
   *
   * - 'ai' 模式下，普通工具默认不打扰；但 LLM 在 reasonText 里明确说 needed=true 必须触发
   * - 高危工具（rule_high_risk）路径**永远** approve_only —— hitlHint 不允许把高危
   *   操作降级成选择题，避免"分散注意力"
   * - 'always' 模式下，inputKind/options 透传 hitlHint（让用户既被强制每次都问，
   *   又能看到 LLM 列出来的具体选项）
   *
   * 修复前：ChatHitlTriggerDecision 完全没有 inputKind 字段，对话窗口 HITL 都是
   * approve_only，前端两按钮死路径。
   */
  test("'ai' 模式 + LLM hitlHint.needed=true + single_choice → 触发 ai_hint + 透传 options", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "ai" },
      toolName: "run_analyst_team",
      hitlHint: {
        needed: true,
        reason: "用户意图含糊，需要二选一",
        inputKind: "single_choice",
        options: [
          { label: "侧重技术面", value: "tech" },
          { label: "侧重基本面", value: "fund" },
        ],
      },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("ai_hint");
    expect(d.inputKind).toBe("single_choice");
    expect(d.options).toHaveLength(2);
    expect(d.options?.[0]?.value).toBe("tech");
  });

  test("'ai' 模式 + LLM hitlHint.needed=true + free_form → 触发 ai_hint，options 空", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "ai" },
      toolName: "report_generate",
      hitlHint: { needed: true, reason: "需要一句话指引", inputKind: "free_form" },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("ai_hint");
    expect(d.inputKind).toBe("free_form");
    expect(d.options).toBeUndefined();
  });

  test("'ai' 模式 + LLM hitlHint.needed=false 不触发（即便 inputKind 给了也忽略）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "ai" },
      toolName: "fetch_klines",
      hitlHint: { needed: false, inputKind: "single_choice" },
    });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("none");
  });

  test("高危工具 + hitlHint 想降级成 single_choice 仍被锁回 approve_only", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "ai" },
      toolName: "broker_place_order",
      hitlHint: {
        needed: true,
        inputKind: "single_choice",
        options: [
          { label: "下单", value: "go" },
          { label: "略过", value: "skip" },
        ],
      },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("rule_high_risk");
    expect(d.inputKind).toBe("approve_only");
    expect(d.options).toBeUndefined();
  });

  test("'always' 模式 + hitlHint.inputKind=multi_choice → 触发 mode_always + 透传 inputKind/options", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "always" },
      toolName: "fetch_klines",
      hitlHint: {
        needed: true,
        inputKind: "multi_choice",
        options: [
          { label: "包含日线", value: "1d" },
          { label: "包含周线", value: "1w" },
        ],
      },
    });
    expect(d.trigger).toBe(true);
    expect(d.source).toBe("mode_always");
    expect(d.inputKind).toBe("multi_choice");
    expect(d.options).toHaveLength(2);
  });

  test("'off' 模式 + hitlHint.needed=true 仍不触发（off 是显式关掉，AI 没权力越级）", () => {
    const d = evaluateChatHitlTrigger({
      ...chatBase,
      loopOptions: { hitlChatMode: "off" },
      toolName: "fetch_klines",
      hitlHint: { needed: true, inputKind: "single_choice" },
    });
    expect(d.trigger).toBe(false);
    expect(d.source).toBe("mode_off");
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
