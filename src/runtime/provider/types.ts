/**
 * Provider 抽象层 - 接口契约
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4
 *
 * 强制约束：业务模块（factor-service / rule-service / dispatcher / ...）
 * 不允许直接 import 具体实现（Qlib / VeighNa / Backtrader / JSONLogic …），
 * 必须 `providerResolver.resolve(kind, scope)` 获取实例。
 */

/**
 * 所有支持的 Provider kind（与 schema 枚举一致）。
 *
 * P1-B（2026-05）下线：`live_ems` / `market_data` / `llm` / `factor_miner` 四类
 * 在落地一年多内 `providerResolver.resolve(...)` 调用数始终为 0，业务实际走 reia/
 * broker-connector / 直接 llm-router / 内嵌 factor 路径，Provider 抽象层从未承担过
 * 它们的解析责任。一并删掉对应 ProviderKindMap / 占位 interface / 内置 impl /
 * routes UI 枚举 / DB migration 0051 清旧 row，约 -1500 行死代码。
 */
export type ProviderKind = "factor_compute" | "factor_eval" | "rule_engine" | "backtest";

/** Provider 解析作用域；优先级见 §5.4.4 */
export type ProviderScope = {
  strategyVersionId?: string;
  workflowRunId?: string;
  projectId?: string;
};

export interface ProviderCapability {
  /** 支持的资产类型；空数组表示通用 */
  supportedAssetClasses?: Array<"stock" | "future" | "option" | "crypto" | "fx">;
  /** 支持的标的池；空数组表示通用 */
  supportedUniverses?: string[];
  /** 自由形式特性列表，业务侧按需查询，如 "tick_subscribe"、"intraday_bar"、"twap" */
  features?: string[];
  /** 性能等级提示（latency / throughput / cost），可选 */
  performanceProfile?: "realtime" | "neartime" | "batch";
  /** 其他元数据 */
  extra?: Record<string, unknown>;
}

export interface ProviderMeta {
  readonly kind: ProviderKind;
  readonly key: string;
  readonly displayName: string;
  readonly description?: string;
  readonly version: string;
  readonly capability: ProviderCapability;
  readonly isBuiltin?: boolean;
  readonly isFallback?: boolean;
}

/** 所有 Provider 实现的基接口 */
export interface BaseProvider {
  readonly meta: ProviderMeta;
  /** 是否就绪 + 健康度 */
  healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  /** 启动 / 配置更新时调用；hot reload 友好 */
  init?(config: Record<string, unknown>): Promise<void>;
  /** 关闭时调用（如断开长连接） */
  dispose?(): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────────
// 领域子接口（每个 ProviderKind 一个 specialized interface）
// 这里只先把 P0 阶段必需的两个（factor_compute、rule_engine）写出完整契约；
// 其它 kind 用 BaseProvider 占位，等对应阶段（P1/P2/P3/P4）落地时再补 specialized 接口。
// ──────────────────────────────────────────────────────────────────────────────

// ─── factor_compute ───
export interface FactorComputeRequest {
  factorId?: string;
  expr: string;
  lang: "qlib_expr" | "python" | "sql" | "jsonlogic" | "ml_score";
  universe: string;
  symbols?: string[];
  startDate: string;
  endDate: string;
  /** 提供后 Provider 只能使用这份不可变快照数据，禁止重新拉行情。 */
  dataset?: BacktestDataset;
  /**
   * factor_definition.definition_json 透传。
   * `lang=ml_score` 时必须含 `modelFactor` 绑定（见 model-factor-contract）。
   */
  definition?: Record<string, unknown>;
}

export interface FactorComputeRow {
  symbol: string;
  date: string;
  value: number | null;
}

export interface FactorComputeResult {
  rows: FactorComputeRow[];
  meta: {
    factorId?: string;
    rowCount: number;
    latencyMs: number;
    /** 因子计算数据谱系；未绑定快照的传统调用为空。 */
    datasetSnapshotId?: string;
    sourceIds?: string[];
    /** Fundamental fields use the first bar strictly after observation.availableAt. */
    fundamentalAvailabilityPolicy?: "first_bar_strictly_after_available_at";
    fundamentalFields?: string[];
    /** Provider 侧错误（空结果时）；不抛错以便上层选择 fallback / 留痕。 */
    error?: string;
    /** ml_score / external_ml 血缘摘要。 */
    modelFactor?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface FactorComputeProvider extends BaseProvider {
  validateExpr(expr: string, lang: string): Promise<{ ok: boolean; error?: string }>;
  compute(input: FactorComputeRequest): Promise<FactorComputeResult>;
}

// ─── factor_eval ───
export interface FactorEvalRequest {
  factorId: string;
  values: FactorComputeRow[];
  /** 主 horizon 的未来收益（与 values 同 symbol/date 对齐） */
  futureReturns?: FactorComputeRow[];
  horizonDays?: number;
  /** 多期未来收益：{ horizon → rows }，用于计算 decay curve */
  futureReturnsByHorizon?: Record<number, FactorComputeRow[]>;
  /** 分组数；默认 5 */
  groupCount?: number;
  benchmark?: string;
  universe: string;
}

export type FactorStatisticalReport = {
  version: "factor-statistical-validation-v2";
  dailyObservations: number;
  hacLag: number;
  ic: {
    mean: number;
    neweyWestStdError: number | null;
    tStatistic: number | null;
    pValue: number | null;
    positiveRate: number;
  };
  rankIc: {
    mean: number;
    neweyWestStdError: number | null;
    tStatistic: number | null;
    pValue: number | null;
    positiveRate: number;
  };
  /** Fixed, deterministic moving-block resampling over daily cross-sections. */
  blockBootstrap: {
    method: "moving_block_bootstrap_v1";
    simulations: number;
    blockLength: number;
    seed: string;
    ic: {
      confidenceInterval95: { lower: number; upper: number } | null;
      positiveProbability: number | null;
    };
    rankIc: {
      confidenceInterval95: { lower: number; upper: number } | null;
      positiveProbability: number | null;
    };
  };
  status: "passed" | "research_only";
  checks: Array<{
    key:
      | "minimum_daily_observations"
      | "ic_significance"
      | "rank_ic_significance"
      | "ic_block_bootstrap"
      | "rank_ic_block_bootstrap";
    state: "pass" | "unknown" | "fail";
    evidence: string;
  }>;
};

export type FactorIndependentValidationReport = {
  version: "factor-independent-validation-v1";
  datasetSnapshotId: string | null;
  split: {
    trainStartDate: string;
    trainLabelEndExclusive: string;
    validationStartDate: string;
    validationEndDate: string;
    purgeCalendarDays: number;
  };
  inSample: Pick<
    FactorEvalResult,
    "ic" | "rankIc" | "ir" | "sampleSize" | "error" | "statisticalReport"
  >;
  outOfSample: Pick<
    FactorEvalResult,
    "ic" | "rankIc" | "ir" | "sampleSize" | "error" | "statisticalReport"
  >;
  status: "passed" | "research_only";
  reasons: string[];
};

export interface FactorEvalResult {
  ic: number;
  rankIc: number;
  ir: number;
  turnover: number;
  decayCurve: number[];
  groupReturns: number[];
  sampleSize: number;
  latencyMs: number;
  /** Auditable inference over the daily cross-sectional IC time series. */
  statisticalReport?: FactorStatisticalReport;
  /** Explicit date holdout; populated by FactorService.autoEvaluate only. */
  independentValidation?: FactorIndependentValidationReport;
  error?: string;
}

export interface FactorEvaluationProvider extends BaseProvider {
  evaluate(input: FactorEvalRequest): Promise<FactorEvalResult>;
}

// ─── rule_engine ───
export interface RuleSpec {
  id?: string;
  lang: "jsonlogic" | "python";
  dsl: unknown;
  appliesTo: "select" | "filter" | "score" | "order" | "risk";
}

export interface RuleEvalContext {
  asof: string;
  universe: string;
  /** 已可用的因子值 map：{[symbol]: {[factorKey]: value}} */
  factorContext?: Record<string, Record<string, number | null>>;
  /** 行业 / 资产类型等附加字段 */
  extraContext?: Record<string, unknown>;
}

export interface RuleEvalSymbolOutcome {
  symbol: string;
  passed: boolean;
  score?: number;
  payload?: Record<string, unknown>;
}

export interface RuleEvalResult {
  symbols: RuleEvalSymbolOutcome[];
  metrics: {
    sampleSize: number;
    latencyMs: number;
  };
  error?: string;
}

export interface RuleEngineProvider extends BaseProvider {
  /** 注册时调用：纯语法校验（不执行） */
  parse(dsl: unknown, lang: string): Promise<{ ok: boolean; ast?: unknown; error?: string }>;
  /** 执行评估；ctx 包含因子上下文 */
  evaluate(rule: RuleSpec, ctx: RuleEvalContext): Promise<RuleEvalResult>;
}

// ─── backtest ───（M3 起为正式契约；保留 fallback Provider 兼容）
export type BacktestSignalSpec =
  | {
      kind: "factor_score";
      factorId?: string;
      expr: string;
      lang: "qlib_expr" | "python" | "sql" | "jsonlogic";
      /** 是否取反方向：true 表示因子值越小越好 */
      reverse?: boolean;
    }
  | {
      /** 多因子组合：每个因子先做当日截面排名标准化，再按权重合成分数。 */
      kind: "factor_composite";
      factors: Array<{
        factorId: string;
        expr: string;
        lang: "qlib_expr";
        weight: number;
      }>;
    }
  | {
      kind: "rule";
      rule: RuleSpec;
    }
  | {
      kind: "composition";
      compositionId: string;
    };

export interface BacktestCosts {
  /** 双边手续费基点（1bp = 0.01%） */
  commissionBps: number;
  /** 滑点基点（按下一个 open 撮合时叠加） */
  slippageBps: number;
  /** 每笔最低手续费 */
  minCommission?: number;
  /** 高级滑点/市场冲击模型 */
  slippageModel?: "fixed_bps" | "square_root" | "volatility_adjusted";
  /** 平方根冲击系数 gamma（默认 0.1） */
  impactCoefficient?: number;
  /** 最大单笔成交量参与率（如 0.10 表示不超过当根 Bar 10%） */
  maxVolumeParticipation?: number;
  /** 做空借券年化利率基点（如 200bps = 2%/年） */
  borrowRateAnnualBps?: number;
  /** 不可做空标的列表 */
  restrictedShortSymbols?: string[];
  /** 冻结成本模型的版本；缺失时结果不得作为验证级交易成本证据。 */
  costModelVersion?: string;
  /** 成本模型来源，例如交易所/券商费率表或经批准的研究假设。 */
  costModelSource?: string;
  /** 成本模型生效或抓取时点（ISO-8601）；与版本一起构成可审计证据。 */
  costModelAsOf?: string;
}

/**
 * 不可变市场快照绑定。回测 Provider 必须只读取此数据集，不能在运行过程中再次拉取
 * "今天" 的行情；这使同一配置可以在未来复算得到同一输入。
 */
export interface BacktestDatasetBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  /** 衍生品官方结算价；缺省时只能退化为 close。 */
  settlementPrice?: number;
  /** 永续合约本期资金费率（bps，正数表示多头支付空头）。 */
  fundingRateBps?: number;
  /** 期权快照的年化隐含波动率（小数），用于逐期 Greeks 审计。 */
  impliedVolatility?: number;
  /** 同期无风险年化利率（小数）；未给出时不计算 Greeks。 */
  riskFreeRateAnnual?: number;
  /** 数据源显式标记该 Bar 是否可成交；false 表示停牌或交易中断。 */
  tradable?: boolean;
  /** 停牌语义别名，优先级高于 tradable。 */
  suspended?: boolean;
  /** 该交易日价格上限；买入触及上限时无法按 open 成交。 */
  priceLimitUp?: number;
  /** 该交易日价格下限；卖出触及下限时无法按 open 成交。 */
  priceLimitDown?: number;
}

export type BacktestAssetClass = "stock" | "future" | "option" | "crypto";

/**
 * 回测所需的 point-in-time 合约元数据。衍生品不得仅凭 symbol 猜测这些字段；
 * 请求必须把当时可知的合约定义与行情快照一起冻结。
 */
export interface BacktestInstrumentSpec {
  assetClass: BacktestAssetClass;
  /** crypto 可区分现货与永续；其余资产由 assetClass 决定。 */
  contractKind?: "spot" | "perpetual";
  /** 每份合约对应的标的数量。股票/币现货缺省为 1。 */
  contractMultiplier?: number;
  /** 最小成交数量；缺省保持现有的可分数成交行为。 */
  lotSize?: number;
  /** 期货初始保证金率，例如 0.12 表示名义金额的 12%。 */
  initialMarginRate?: number;
  /** 期货维持保证金率，必须不高于初始保证金率。 */
  maintenanceMarginRate?: number;
  /** 用于把策略权重转换为期货名义敞口的目标杠杆；缺省为 1 倍。 */
  targetLeverage?: number;
  /** 期权/期货最后交易日（YYYY-MM-DD）。 */
  expiryDate?: string;
  settlementMode?: "cash" | "physical";
  underlyingSymbol?: string;
  strike?: number;
  optionRight?: "call" | "put";
  exerciseStyle?: "european" | "american";
  /** 当前仅支持可审计的 Black–Scholes 欧式风险近似。 */
  pricingModel?: "black_scholes";
  /**
   * 显式期货换月指令。仅支持在 rollDate 开盘平旧仓、开新仓；不得从连续合约名称猜测。
   */
  futureRoll?: {
    rollDate: string;
    successorSymbol: string;
  };
}

export interface BacktestDataset {
  snapshotId: string;
  dataRef: string;
  asOf: string;
  timeframe: string;
  sourceIds: string[];
  /** 日历本身也是市场快照的一部分；不能从缺失 Bar 反推节假日或开市状态。 */
  tradingCalendar?: {
    version?: string;
    timezone?: string;
    /** symbol → YYYY-MM-DD → explicit exchange session state from the frozen snapshot. */
    sessionsBySymbol?: Record<string, Record<string, "open" | "closed">>;
    /** symbol → session date → explicitly frozen intraday open/close windows. */
    sessionWindowsBySymbol?: Record<
      string,
      Record<string, Array<{ openAt: string; closeAt: string; label?: string }>>
    >;
  };
  /** Immutable provenance for the IV and risk-free-rate inputs used by option risk audit. */
  derivativePricing?: {
    version: string;
    source: string;
    asOf: string;
    impliedVolatilityMethod: "market_quote" | "surface_interpolated";
    riskFreeRateMethod: "explicit_term_rate" | "zero_curve_interpolated";
  };
  /** Corporate actions projected from the frozen ledger for PIT audit. */
  corporateActionEvents?: Array<{
    symbol: string;
    effectiveDate: string;
    knownAt: string;
    kind: string;
    cashAmount?: number;
  }>;
  /** Fundamental revisions projected from the frozen ledger for PIT audit. */
  fundamentalObservations?: Array<{
    symbol: string;
    metric: string;
    fiscalPeriodEnd: string;
    availableAt: string;
    value: number;
    revisionId?: string;
  }>;
  /** key 是请求时的 symbol；已在提交时按请求区间裁剪。 */
  barsBySymbol: Record<string, BacktestDatasetBar[]>;
  /**
   * 数据资格不等于策略表现：缺历史成分或企业行为版本时，结果只能用于研究，
   * 不能被后续执行/晋级流程误认为已通过 production-grade 验证。
   */
  qualification: {
    useClass: "research_only" | "strategy_validation";
    universeHistory: "verified" | "not_verified";
    corporateActions: "verified" | "raw_unadjusted" | "not_verified";
    pointInTime: "verified" | "not_verified";
    limitations: string[];
    /** References to the frozen historical source tables when validation evidence is supplied. */
    universeHistoryRef?: { universeId: string; version: string; source: string; asOf: string };
    corporateActionLedgerRef?: { version: string; source: string; asOf: string };
    fundamentalLedgerRef?: { version: string; source: string; asOf: string };
  };
}

export interface BacktestRequest {
  strategyVersionId?: string;
  /** 非空且已校验存在的不可变行情快照。 */
  dataset: BacktestDataset;
  signals: BacktestSignalSpec;
  universe: string;
  symbols: string[];
  /** symbol → 冻结的合约定义；未提供的 symbol 仅按普通股票兼容处理。 */
  instruments?: Record<string, BacktestInstrumentSpec>;
  startDate: string;
  endDate: string;
  capital: number;
  costs: BacktestCosts;
  rebalance?: "daily" | "weekly" | "monthly";
  /** 多头 N 名（横截面 top-N，缺省为全市场等权） */
  topN?: number;
  /** 是否做多空对冲 */
  longShort?: boolean;
  /** 基准 symbol（如 "000300.SH"），用于 alpha/相对收益 */
  benchmark?: string;
  /** Explicit experiment provenance; omission stays unknown in integrity reports. */
  experiment?: {
    parameterSelection: "fixed_before_run" | "full_sample_optimized" | "unknown";
    preRegistrationId?: string;
    /** Number of candidate specifications inspected in the same hypothesis family. */
    candidateTrials?: number;
  };
}

export interface BacktestEquityPoint {
  date: string;
  equity: number;
  benchmarkEquity?: number;
}

export interface BacktestTrade {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  commission: number;
}

export interface BacktestMetrics {
  totalReturn: number;
  annualReturn: number;
  annualVol: number;
  sharpe: number;
  sortino?: number;
  downsideDeviation?: number;
  maxDrawdown: number;
  maxDrawdownDuration?: number;
  calmar?: number;
  ulcerIndex?: number;
  /** 单期历史 VaR / CVaR（95%，均为正的潜在损失比例）。 */
  valueAtRisk95?: number;
  conditionalValueAtRisk95?: number;
  positivePeriodRate?: number;
  maxConsecutiveLosses?: number;
  returnSkewness?: number;
  excessKurtosis?: number;
  winRate: number;
  tradeCount: number;
  turnover: number;
  totalCommission?: number;
  /** 基准存在时给出 Alpha/Beta、信息比率和捕获率。 */
  benchmark?: {
    totalReturn: number;
    annualReturn: number;
    beta: number;
    alpha: number;
    correlation: number;
    informationRatio: number;
    trackingError: number;
    upCapture: number | null;
    downCapture: number | null;
    observations: number;
  } | null;
}

export interface BacktestResult {
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  meta: {
    latencyMs: number;
    sampleSize: number;
    barCount: number;
    /** Frequency-aware annualization denominator used for return/volatility metrics. */
    periodsPerYear?: number;
    executionTimeframe?: string;
    /** 因子值缺失的天数（横截面无可用 symbol） */
    skippedDays: number;
    datasetQualification?: BacktestDataset["qualification"];
    antiLeakageReport?: import("../backtest/anti-leakage-report").BacktestIntegrityReport;
    pitReport?: import("../backtest/pit-verifier").PitAuditReport;
    /** Point-in-time fundamental inputs used by an expression-driven backtest. */
    fundamentalAvailabilityPolicy?: "first_bar_strictly_after_available_at";
    fundamentalFields?: string[];
    statisticalValidationReport?: import(
      "../backtest/statistical-validation-report"
    ).BacktestStatisticalValidationReport;
    assetLifecycleReport?: import("../backtest/asset-lifecycle-model").AssetLifecycleReport;
    assetLifecycleEvents?: import("../backtest/asset-lifecycle-model").AssetLifecycleEvent[];
  };
  error?: string;
}

export interface BacktestProvider extends BaseProvider {
  /** 真正可计算回测的 Provider 实现此方法；fallback 留作占位 */
  run?(input: BacktestRequest): Promise<BacktestResult>;
}

/** Provider kind → 对应 specialized interface（编译期反射用） */
export interface ProviderKindMap {
  factor_compute: FactorComputeProvider;
  factor_eval: FactorEvaluationProvider;
  rule_engine: RuleEngineProvider;
  backtest: BacktestProvider;
}

export class ProviderError extends Error {
  constructor(
    public code:
      | "not_found"
      | "disabled"
      | "no_fallback"
      | "init_failed"
      | "capability_missing"
      | "validation_failed"
      | "invalid_kind",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
