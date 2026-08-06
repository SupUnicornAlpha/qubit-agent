import type { ScenarioKey } from "../agent-readiness/scenarios";

export type BenchmarkDimension =
  | "delivery"
  | "quality"
  | "tools"
  | "resource"
  | "risk"
  | "memory"
  | "orchestration";

export interface BenchmarkBudget {
  maxDurationMs: number;
  maxTotalTokens: number;
  maxTokenP95: number;
  maxIterations: number;
}

/** Case 级过程期望：驱动 Soft 门控与报告，不替代 Hard。 */
export interface BenchmarkCaseExpectations {
  /** 必须至少一次 memory.recall 或 workspace.memory.search。 */
  requireMemoryRecall?: boolean;
  /** 必须至少一次 agent.invoke / specialist handoff。 */
  requireSpecialistInvoke?: boolean;
  /** Soft.tools / recipe 召回下限（0–1）。 */
  minRequiredToolRecall?: number;
  /** Soft.memory 下限（仅当 requireMemoryRecall 或实际调用时生效）。 */
  minMemoryScore?: number;
  /** Soft.orchestration 下限（仅当 requireSpecialistInvoke 或实际 invoke 时生效）。 */
  minOrchestrationScore?: number;
}

export interface QubitBenchCase {
  id: string;
  title: string;
  scenarioKey: ScenarioKey;
  dimensions: readonly BenchmarkDimension[];
  goal: string;
  inputParams: Record<string, unknown>;
  budget: BenchmarkBudget;
  /** A-2 下限；不同场景的关键词密度不应一刀切。 */
  minRelevance: number;
  /** v0.2：多维 Soft 期望（可选）。 */
  expectations?: BenchmarkCaseExpectations;
  /** 业务标签，便于按场景簇过滤。 */
  businessTags?: readonly string[];
}

/** 预算按 L1 实测校准；soft 超支不阻断研究，hard（×3）才在 upgrade gate fail。 */
const RESEARCH_BUDGET: BenchmarkBudget = {
  maxDurationMs: 12 * 60_000,
  maxTotalTokens: 240_000,
  maxTokenP95: 36_000,
  maxIterations: 8,
};
const COMPLEX_RESEARCH_BUDGET: BenchmarkBudget = {
  maxDurationMs: 18 * 60_000,
  maxTotalTokens: 320_000,
  maxTokenP95: 48_000,
  maxIterations: 10,
};
const EXECUTION_BUDGET: BenchmarkBudget = {
  maxDurationMs: 10 * 60_000,
  maxTotalTokens: 180_000,
  maxTokenP95: 32_000,
  maxIterations: 6,
};

const CORE_DIMS = ["delivery", "quality", "tools", "resource"] as const;
const RISK_DIMS = ["delivery", "quality", "tools", "resource", "risk"] as const;
const MEM_DIMS = ["delivery", "quality", "tools", "resource", "memory"] as const;
const ORCH_DIMS = [
  "delivery",
  "quality",
  "tools",
  "resource",
  "orchestration",
] as const;
const FULL_DIMS = [
  "delivery",
  "quality",
  "tools",
  "resource",
  "memory",
  "orchestration",
] as const;

/**
 * qubit-bench-v0.2：多业务场景真实对话 case。
 *
 * case id 是稳定 API；scenarioKey 复用已有产物契约与统一 launch 入口。v0.2 在
 * 原 20 case 基础上增加记忆召回、编排 handoff、组合/论点等业务簇，Soft 层按
 * dimensions / expectations 评测工具与记忆等细维度。
 */
export const QUBIT_BENCH_CASES: readonly QubitBenchCase[] = [
  // ── Research ──────────────────────────────────────────────
  {
    id: "QB-RS-01",
    title: "单标的财报后研究",
    scenarioKey: "research",
    dimensions: CORE_DIMS,
    businessTags: ["research", "single_ticker"],
    goal: "对 AAPL 最近一次财报后的基本面、估值、技术面与风险做研究；给出三条带证据的交易级结论，并明确哪些数据仍不确定。",
    inputParams: { ticker: "AAPL", debateRounds: 1 },
    budget: RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { minRequiredToolRecall: 0.5 },
  },
  {
    id: "QB-RS-02",
    title: "高波动事件风险研究",
    scenarioKey: "research",
    dimensions: CORE_DIMS,
    businessTags: ["research", "risk"],
    goal: "研究 TSLA 在交付量、监管与估值分歧下的多空驱动因素；不确定时必须明确数据缺口，不得编造价格或新闻。",
    inputParams: { ticker: "TSLA", debateRounds: 1 },
    budget: RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { minRequiredToolRecall: 0.5 },
  },
  {
    id: "QB-RS-03",
    title: "证据不足时的诚实降级",
    scenarioKey: "research",
    dimensions: CORE_DIMS,
    businessTags: ["research", "honesty"],
    goal: "研究一个信息不充分的事件驱动机会；若新闻、行情或基本面证据不足，明确说明不能形成交易结论，并避免生成伪造的推荐。",
    inputParams: { ticker: "AAPL", debateRounds: 1 },
    budget: RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-RM-01",
    title: "AI 芯片三公司横向比较",
    scenarioKey: "research_multi",
    dimensions: ORCH_DIMS,
    businessTags: ["research", "multi_ticker", "orchestration"],
    goal: "比较 NVDA、AMD、INTC 的增长、估值、产品周期与风险，输出相对排序及每只股票的多空理由。优先委派分析师子任务，不要只由编排器刷 MCP。",
    inputParams: { ticker: "NVDA,AMD,INTC", debateRounds: 1 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.4,
    expectations: {
      requireSpecialistInvoke: true,
      minOrchestrationScore: 0.4,
      minRequiredToolRecall: 0.5,
    },
  },
  {
    id: "QB-RM-02",
    title: "云软件同业估值比较",
    scenarioKey: "research_multi",
    dimensions: ORCH_DIMS,
    businessTags: ["research", "multi_ticker"],
    goal: "比较 MSFT、CRM、NOW 的收入质量、自由现金流、估值与 AI 变现进展，给出相对强弱排序。",
    inputParams: { ticker: "MSFT,CRM,NOW", debateRounds: 1 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { requireSpecialistInvoke: true, minOrchestrationScore: 0.35 },
  },
  {
    id: "QB-RT-01",
    title: "AI 基础设施主题研究",
    scenarioKey: "research_theme",
    dimensions: CORE_DIMS,
    businessTags: ["research", "theme"],
    goal: "围绕 AI 算力基础设施识别芯片、网络、数据中心电力三个细分方向，并各给一个可验证的代表标的和风险。",
    inputParams: { universe: "US:sp500", topN: 5, theme: "AI 算力基础设施" },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.4,
  },
  {
    id: "QB-RT-02",
    title: "防御型行业轮动研究",
    scenarioKey: "research_theme",
    dimensions: CORE_DIMS,
    businessTags: ["research", "theme", "macro"],
    goal: "在利率走高与增长放缓假设下，研究公用事业、医疗保健、必选消费的防御属性并提出观察指标。",
    inputParams: { universe: "US:sp500", topN: 5, theme: "防御行业轮动" },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },

  // ── Stock pick / portfolio ────────────────────────────────
  {
    id: "QB-SP-L-01",
    title: "动量与估值长仓选股",
    scenarioKey: "stock_pick",
    dimensions: CORE_DIMS,
    businessTags: ["stock_pick", "long"],
    goal: "从美股大盘选择 5 个兼具正向动量、合理估值和新闻催化的 long 候选；每个必须有入场、止损、止盈、仓位、失效条件和证据。",
    inputParams: { universe: "US:sp500", topN: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { minRequiredToolRecall: 0.6 },
  },
  {
    id: "QB-SP-L-02",
    title: "质量复利长仓选股",
    scenarioKey: "stock_pick",
    dimensions: CORE_DIMS,
    businessTags: ["stock_pick", "long", "quality"],
    goal: "寻找 5 个高 ROIC、现金流稳定且估值不过度透支的长期 long 候选，明确催化剂和估值下修风险。",
    inputParams: { universe: "US:sp500", topN: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { minRequiredToolRecall: 0.6 },
  },
  {
    id: "QB-PORT-01",
    title: "候选池组合构建",
    scenarioKey: "stock_pick",
    dimensions: CORE_DIMS,
    businessTags: ["portfolio", "allocation"],
    goal: "在筛选出的 long 候选上构建一个可解释的组合：给出候选列表、目标权重（candidates/allocation）、集中度约束与再平衡触发条件；禁止空 allocation。",
    inputParams: { universe: "US:sp500", topN: 8 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { minRequiredToolRecall: 0.5 },
  },
  {
    id: "QB-SP-S-01",
    title: "基本面恶化短仓筛选",
    scenarioKey: "stock_pick_short",
    dimensions: RISK_DIMS,
    businessTags: ["stock_pick", "short", "risk"],
    goal: "筛选 5 个业绩恶化、估值偏高或动量转弱的 short 候选；必须包含借券、保证金与轧空风险，而非只给负面观点。",
    inputParams: { universe: "US:sp500", topN: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-SP-S-02",
    title: "拥挤交易短仓风险评估",
    scenarioKey: "stock_pick_short",
    dimensions: RISK_DIMS,
    businessTags: ["stock_pick", "short", "crowding"],
    goal: "研究高估值且叙事拥挤标的的 short 机会，但若缺少空头数据必须拒绝给出虚假的确定性，并写清触发退出的条件。",
    inputParams: { universe: "US:sp500", topN: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },

  // ── Factor / strategy ─────────────────────────────────────
  {
    id: "QB-F-01",
    title: "动量因子构建与评估",
    scenarioKey: "factor",
    dimensions: CORE_DIMS,
    businessTags: ["factor", "momentum"],
    goal: "构建一个截面动量 alpha 因子，写明公式、经济学解释、universe 和 IC/IR 评估；数据不足时如实失败。",
    inputParams: { universe: "US:sp500", factorCategory: "momentum", horizonDays: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: { minRequiredToolRecall: 0.5 },
  },
  {
    id: "QB-F-02",
    title: "价值与质量复合因子",
    scenarioKey: "factor",
    dimensions: CORE_DIMS,
    businessTags: ["factor", "value", "quality"],
    goal: "构建一个价值与质量复合因子，避免使用未来数据；输出可计算表达式以及 IC、Rank IC 或 IR。",
    inputParams: { universe: "US:sp500", factorCategory: "value", horizonDays: 20 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-F-03",
    title: "短期反转因子与拥挤风险",
    scenarioKey: "factor",
    dimensions: CORE_DIMS,
    businessTags: ["factor", "reversal"],
    goal: "构建短期反转因子并评估其在高波动市场的稳定性，明确交易成本、换手与拥挤风险。",
    inputParams: { universe: "US:sp500", factorCategory: "reversal", horizonDays: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-ST-01",
    title: "多因子 long-only 策略",
    scenarioKey: "strategy",
    dimensions: CORE_DIMS,
    businessTags: ["strategy", "long_only"],
    goal: "组合价值、质量和动量因子形成 long-only 策略，给出 universe、调仓频率、仓位规则和回测假设。",
    inputParams: { ticker: "SPY", strategyHint: "价值+质量+动量 long-only", timeframe: "1d" },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-ST-02",
    title: "低波动防御策略",
    scenarioKey: "strategy",
    dimensions: CORE_DIMS,
    businessTags: ["strategy", "defensive"],
    goal: "设计一套低波动防御型 long-only 策略，说明最大行业暴露、仓位上限、再平衡条件与回测约束。",
    inputParams: { ticker: "SPY", strategyHint: "低波动防御 long-only", timeframe: "1d" },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-LS-01",
    title: "半导体多空配对策略",
    scenarioKey: "strategy_long_short",
    dimensions: RISK_DIMS,
    businessTags: ["strategy", "long_short"],
    goal: "设计半导体行业内的 long/short 配对策略，明确配对逻辑、净敞口、单边上限、借券与回测假设。",
    inputParams: {
      ticker: "NVDA,AMD,INTC",
      strategyHint: "半导体 long/short 配对",
      timeframe: "1d",
    },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-LS-02",
    title: "市场中性质量对冲策略",
    scenarioKey: "strategy_long_short",
    dimensions: RISK_DIMS,
    businessTags: ["strategy", "market_neutral"],
    goal: "构建市场中性的质量对冲策略，解释 long/short 选择、beta 控制、行业中性和极端行情止损。",
    inputParams: { ticker: "SPY", strategyHint: "市场中性质量 long/short", timeframe: "1d" },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
  },

  // ── Live / paper execution ────────────────────────────────
  {
    id: "QB-LT-01",
    title: "纸面做多订单意图与风控",
    scenarioKey: "live_trading",
    dimensions: RISK_DIMS,
    businessTags: ["execution", "paper", "long"],
    goal: "在纸面环境中生成一个做多 order_intent；必须先做 risk_decision，并把人工确认作为执行前条件，不得直接下实盘单。",
    inputParams: {
      capitalCap: 100000,
      killSwitchEnabled: true,
      confirmLevel: "manual_each",
      paperMode: true,
    },
    budget: EXECUTION_BUDGET,
    minRelevance: 0.3,
  },
  {
    id: "QB-LT-02",
    title: "纸面做空订单意图与借券风控",
    scenarioKey: "live_trading_short",
    dimensions: RISK_DIMS,
    businessTags: ["execution", "paper", "short"],
    goal: "在纸面环境中生成一个做空 order_intent；必须检查保证金、可借券和轧空风险，并要求人工确认，不得绕过 risk_decision。",
    inputParams: {
      capitalCap: 100000,
      killSwitchEnabled: true,
      confirmLevel: "manual_each",
      paperMode: true,
    },
    budget: EXECUTION_BUDGET,
    minRelevance: 0.3,
  },

  // ── Memory / thesis / Core path（v0.2 新增） ───────────────
  {
    id: "QB-MEM-01",
    title: "研究前记忆召回",
    scenarioKey: "research",
    dimensions: MEM_DIMS,
    businessTags: ["memory", "research"],
    goal: "研究 AAPL 前先用 memory.recall 检索项目内既有论点与历史结论；若有命中须在终答中引用或说明为何弃用；若无命中须明确写「无相关记忆」。",
    inputParams: { ticker: "AAPL", debateRounds: 1 },
    budget: RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: {
      requireMemoryRecall: true,
      minMemoryScore: 0.4,
      minRequiredToolRecall: 0.5,
    },
  },
  {
    id: "QB-MEM-02",
    title: "选股结合工作区记忆搜索",
    scenarioKey: "stock_pick",
    dimensions: MEM_DIMS,
    businessTags: ["memory", "stock_pick"],
    goal: "选股前先 workspace.memory.search 或 memory.recall 查找既有筛选规则/黑名单；将召回结果纳入候选过滤逻辑，禁止无视既有约束直接出 5 只票。",
    inputParams: { universe: "US:sp500", topN: 5 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.3,
    expectations: {
      requireMemoryRecall: true,
      minMemoryScore: 0.35,
      minRequiredToolRecall: 0.5,
    },
  },
  {
    id: "QB-TH-01",
    title: "带证据的投资论点写作",
    scenarioKey: "research",
    dimensions: FULL_DIMS,
    businessTags: ["thesis", "research", "memory"],
    goal: "为 NVDA 写一份可审计投资论点（thesis）：含方向、置信度、证据快照引用、主要风险与失效条件；先 recall 历史论点再写，置信度用 0–1 数值而非模糊形容词。",
    inputParams: { ticker: "NVDA", debateRounds: 1 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.4,
    expectations: {
      requireMemoryRecall: true,
      requireSpecialistInvoke: true,
      minMemoryScore: 0.35,
      minOrchestrationScore: 0.35,
      minRequiredToolRecall: 0.5,
    },
  },
  {
    id: "QB-ORCH-01",
    title: "编排器委派多角色研究",
    scenarioKey: "research_multi",
    dimensions: ORCH_DIMS,
    businessTags: ["orchestration", "core"],
    goal: "对 NVDA 与 AMD 做对比研究：编排器必须通过 agent.invoke 委派至少一名专家，并在终答中融合子任务叙事（不得只输出 invoke completed stub）。",
    inputParams: { ticker: "NVDA,AMD", debateRounds: 1 },
    budget: COMPLEX_RESEARCH_BUDGET,
    minRelevance: 0.35,
    expectations: {
      requireSpecialistInvoke: true,
      minOrchestrationScore: 0.5,
    },
  },
] as const;

export const QUBIT_BENCH_VERSION = "qubit-bench-v0.2";

export function getQubitBenchCase(id: string): QubitBenchCase {
  const benchmarkCase = QUBIT_BENCH_CASES.find((item) => item.id === id);
  if (!benchmarkCase) {
    throw new Error(`unknown_qubit_bench_case:${id}`);
  }
  return benchmarkCase;
}

/** 按业务标签或场景过滤（供 runner / 报告用）。 */
export function listQubitBenchCases(filter?: {
  tags?: string[];
  scenarioKey?: ScenarioKey;
  dimensions?: BenchmarkDimension[];
}): QubitBenchCase[] {
  return QUBIT_BENCH_CASES.filter((c) => {
    if (filter?.scenarioKey && c.scenarioKey !== filter.scenarioKey) return false;
    if (filter?.tags?.length) {
      const tags = new Set(c.businessTags ?? []);
      if (!filter.tags.some((t) => tags.has(t))) return false;
    }
    if (filter?.dimensions?.length) {
      if (!filter.dimensions.every((d) => c.dimensions.includes(d))) return false;
    }
    return true;
  });
}
