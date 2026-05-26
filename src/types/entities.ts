/**
 * ERD V1.2 entity types — mirrors the Drizzle schema definitions.
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
  // V1 roles
  | "orchestrator"
  | "market_data"
  | "news_event"
  | "research"
  | "backtest"
  | "simulation"
  | "risk"
  | "execution"
  | "memory"
  | "audit"
  // V2 analyst team roles
  | "analyst_fundamental"
  | "analyst_technical"
  | "analyst_sentiment"
  | "analyst_macro"
  | "researcher_bull"
  | "researcher_bear"
  | "risk_manager"
  | "portfolio_manager"
  | "stock_screener"
  | "backtest_engineer"
  | "execution_trader"
  | "memory_curator";

/** 与 `agent_definition.role` / 工作区 agents.json 对齐，用于校验与 UI 枚举 */
export const ALL_AGENT_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "market_data",
  "news_event",
  "research",
  "backtest",
  "simulation",
  "risk",
  "execution",
  "memory",
  "audit",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "researcher_bull",
  "researcher_bear",
  "risk_manager",
  "portfolio_manager",
  "stock_screener",
  "backtest_engineer",
  "execution_trader",
  "memory_curator",
];

// ─── V2 分析师信号域 ──────────────────────────────────────────────────────────

export type AnalystSignalValue = "buy" | "sell" | "hold";

export interface AnalystSignal {
  id: string;
  workflowRunId: string;
  agentInstanceId: string;
  analystRole: AgentRole;
  ticker: string;
  signal: AnalystSignalValue;
  confidence: number;
  reasoning: string;
  dataSnapshotJson: unknown;
  createdAt: string;
}

/**
 * P2-F 命名空间化：原 `SignalFusionResult` 名字泛化，与 backtest signal 域容易混。
 * 这里特指多 Analyst 信号经 MSA 融合后的最终结果（DB row 视图）。
 */
export interface AnalystSignalFusionResult {
  id: string;
  workflowRunId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  weightsJson: unknown;
  debateTriggered: boolean;
  createdAt: string;
}

/** @deprecated 用 `AnalystSignalFusionResult` */
export type SignalFusionResult = AnalystSignalFusionResult;

export interface AgentRoleCatalog {
  role: string;
  displayName: string;
  description: string;
  defaultPromptTemplate: string;
  team: string;
  isBuiltin: boolean;
}

export interface AnalystAccuracyLog {
  id: string;
  definitionId: string;
  ticker: string;
  signalDate: number;
  predictedSignal: AnalystSignalValue;
  actualOutcome: "up" | "down" | "flat" | null;
  isCorrect: number | null;
  evaluatedAt: number | null;
}

export interface AgentDefinition {
  id: string;
  role: AgentRole;
  name: string;
  version: string;
  systemPrompt: string;
  toolsJson: unknown;
  mcpServersJson: unknown;
  skillsJson: unknown;
  subscriptionsJson: unknown;
  llmProvider: string;
  maxIterations: number;
  sandboxPolicyId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInstance {
  id: string;
  definitionId: string;
  workflowRunId: string;
  status: "idle" | "running" | "error" | "stopped";
  currentIteration: number;
  startedAt: string | null;
  endedAt: string | null;
  errorMessage: string | null;
}

export interface AgentStep {
  id: string;
  agentInstanceId: string;
  workflowRunId: string;
  stepIndex: number;
  phase: "perceive" | "reason" | "act" | "observe" | "external";
  thought: string | null;
  actionType: "tool_call" | "final_answer" | "memory_read" | "memory_write" | "a2a_send" | "cli_io";
  actionJson: unknown;
  observationJson: unknown | null;
  tokenCount: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface ToolCallLog {
  id: string;
  agentStepId: string;
  toolName: string;
  toolKind: "acp_connector" | "mcp" | "skill" | "builtin";
  requestJson: unknown;
  responseJson: unknown | null;
  status: "success" | "error" | "timeout" | "sandbox_blocked";
  latencyMs: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface SandboxPolicy {
  id: string;
  name: string;
  description: string;
  allowedToolsJson: unknown;
  allowedMcpServersJson: unknown;
  allowedConnectorsJson: unknown;
  allowedHostsJson: unknown;
  allowedFsPathsJson: unknown;
  canWriteMemory: boolean;
  canReadLiveMarket: boolean;
  canSubmitOrder: boolean;
  maxToolCallMs: number;
  maxIterationsPerRun: number;
  maxOutputTokens: number;
  isolationLevel: "none" | "process" | "vm";
  createdAt: string;
  updatedAt: string;
}

export interface SandboxViolationLog {
  id: string;
  agentInstanceId: string;
  workflowRunId: string;
  violationType:
    | "tool_not_allowed"
    | "mcp_not_allowed"
    | "network_blocked"
    | "fs_blocked"
    | "timeout"
    | "iteration_exceeded";
  attemptedAction: unknown;
  sandboxPolicyId: string;
  createdAt: string;
}

export interface LlmProviderConfig {
  id: string;
  providerId: string;
  providerType: "openai" | "anthropic" | "ollama" | "custom";
  baseUrl: string | null;
  modelName: string;
  apiKeyRef: string | null;
  contextWindow: number;
  supportsFunctionCalling: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http" | "ws";
  command: string | null;
  url: string | null;
  capabilitiesJson: unknown;
  enabled: boolean;
  createdAt: string;
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
  senderInstanceId: string;
  receiverInstanceId: string | null;
  messageType: A2AMessageType;
  payloadJson: unknown;
  priority: number;
  createdAt: string;
}

export type ConnectorTargetKind = "skill" | "mcp" | "tool" | "connector";

export interface AcpCall {
  id: string;
  workflowRunId: string;
  agentStepId: string | null;
  traceId: string;
  callerInstanceId: string;
  targetKind: ConnectorTargetKind;
  targetName: string;
  intent: string;
  inputSchemaVersion: string;
  outputSchemaVersion: string | null;
  latencyMs: number | null;
  status: "success" | "error" | "timeout" | "blocked_by_sandbox";
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
  ownerInstanceId: string | null;
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
  agentInstanceId: string | null;
  datasetSnapshotId: string;
  metricJson: unknown;
  resultSummary: string;
  createdAt: string;
}

export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface BacktestRun {
  id: string;
  strategyVersionId: string;
  agentInstanceId: string | null;
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
  agentInstanceId: string | null;
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
  agentInstanceId: string | null;
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
  acpCallId: string | null;
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
  definitionId?: string | null;
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
  definitionId?: string | null;
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
  workflowRunId: string | null;
  agentInstanceId: string | null;
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

// ─── M11: Agent 自进化（skill 程序性记忆 + curator + evolution）────────────────

export type AgentSkillSource = "agent_created" | "user_authored" | "open_skill_market" | "evolved";
export type AgentSkillState = "active" | "stale" | "archived" | "pending_review";
export type AgentSkillOutcome = "success" | "fail" | "partial" | "unknown";

export interface AgentSkill {
  id: string;
  projectId: string;
  definitionId: string | null;
  name: string;
  description: string;
  bodyMd: string;
  category: string;
  version: string;
  parentSkillId: string | null;
  source: AgentSkillSource;
  externalInstallId: string | null;
  state: AgentSkillState;
  pinned: boolean;
  useCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  metadataJson: unknown;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSkillRun {
  id: string;
  skillId: string;
  workflowRunId: string | null;
  agentInstanceId: string | null;
  definitionId: string | null;
  outcome: AgentSkillOutcome;
  score: number | null;
  notes: string;
  startedAt: string;
  endedAt: string | null;
}

export type SkillCuratorMode = "dry_run" | "live";
export type SkillCuratorStatus = "running" | "completed" | "failed";

export interface SkillCuratorRun {
  id: string;
  projectId: string;
  mode: SkillCuratorMode;
  status: SkillCuratorStatus;
  triggeredBy: string;
  totalChecked: number;
  markedStale: number;
  archived: number;
  consolidated: number;
  pruned: number;
  summaryText: string;
  summaryYaml: string;
  actionsJson: unknown;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
}

export type SkillEvolutionStatus = "running" | "completed" | "failed";

export interface SkillEvolutionRun {
  id: string;
  projectId: string;
  baseSkillId: string;
  datasetId: string | null;
  iterations: number;
  candidatesEvaluated: number;
  baselineScore: number | null;
  bestScore: number | null;
  winningSkillId: string | null;
  status: SkillEvolutionStatus;
  reportJson: unknown;
  errorMessage: string | null;
  triggeredBy: string;
  startedAt: string;
  endedAt: string | null;
}
