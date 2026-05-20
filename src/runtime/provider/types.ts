/**
 * Provider 抽象层 - 接口契约
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4
 *
 * 强制约束：业务模块（factor-service / rule-service / dispatcher / ...）
 * 不允许直接 import 具体实现（Qlib / VeighNa / Backtrader / JSONLogic …），
 * 必须 `providerResolver.resolve(kind, scope)` 获取实例。
 */

/** 所有支持的 Provider kind（与 schema 枚举一致） */
export type ProviderKind =
  | "factor_compute"
  | "factor_eval"
  | "rule_engine"
  | "backtest"
  | "live_ems"
  | "market_data"
  | "llm"
  | "factor_miner";

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
  lang: "qlib_expr" | "python" | "sql" | "jsonlogic";
  universe: string;
  symbols?: string[];
  startDate: string;
  endDate: string;
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

export interface FactorEvalResult {
  ic: number;
  rankIc: number;
  ir: number;
  turnover: number;
  decayCurve: number[];
  groupReturns: number[];
  sampleSize: number;
  latencyMs: number;
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
}

export interface BacktestRequest {
  strategyVersionId?: string;
  signals: BacktestSignalSpec;
  universe: string;
  symbols: string[];
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
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
  turnover: number;
}

export interface BacktestResult {
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  meta: {
    latencyMs: number;
    sampleSize: number;
    barCount: number;
    /** 因子值缺失的天数（横截面无可用 symbol） */
    skippedDays: number;
  };
  error?: string;
}

export interface BacktestProvider extends BaseProvider {
  /** 真正可计算回测的 Provider 实现此方法；fallback 留作占位 */
  run?(input: BacktestRequest): Promise<BacktestResult>;
}

// ─── live_ems ───

export type LiveOrderSide = "buy" | "sell";
export type LiveOrderType = "market" | "limit";
export type LiveOrderStatus =
  | "pending"
  | "submitted"
  | "partial_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface LiveOrderIntent {
  /** 系统侧的 intent_order_id（关联 OMS） */
  intentOrderId: string;
  /** broker 账户标识（如 "ibkr_paper" / "veighna_simnow"） */
  accountRef: string;
  symbol: string;
  exchange: string;
  side: LiveOrderSide;
  orderType: LiveOrderType;
  quantity: number;
  limitPrice?: number;
  /** 自由扩展字段（如 timeInForce / clientOrderRef） */
  meta?: Record<string, unknown>;
}

export interface LiveOrderAck {
  brokerOrderId: string;
  status: LiveOrderStatus;
  acceptedAt: string;
  /** 部分券商在 ack 即返回成交（市价单 + paper） */
  filledQty?: number;
  avgPrice?: number;
}

export interface LiveOrderStatusInfo {
  brokerOrderId: string;
  status: LiveOrderStatus;
  filledQty: number;
  avgPrice: number;
  updatedAt: string;
}

export interface LivePosition {
  symbol: string;
  exchange: string;
  quantity: number;
  avgCost: number;
  marketPrice?: number;
  unrealizedPnl?: number;
}

export interface LiveAccountSnapshot {
  accountRef: string;
  cash: number;
  equity: number;
  marginUsed: number;
  positions: LivePosition[];
  updatedAt: string;
}

/**
 * LiveEmsProvider —— 实盘 EMS（订单管理） Provider
 *
 * 可实现方包括：
 *   - VeighNa 子进程（接入国内/期货 broker）
 *   - 直连 broker REST/FIX（IBKR / Tiger / 老虎模拟盘）
 *   - 内存 paper-trade（MVP / 单测）
 */
export interface LiveEmsProvider extends BaseProvider {
  /** 提交订单到 broker；返回 brokerOrderId + 初始状态 */
  submitOrder?(intent: LiveOrderIntent): Promise<LiveOrderAck>;
  /** 撤单 */
  cancelOrder?(input: { brokerOrderId: string; accountRef: string }): Promise<{
    ok: boolean;
    status: LiveOrderStatus;
  }>;
  /** 查询订单状态 */
  getOrderStatus?(input: {
    brokerOrderId: string;
    accountRef: string;
  }): Promise<LiveOrderStatusInfo>;
  /** 拉取账户快照 + 持仓 */
  getAccountSnapshot?(input: { accountRef: string }): Promise<LiveAccountSnapshot>;
}

export interface MarketDataProvider extends BaseProvider {}
export interface LlmProvider extends BaseProvider {}
export interface FactorMinerProvider extends BaseProvider {}

/** Provider kind → 对应 specialized interface（编译期反射用） */
export interface ProviderKindMap {
  factor_compute: FactorComputeProvider;
  factor_eval: FactorEvaluationProvider;
  rule_engine: RuleEngineProvider;
  backtest: BacktestProvider;
  live_ems: LiveEmsProvider;
  market_data: MarketDataProvider;
  llm: LlmProvider;
  factor_miner: FactorMinerProvider;
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
