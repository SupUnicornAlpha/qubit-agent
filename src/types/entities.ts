/**
 * ERD V1 entity types — mirrors the Drizzle schema definitions.
 * All IDs are nanoid strings unless noted otherwise.
 */

// ─── 2.1 组织与任务域 ────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  marketScope: string; // A股 / 期货 / 期权 / 港美股 etc.
  status: "active" | "archived" | "paused";
  createdAt: string;
}

export type WorkflowMode = "research" | "backtest" | "simulation" | "live";
export type WorkflowStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  projectId: string;
  sessionId: string | null;
  goal: string;
  mode: WorkflowMode;
  status: WorkflowStatus;
  startedAt: string;
  endedAt: string | null;
}

// ─── 2.2 Agent 与通信域 ──────────────────────────────────────────────────────

export type AgentRole =
  | "orchestrator"
  | "market_data"
  | "news_event"
  | "research"
  | "backtest"
  | "simulation"
  | "risk"
  | "execution"
  | "memory"
  | "audit";

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  version: string;
  status: "idle" | "running" | "error" | "stopped";
}

export type A2AMessageType =
  | "TASK_ASSIGN"
  | "TASK_RESULT"
  | "RISK_BLOCK"
  | "ORDER_INTENT"
  | "MODEL_UPDATE"
  | "MEMORY_WRITE"
  | "ALERT";

export interface A2AMessage {
  id: string;
  workflowRunId: string;
  traceId: string;
  senderAgentId: string;
  receiverAgentId: string;
  messageType: A2AMessageType;
  payloadJson: unknown;
  priority: number;
  createdAt: string;
}

export type ConnectorTargetKind = "skill" | "mcp" | "tool" | "connector";

export interface AcpCall {
  id: string;
  workflowRunId: string;
  traceId: string;
  callerAgentId: string;
  targetKind: ConnectorTargetKind;
  targetName: string;
  intent: string;
  inputSchemaVersion: string;
  outputSchemaVersion: string | null;
  latencyMs: number | null;
  status: "success" | "error" | "timeout";
  errorCode: string | null;
  createdAt: string;
}

// ─── 2.3 策略研究与回测域 ────────────────────────────────────────────────────

export type StrategyStyle = "low_freq" | "mid_freq" | "high_freq" | "options" | "futures";

export interface Strategy {
  id: string;
  projectId: string;
  name: string;
  style: StrategyStyle;
  description: string;
  ownerAgentId: string;
  createdAt: string;
}

export interface StrategyVersion {
  id: string;
  strategyId: string;
  versionTag: string;
  logicHash: string;
  paramSchemaJson: unknown;
  createdAt: string;
}

export type FactorCategory = "value" | "momentum" | "volatility" | "news" | "quality" | "macro";

export interface FactorDefinition {
  id: string;
  projectId: string;
  name: string;
  category: FactorCategory;
  definitionJson: unknown;
  createdAt: string;
}

export interface ResearchExperiment {
  id: string;
  strategyVersionId: string;
  datasetSnapshotId: string;
  metricJson: unknown;
  resultSummary: string;
  createdAt: string;
}

export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface BacktestRun {
  id: string;
  strategyVersionId: string;
  connectorInstanceId: string;
  datasetSnapshotId: string;
  configJson: unknown;
  performanceJson: unknown | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface SimulationRun {
  id: string;
  strategyVersionId: string;
  connectorInstanceId: string;
  paperAccountId: string;
  performanceJson: unknown | null;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
}

// ─── 2.4 市场数据与快照域 ────────────────────────────────────────────────────

export type AssetClass = "stock" | "future" | "option" | "crypto" | "fx";

export interface Instrument {
  id: string;
  symbol: string;
  assetClass: AssetClass;
  exchange: string;
  metaJson: unknown;
}

export type DataSourceType = "market" | "news" | "fundamental" | "event";

export interface MarketDataSource {
  id: string;
  name: string;
  sourceType: DataSourceType;
  vendor: string;
  status: "active" | "inactive" | "error";
}

export interface DatasetSnapshot {
  id: string;
  projectId: string;
  sourceId: string;
  asofTime: string;
  rangeStart: string;
  rangeEnd: string;
  schemaVersion: string;
  locationUri: string;
  qualityScore: number | null;
}

export interface NewsEvent {
  id: string;
  sourceId: string;
  instrumentId: string | null;
  publishedAt: string;
  eventType: string;
  sentimentScore: number | null;
  contentRef: string;
}

// ─── 2.5 交易执行与风控域 ────────────────────────────────────────────────────

export interface TradingAccount {
  id: string;
  broker: string;
  marketScope: string;
  mode: "paper" | "live";
  status: "active" | "inactive" | "suspended";
}

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type TimeInForce = "day" | "gtc" | "ioc" | "fok";

export interface OrderIntent {
  id: string;
  workflowRunId: string;
  strategyVersionId: string;
  instrumentId: string;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  price: number | null;
  timeInForce: TimeInForce;
  intentTime: string;
}

export type RiskScope = "pre_trade" | "intra_trade" | "post_trade";
export type RiskSeverity = "block" | "warn" | "info";

export interface RiskRule {
  id: string;
  projectId: string;
  name: string;
  scope: RiskScope;
  ruleExpr: string;
  severity: RiskSeverity;
  enabled: boolean;
  version: number;
}

export type RiskDecisionResult = "allow" | "block" | "review";

export interface RiskDecision {
  id: string;
  orderIntentId: string;
  riskRuleId: string;
  decision: RiskDecisionResult;
  reason: string;
  evaluatedAt: string;
  signature: string;
}

export type BrokerOrderStatus =
  | "submitted"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired";

export interface BrokerOrder {
  id: string;
  orderIntentId: string;
  accountId: string;
  connectorInstanceId: string;
  brokerOrderId: string;
  status: BrokerOrderStatus;
  submittedAt: string;
  updatedAt: string;
}

export interface Fill {
  id: string;
  brokerOrderId: string;
  fillQty: number;
  fillPrice: number;
  fee: number;
  filledAt: string;
}

export interface PositionSnapshot {
  id: string;
  accountId: string;
  instrumentId: string;
  qty: number;
  avgPrice: number;
  mtmPnl: number;
  snapshotTime: string;
}

// ─── 2.6 插件接入域 ──────────────────────────────────────────────────────────

export type ConnectorType = "data" | "research" | "backtest" | "execution" | "risk" | "memory";
export type LatencyProfile = "realtime" | "neartime" | "batch";

export interface ConnectorSpec {
  id: string;
  name: string;
  connectorType: ConnectorType;
  version: string;
  capabilitiesJson: unknown;
  assetClassesJson: unknown;
  latencyProfile: LatencyProfile;
  schemaContractJson: unknown;
}

export interface ConnectorInstance {
  id: string;
  specId: string;
  env: "dev" | "staging" | "prod";
  configRef: string;
  status: "active" | "inactive" | "error";
  lastHealthcheckAt: string | null;
}

export type ConnectorOperation = "init" | "healthcheck" | "execute" | "shutdown";

export interface ConnectorCallLog {
  id: string;
  connectorInstanceId: string;
  traceId: string;
  operation: ConnectorOperation;
  requestJson: unknown;
  responseJson: unknown | null;
  latencyMs: number;
  status: "success" | "error" | "timeout";
  createdAt: string;
}

// ─── 2.7 记忆域 ──────────────────────────────────────────────────────────────

export interface SessionMemory {
  id: string;
  workflowRunId: string;
  summary: string;
  stateJson: unknown;
  asofTime: string;
  ttlAt: string;
  updatedAt: string;
}

export type MidtermMemoryType =
  | "strategy_iteration"
  | "risk_review"
  | "simulation_note"
  | "param_scan";

export interface MidtermMemory {
  id: string;
  projectId: string;
  memoryType: MidtermMemoryType;
  contentJson: unknown;
  timeWindowStart: string;
  timeWindowEnd: string;
  asofTime: string;
  score: number | null;
  updatedAt: string;
}

export type LongtermMemoryType =
  | "factor_archive"
  | "regime"
  | "playbook"
  | "postmortem"
  | "execution_profile";

export type LongtermScope = "org" | "project" | "strategy";

export interface LongtermMemory {
  id: string;
  scope: LongtermScope;
  scopeId: string;
  memoryType: LongtermMemoryType;
  contentJson: unknown;
  embeddingRef: string | null;
  artifactUri: string | null;
  validFrom: string;
  validTo: string | null;
  asofTime: string;
  confidenceScore: number | null;
  updatedAt: string;
}

export type MemoryLayer = "session" | "midterm" | "longterm";
export type MemoryLinkRelation =
  | "derive_from"
  | "summarize_to"
  | "evidence_of"
  | "conflicts_with";

export interface MemoryLink {
  id: string;
  fromType: MemoryLayer;
  fromId: string;
  toType: MemoryLayer;
  toId: string;
  relation: MemoryLinkRelation;
  weight: number;
  createdAt: string;
}

export type ExternalMemoryConnectorType = "mem0" | "graphrag" | "custom";
export type MemoryWriteMode = "dual_write" | "external_only" | "native_only";

export interface MemoryBackendConfig {
  id: string;
  workspaceId: string;
  connectorType: ExternalMemoryConnectorType;
  enabled: boolean;
  writeMode: MemoryWriteMode;
  connectorInstanceId: string;
  configRef: string;
  fallbackToNative: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MemorySyncOperation = "add" | "update" | "delete" | "search";
export type MemorySyncStatus = "success" | "failed" | "degraded";

export interface MemorySyncLog {
  id: string;
  memoryBackendConfigId: string;
  sourceType: MemoryLayer;
  sourceId: string;
  operation: MemorySyncOperation;
  status: MemorySyncStatus;
  latencyMs: number | null;
  errorDetail: string | null;
  createdAt: string;
}

// ─── 2.8 审计与可观测域 ──────────────────────────────────────────────────────

export type AuditActorType = "agent" | "user" | "system";

export interface AuditLog {
  id: string;
  traceId: string;
  workflowRunId: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detailJson: unknown;
  createdAt: string;
}

export type MetricScopeType = "agent" | "connector" | "strategy" | "account";

export interface MetricTimeseries {
  id: string;
  scopeType: MetricScopeType;
  scopeId: string;
  metricName: string;
  metricValue: number;
  timestamp: string;
}
