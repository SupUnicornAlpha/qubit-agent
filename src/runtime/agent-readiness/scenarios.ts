/**
 * Agent 就绪度评估的 5 个场景配方。
 *
 * 每条配方是 `createAndDispatchWorkflow` 的入参 + 一些就绪度专属元信息。
 *
 * P0 阶段先填 research，其它 4 个挂占位（同一份 schema），后续按需扩。
 */

import type { CreateAndDispatchWorkflowInput } from "../workflow/workflow-service";

export interface ScenarioRecipe {
  /** 场景 key，会进 snapshot.scenario，方便 diff */
  key: "research" | "stock_pick" | "factor" | "strategy" | "live_trading";
  /** 给 reporter 用的 human-readable 名称 */
  displayName: string;
  /** 直接传给 createAndDispatchWorkflow */
  workflow: Omit<CreateAndDispatchWorkflowInput, "projectId">;
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

export const SCENARIO_RECIPES: Record<ScenarioRecipe["key"], ScenarioRecipe> = {
  research: {
    key: "research",
    displayName: "市场研究",
    workflow: {
      goal: "对当前美股市场做一次宏观 + 个股级别的研究，输出 3 条交易级见解；要求引用至少 2 个新闻或财报数据点。",
      mode: "research",
      source: "api",
      taskType: "market_research",
      loopKind: "react",
      loopOptionsJson: { maxIterations: 6 },
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
      taskType: "stock_recommendation",
      loopKind: "react",
      loopOptionsJson: { maxIterations: 8 },
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
      taskType: "factor_generation",
      loopKind: "react",
      loopOptionsJson: { maxIterations: 8 },
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
      taskType: "strategy_authoring",
      loopKind: "react",
      loopOptionsJson: { maxIterations: 8 },
    },
    expectedTerminalStatus: DEFAULT_TERMINAL,
  },
  live_trading: {
    key: "live_trading",
    displayName: "实时交易",
    workflow: {
      goal: "按现有最新策略版本，针对当前市场状态产出至少一个 order_intent；遇到风控/合规问题应中断并写 audit_log。",
      mode: "live",
      source: "api",
      taskType: "live_trading_dryrun",
      loopKind: "react",
      loopOptionsJson: { maxIterations: 6 },
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
