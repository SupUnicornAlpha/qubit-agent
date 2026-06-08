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

export interface ScenarioRecipe {
  /** 场景 key，会进 snapshot.scenario，方便 diff */
  key: "research" | "stock_pick" | "factor" | "strategy" | "live_trading";
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
    displayName: "市场研究",
    workflow: {
      goal: "对当前美股市场做一次宏观 + 个股级别的研究，输出 3 条交易级见解；要求引用至少 2 个新闻或财报数据点。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "react",
      loopOptionsJson: { maxIterations: 6 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      ticker: "SPY",
      context:
        "评测目标：对美股市场做宏观 + 个股级研究，输出 3 条交易级见解，至少引用 2 个新闻或财报数据点。SPY 仅作为市场代理；分析师团队应自主从 SPY 出发延展到代表性个股（如 NVDA / AAPL / MSFT），充分调用市场行情、新闻情绪、基本面工具。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  stock_pick: {
    key: "stock_pick",
    displayName: "股票推荐",
    workflow: {
      goal: "基于过去 30 天的 momentum + 估值 + 新闻情绪，从美股大盘里筛出 5 只候选并给出推荐理由。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "react",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-full-analyst-team",
      scope: { kind: "explore", theme: "美股大盘 momentum + 估值 + 新闻情绪 选股" },
      context:
        "评测目标：从美股大盘筛 5 只候选并给推荐理由，需结合 30 天动量、估值、新闻情绪。请先用 run_screener / fetch_klines 验证候选存在性后再分析。",
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
      loopKind: "react",
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
    displayName: "策略生成",
    workflow: {
      goal: "组合 2-3 个已有因子生成一份可回测的策略草稿，包含目标 universe / 持仓周期 / 仓位规则。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "react",
      loopOptionsJson: { maxIterations: 8 },
    },
    analystRun: {
      agentGroupId: "grp-strategy-pipeline",
      scope: { kind: "explore", theme: "因子组合策略草稿 + universe + 持仓周期" },
      context:
        "评测目标：组合 2-3 个已有因子产出可回测的策略草稿，落 strategy + strategy_version；包含 universe / 持仓周期 / 仓位规则。",
      hitlMode: "off",
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  live_trading: {
    key: "live_trading",
    displayName: "实时交易",
    workflow: {
      goal: "按现有最新策略版本，针对当前市场状态产出至少一个 order_intent；遇到风控/合规问题应中断并写 audit_log。",
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "react",
      loopOptionsJson: { maxIterations: 6 },
    },
    analystRun: {
      agentGroupId: "grp-live-trading",
      scope: { kind: "explore", theme: "基于最新策略版本的实盘下单意图" },
      context:
        "评测目标：先 SELECT 最新 strategy_version，再针对当前市场状态产出至少 1 条 order_intent；触发风控/合规要走 audit_log + HITL，不要直接放行。",
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
