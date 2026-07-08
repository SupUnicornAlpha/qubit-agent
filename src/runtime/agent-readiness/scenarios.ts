/**
 * Agent 就绪度评估的 5 个场景配方。
 *
 * 评测必须复刻 UI 上「研究团队」启动方式的真实链路：
 *   1. POST /api/v1/workflows  (skipDispatch=true) — 仅创建 workflow_run 占位
 *   2. POST /api/v1/analyst/run { workflowRunId, agentGroupId, ticker | scope }
 *      — 真正派发给 orchestrator，启动多 Agent 团队（task=research_team_execute）
 *
 * 历史教训（Round 5）：之前直接走 POST /api/v1/workflows（无 skipDispatch、无
 * agentGroupId）等于让单 Agent 裸跑，没启动分析师团队、回测 / risk agent，
 * A 类内容指标全垮（trace 显示 research 仅 10 step / 2 tool calls），跟 UI
 * 实际行为完全脱节。AGM v2 的 5 个场景必须按 UI 路径跑才有意义。
 */

import type { CreateAndDispatchWorkflowInput } from "../workflow/workflow-service";
import type { ResearchScopeInput } from "../../types/research-scope";

export interface AnalystRunPayload {
  /** 必填：UI 上"启动研究团队"必须选的 group */
  agentGroupId: string;
  /** 单标的优先（research 类）；多标/概念类用 scope.kind=explore + theme */
  ticker?: string;
  scope?: ResearchScopeInput;
  context?: string;
  hitlMode?: "off" | "ai" | "always";
}

/**
 * 9 个场景 key —— 现有 5 base + 4 个组合维度扩展（多/空/无标的）：
 *
 *   research              → 单标的研究（R-S）
 *   research_multi        → 多标的同业对比（R-M）
 *   research_theme        → 主题驱动 / 无标的（R-T）
 *   stock_pick            → 多标的 long 偏好（SP-L，沿用 base）
 *   stock_pick_short      → 多标的 short 偏好（SP-S）
 *   factor                → alpha 因子（F-1）
 *   strategy              → long-only 因子组合（沿用 base）
 *   strategy_long_short   → 多空配对策略（ST-LS）
 *   live_trading          → 做多 order_intent（LT-L，沿用 base）
 *   live_trading_short    → 做空 order_intent（LT-S）
 *
 * 期权场景（ST-OPT）待 instrument schema 扩展支持期权后再补，详见
 * docs/superpowers/specs/2026-06-09-options-data-model.md（待生成）。
 */
export type ScenarioKey =
  | "research"
  | "research_multi"
  | "research_theme"
  | "stock_pick"
  | "stock_pick_short"
  | "factor"
  | "strategy"
  | "strategy_long_short"
  | "live_trading"
  | "live_trading_short";

export interface ScenarioRecipe {
  /** 场景 key，会进 snapshot.scenario，方便 diff */
  key: ScenarioKey;
  /** 给 reporter 用的 human-readable 名称 */
  displayName: string;
  /** 第 1 步：传给 createAndDispatchWorkflow 的 workflow 占位入参（建议 skipDispatch=true） */
  workflow: Omit<CreateAndDispatchWorkflowInput, "projectId">;
  /** 第 2 步：传给 /api/v1/analyst/run 的 group + 上下文 */
  analystRun: AnalystRunPayload;
  /**
   * 默认期望终态。runner 会等到 workflow_run.status 进入 expectedTerminalStatus
   * 之一才开始抓快照。
   */
  expectedTerminalStatus: ReadonlyArray<"completed" | "failed" | "cancelled" | "timeout">;
}

const DEFAULT_TERMINAL: ReadonlyArray<"completed" | "failed" | "cancelled" | "timeout"> = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
];

/**
 * 5 场景配方
 *
 * UI 链路约束：「新建工作流」+「启动研究团队」对应 mode 必须是 'research'，
 * orchestrator 的 research_team_execute 任务只在 research mode 下分发。所以
 * live_trading 场景虽然 goal 是实盘下单，本评测里也用 mode=research 起团队，
 * 让分析师团队"先做研究输出 order_intent 建议"，更贴合 UI 上"研究团队 → 实盘助手"
 * 这类玩法（实盘场景在 UI 上没有直接的"研究团队"启动入口；目前只能通过
 * 研究团队 + 模拟下单 group 间接驱动，待 P5 直接接入 trader-workflow）。
 */
export const SCENARIO_RECIPES: Record<ScenarioRecipe["key"], ScenarioRecipe> = {
  research: {
    key: "research",
    displayName: "市场研究 · 单标的（R-S）",
    workflow: {
      goal: "对 AAPL 做一次单只个股深度研究：财报、估值、技术面、宏观与同业对比；输出 3 条交易级见解，每条引用至少 1 个新闻或财报数据点。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 6 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      ticker: "AAPL",
      context:
        "评测目标：以 AAPL 为唯一标的做单只深度研究，覆盖估值/财报/技术/宏观/同业对比；分析师团队应充分调用 quote、news、fundamentals、screener 等工具，输出 3 条具体交易级见解。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  research_multi: {
    key: "research_multi",
    displayName: "市场研究 · 多标的同业（R-M）",
    workflow: {
      goal: "对 AI 算力相关的 3 只半导体股做横向对比研究（NVDA / AMD / INTC），输出每只一段 2-3 句的多空观点并给出相对排序及理由。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      scope: {
        kind: "explore",
        theme: "NVDA / AMD / INTC 半导体三家横向对比 · AI 算力主题",
      },
      context:
        "评测目标：对 NVDA / AMD / INTC 三只半导体股做横向对比，要求 analyst_signal 至少落 3 条（每只一条）且 ticker 字段三家齐；输出每家多空观点 + 相对排序。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  research_theme: {
    key: "research_theme",
    displayName: "市场研究 · 主题/无标的（R-T）",
    workflow: {
      goal: "围绕「AI 算力基础设施」主题做行业级研究：识别 3 个最具代表性的细分领域 + 各推荐 1 只龙头标的并给推荐理由；要求自主决定标的、不依赖外部输入。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      scope: {
        kind: "explore",
        theme: "AI 算力基础设施主题研究 · 自主识别 3 个细分赛道 + 各 1 只龙头",
      },
      context:
        "评测目标：纯主题驱动 / 无指定 ticker；分析师团队应主动用 screener / fetch_klines / news 识别 3 个 AI 算力基础设施细分赛道，并各推 1 只代表标的。analyst_signal 至少落 3 条。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  stock_pick: {
    key: "stock_pick",
    displayName: "股票推荐 · long 偏好（SP-L）",
    workflow: {
      goal: "基于过去 30 天的 momentum + 估值 + 新闻情绪，从美股大盘里筛出 5 只 long 候选并给出推荐理由。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      scope: { kind: "explore", theme: "美股大盘 momentum + 估值 + 新闻情绪 long 选股" },
      context:
        "评测目标：从美股大盘筛 5 只 long 候选并给推荐理由，需结合 30 天动量、估值、新闻情绪。请先用 run_screener / fetch_klines 验证候选存在性后再分析。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  stock_pick_short: {
    key: "stock_pick_short",
    displayName: "股票推荐 · short 偏好（SP-S）",
    workflow: {
      goal: "从美股大盘筛 3 只「相对高估值 + 业绩下滑或动量恶化」的 short 候选并给出做空理由；强调风险（轧空、回购）。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      scope: {
        kind: "explore",
        theme: "美股大盘做空候选：高估值 + 业绩或动量恶化 + 风险评估",
      },
      context:
        "评测目标：筛 3 只 short 候选（高估值/业绩下滑/动量恶化），每只 analyst_signal 的 reasoning 必须显式提到「做空」/「short」/「估值过高」之类关键词，并讨论轧空、强制平仓、负 carry 等风险。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  factor: {
    key: "factor",
    displayName: "因子生成",
    workflow: {
      goal: "提出一个新的 alpha 因子（含数学公式 + 经济学解释），并给出在过去 60 个交易日的 IC / IR 模拟值。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-factor-research",
      scope: { kind: "explore", theme: "新 alpha 因子设计 + 60 日 IC/IR 评估" },
      context:
        "评测目标：提出一个 alpha 因子（公式 + 经济学解释 + 60 日 IC/IR 模拟）。落库要求：factor_definition + factor_evaluation 各至少一条；评估指标必须有数值（IC / Rank IC / IR）。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  strategy: {
    key: "strategy",
    displayName: "策略生成 · long-only（ST）",
    workflow: {
      goal: "组合 2-3 个已有因子生成一份 long-only 的可回测策略草稿，包含目标 universe / 持仓周期 / 仓位规则。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-strategy-pipeline",
      scope: { kind: "explore", theme: "long-only 因子组合策略草稿 + universe + 持仓周期" },
      context:
        "评测目标：组合 2-3 个已有因子产出 long-only 策略草稿，落 strategy + strategy_version + strategy_composition；包含 universe / 持仓周期 / 仓位规则。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  strategy_long_short: {
    key: "strategy_long_short",
    displayName: "策略生成 · 多空配对（ST-LS）",
    workflow: {
      goal: "用 2-3 个因子构造一个 long/short 配对策略：在 universe 内分别选 long 端和 short 端，各 5-10% 仓位上限；输出 strategy_version + strategy_composition + 回测假设。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 10 },
    },
    analystRun: {
      agentGroupId: "grp-strategy-pipeline",
      scope: {
        kind: "explore",
        theme: "多空配对策略草稿：long/short 因子组合 + 配对方式 + 仓位约束",
      },
      context:
        "评测目标：组合 2-3 个因子产出 **long/short** 配对策略；strategy_composition.description 中必须显式提到「long」「short」「pair」等关键词；composition.factorIdsJson 至少 2 个因子；包含 universe / 持仓周期 / 多空仓位上限。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  live_trading: {
    key: "live_trading",
    displayName: "实时交易 · 做多（LT-L）",
    workflow: {
      goal: "按现有最新策略版本，针对当前市场状态产出至少 1 条 **做多（side=buy）** 的 order_intent，并经 risk_decision 审核；触发风控/合规要走 audit_log + HITL，不要直接放行。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 6 },
    },
    analystRun: {
      agentGroupId: "grp-live-trading",
      scope: { kind: "explore", theme: "基于最新策略版本的做多下单意图" },
      context:
        "评测目标：先 SELECT 最新 strategy_version，再针对当前市场状态产出至少 1 条 **side=buy** 的 order_intent + risk_decision；reasoning 中说明加仓理由（动量/估值/事件）。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  live_trading_short: {
    key: "live_trading_short",
    displayName: "实时交易 · 做空（LT-S）",
    workflow: {
      goal: "按现有最新策略版本，针对当前市场状态产出至少 1 条 **做空（side=sell）** 的 order_intent，并经 risk_decision 审核；做空场景应触发更严风控（保证金、可借券、轧空风险）。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: { maxIterations: 6 },
    },
    analystRun: {
      agentGroupId: "grp-live-trading",
      scope: {
        kind: "explore",
        theme: "基于最新策略版本的做空下单意图 + 严格风控",
      },
      context:
        "评测目标：产出至少 1 条 **side=sell** 的 order_intent + risk_decision；reasoning 必须显式提到「做空」/「short」并讨论保证金、可借券或轧空风险。注意：当前是 sell 表达「做空」语义，依赖 strategy_version 上下文区分平多 vs 开空。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
};

export function getScenarioRecipe(key: string): ScenarioRecipe {
  const r = SCENARIO_RECIPES[key as ScenarioRecipe["key"]];
  if (!r) {
    throw new Error(
      `[agent-readiness] unknown scenario: ${key}. Allowed: ${Object.keys(SCENARIO_RECIPES).join(", ")}`
    );
  }
  return r;
}
