/** OHLCV bar from `GET /api/v1/market/klines`（与后端 BarData 对齐） */
export interface KlineBar {
  symbol: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  timestamp: string;
}

export interface KlinesResponseMeta {
  timeframe: string;
  period: string;
  dataSource:
    | "tushare_daily"
    | "yahoo_chart"
    | "eastmoney"
    | "akshare"
    | "yfinance"
    | "binance_crypto"
    | "wind"
    | "synthetic";
  requestedLimit: number;
  returned: number;
}

export interface MarketDataReadiness {
  status: "checking" | "ready" | "degraded" | "down";
  checkedAt: string | null;
  healthySources: string[];
  readyMarkets: string[];
  targetMarkets: string[];
  message: string;
}

export interface MarketDataSourceRecord {
  id: string;
  name: string;
  vendor: string;
  status: "active" | "inactive" | "error";
  supportedMarkets: string[];
  supportedTimeframes: string[];
  credentialMode: "none" | "token" | "account" | "terminal" | string;
  credentialsReady: boolean;
  healthStatus: "unknown" | "healthy" | "degraded" | "down";
  lastHealthcheckAt: string | null;
  successRate: number | null;
  p95LatencyMs: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  circuitState: "closed" | "open" | "half_open";
  circuitOpenedAt: string | null;
  priority: number;
  isFallback: boolean;
  upstreamFamily: "wind" | "tushare" | "binance" | "eastmoney" | "tencent" | "yahoo";
  failureKind: "credentials_missing" | "network_blocked" | "rate_limited" | "upstream_down" | "no_data" | "misconfigured" | "unknown" | null;
  availabilityStatus: "ready" | "credentials_missing" | "backing_off" | "misconfigured" | "unavailable";
  retryAt: string | null;
  networkMode: "auto" | "direct" | "proxy";
  networkRoute: "direct" | "config" | "environment" | "system" | "invalid";
}

export interface WindSessionStatus {
  connected: boolean;
  userId: string | null;
  lastLoginAt: string | null;
  message: string;
  hasCredentials: boolean;
}

/** `GET /market/klines` 无数据或失败时的包装错误 */
export interface KlinesErrorPayload {
  type:
    | "klines_empty"
    | "klines_invalid_request"
    | "klines_connector_unavailable"
    | "klines_upstream_failed";
  code: string;
  message: string;
  hint?: string;
}

/** `GET /api/v1/market/news-brief` 单条资讯 */
export interface MarketNewsBriefItem {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  source: string;
  url?: string;
}

export interface MarketNewsBriefPayload {
  sectorLabel: string | null;
  sectorHeadlineTicker: string | null;
  symbolNews: MarketNewsBriefItem[];
  sectorNews: MarketNewsBriefItem[];
}

export type WorkflowMode = "research" | "backtest" | "simulation" | "live";

export type RecommendationSide = "long" | "short" | "neutral";
export type RecommendationStatus = "draft" | "active" | "closed" | "expired" | "invalidated";

export interface RecommendationOutcomeRecord {
  id: string;
  recommendationId: string;
  horizonDays: number;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  returnPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
  stopLossTriggered: boolean | null;
  takeProfitTriggered: boolean | null;
  ambiguousBar: boolean;
  barsObserved: number;
  evaluationError: string | null;
  outcome: "pending" | "win" | "loss" | "flat" | "invalid";
  evaluatedAt: string | null;
}

export interface RecommendationRecord {
  id: string;
  workflowRunId: string;
  projectId: string;
  scenarioKey: string;
  symbol: string;
  market: string;
  side: RecommendationSide;
  horizonDays: number;
  confidence: number;
  score: number | null;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  positionSizePct: number | null;
  riskRewardRatio: number | null;
  rationale: string;
  evidenceJson: unknown[];
  invalidationJson: unknown[];
  watchConditionsJson: unknown[];
  benchmarkSymbol: string | null;
  status: RecommendationStatus;
  expiresAt: string | null;
  dataAsof: string | null;
  asof: string;
  outcomes: RecommendationOutcomeRecord[];
  outcome: RecommendationOutcomeRecord | null;
}

export interface RecommendationCalibrationBin {
  minConfidence: number;
  maxConfidence: number;
  count: number;
  avgConfidence: number | null;
  accuracyPct: number | null;
}

export interface RecommendationHorizonStats {
  horizonDays: number;
  total: number;
  mature: number;
  pending: number;
  directional: number;
  wins: number;
  losses: number;
  flat: number;
  invalid: number;
  winRatePct: number | null;
  avgReturnPct: number | null;
  avgExcessReturnPct: number | null;
  avgMaePct: number | null;
  avgMfePct: number | null;
  stopLossTriggerRatePct: number | null;
  takeProfitTriggerRatePct: number | null;
  brierScore: number | null;
  ece: number | null;
  calibrationBins: RecommendationCalibrationBin[];
}

export interface RecommendationStats {
  total: number;
  active: number;
  mature: number;
  pending: number;
  directional: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgReturnPct: number | null;
  avgExcessReturnPct: number | null;
  stopLossTriggerRatePct: number | null;
  takeProfitTriggerRatePct: number | null;
  horizonStats: RecommendationHorizonStats[];
}

export type AgentLoopKind = "native" | "claude_cli" | "codex_cli";
export type AgentControlMode = "agent" | "plan" | "goal";

export interface LoopOptionsJson {
  command?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  injectMcpBridge?: boolean;
  maxOutputBytes?: number;
  /**
   * @deprecated v1 兼容字段，前端自 P1-H 起不再写入。后端 resolveChatHitlMode
   * 仍读老 DB row。新代码请使用 `hitlChatMode`。
   */
  hitlChat?: boolean;
  /**
   * v2：对话 HITL 三档（off / ai / always）。
   *   - 'off'    ：永不主动；仅高危工具（下单 / 写入外部状态）硬规则触发
   *   - 'ai'     ：默认 — 仅高危工具或 LLM hint 触发
   *   - 'always' ：每次工具调用都问（v1 行为）
   */
  hitlChatMode?: "off" | "ai" | "always";
  /**
   * @deprecated v1 兼容字段，前端自 P1-H 起不再写入。后端 resolveTeamHitlMode
   * 仍读老 DB row。新代码请使用 `hitlMode`。
   */
  hitlTeam?: boolean;
  /** v2：团队 HITL 三档（off / ai / always） */
  hitlMode?: "off" | "ai" | "always";
  /** Agent 工作模式；与 AgentLoopKind（推理引擎）正交。 */
  agentMode?: AgentControlMode;
  /** @deprecated 历史兼容：native -> agent，coding_agent -> goal。 */
  experience?: "native" | "coding_agent";
}

export type StrategyScriptPurpose = "research" | "live_trading" | "both";

export interface WorkflowCreateInput {
  projectId: string;
  goal: string;
  mode: WorkflowMode;
  sessionId?: string;
  source?: "chat" | "manual" | "api";
  messageId?: string;
  /** Chat mode: reuse latest workflow in this session instead of creating one per message. */
  reuseSessionWorkflow?: boolean;
  /** 为 true 时仅创建 workflow_run，不向 orchestrator 派发任务 */
  skipDispatch?: boolean;
  loopKind?: AgentLoopKind;
  loopOptionsJson?: LoopOptionsJson;
}

export interface AgentSummary {
  id: string;
  definitionId: string;
  role: string;
  name?: string;
  version: string;
  status?: "idle" | "running" | "error" | "stopped";
  executionPath?: "graph" | "a2a";
  running: boolean;
}

export interface StepStreamEvent {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  type:
    | "token"
    | "tool_call_start"
    | "tool_call_end"
    | "observe"
    | "step_persisted"
    | "hitl_request"
    | "final"
    | "error"
    // Agent modes：plan=分步计划/TODO 快照；tool_rationale=调用工具前的「为何调/预期」。
    | "plan"
    | "tool_rationale";
  stepIndex: number;
  ts: number;
  payload: Record<string, unknown>;
  loopKind?: AgentLoopKind;
  source?: "native" | "cli";
}

export type ToolCatalogCategory =
  | "orchestration"
  | "market"
  | "research"
  | "backtest"
  | "trading"
  | "risk"
  | "sentiment"
  | "macro"
  | "memory"
  | "audit";

export type ToolLifecycle = "stable" | "experimental" | "stub" | "deprecated";

export interface ToolCatalogEntry {
  name: string;
  kind: "builtin" | "connector" | "mcp";
  connector?: string;
  description: string;
  category?: ToolCatalogCategory;
  lifecycle?: ToolLifecycle;
  replacedBy?: string;
  deprecationReason?: string;
}

export const TOOL_CATEGORY_LABELS: Record<ToolCatalogCategory, string> = {
  orchestration: "编排协作",
  market: "行情数据",
  research: "量化研究",
  backtest: "回测验证",
  trading: "交易执行",
  risk: "风控合规",
  sentiment: "舆情事件",
  macro: "宏观策略",
  memory: "记忆知识",
  audit: "审计报告",
};

export const TOOL_LIFECYCLE_LABELS: Record<ToolLifecycle, string> = {
  stable: "稳定",
  experimental: "实验",
  stub: "占位",
  deprecated: "已废弃",
};

export interface AgentsConfigResponse {
  sourceOfTruth: string;
  diffSummary: {
    isSynced: boolean;
    counts: {
      fileDefinitions: number;
      dbDefinitions: number;
      filePolicies: number;
      dbPolicies: number;
    };
    missingDefinitionsInDb: string[];
    extraDefinitionsInDb: string[];
    missingPoliciesInDb: string[];
    extraPoliciesInDb: string[];
  };
  workspace: {
    exists: boolean;
    /** 工作区 JSON 校验失败时的可读原因（不阻塞 DB 列表） */
    parseError?: string | null;
    configDir: string;
    agentsFile: string;
    sandboxFile: string;
    config: unknown;
  };
  dbEffective: {
    definitions: unknown[];
    policies: unknown[];
  };
  runtime: {
    activeAgents: AgentSummary[];
  };
}

export interface ModelConfig {
  provider: "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock";
  model: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  baseUrl?: string;
}

/** Persisted builtin connector init payloads (`qubit-data`, `qubit-news`). */
export interface BuiltinConnectorConfig {
  "qubit-data": Record<string, unknown>;
  "qubit-news": Record<string, unknown>;
}

export interface AgentDefinitionRecord {
  id: string;
  role: string;
  name: string;
  version: string;
  systemPrompt: string;
  llmProvider: string;
  maxIterations: number;
  sandboxPolicyId: string;
  enabled: boolean;
  toolsJson: unknown;
  mcpServersJson: unknown;
  skillsJson: unknown;
  subscriptionsJson: unknown;
}

export interface AgentDefinitionDraftRecord {
  id: string;
  definitionId: string;
  versionTag: string;
  systemPrompt: string;
  changeNote: string;
  createdAt: string;
  /** 与 DB 行一致：最新草稿可能携带尚未发布的运行时字段 */
  toolsJson?: unknown;
  mcpServersJson?: unknown;
  skillsJson?: unknown;
  subscriptionsJson?: unknown;
  llmProvider?: string;
  maxIterations?: number;
  sandboxPolicyId?: string;
}

export interface AgentProfileRecord {
  id: string;
  definitionId: string;
  displayName: string;
  soulFileRef: string;
  promptTemplateRef?: string | null;
  description: string;
  tagsJson?: unknown;
  enabled?: boolean;
  configRootUri?: string;
  memoryNamespace?: string;
  promptMode?: "db_primary" | "file_primary" | "merged";
  configContentHash?: string;
  configSyncedAt?: string;
}

export interface AgentPromptPreviewResponse {
  /** 完整 system（与 LangGraph reason 发给 LLM 的一致） */
  mergedSystemPrompt: string;
  baseSystemPrompt: string;
  toolsPromptBlock: string;
  promptMode: "db_primary" | "file_primary" | "merged";
  sections: {
    agent: string;
    soul: string;
    user: string;
    memory: string;
    workspacePrompt: string;
    dbPrompt: string;
  };
  runtime: {
    tools: string[];
    mcpServers: string[];
    skills: string[];
    subscriptions: string[];
    mcpBindings: Array<{
      serverName: string;
      toolName: string;
      enabled: boolean;
      timeoutMs: number | null;
    }>;
  };
  packMeta: {
    packRoot: string;
    memoryNamespace: string;
    agentExists: boolean;
    soulExists: boolean;
    promptExists: boolean;
  };
}

export interface AgentPackResponse {
  definitionId: string;
  packRoot: string;
  agentPath: string;
  soulPath: string;
  promptPath: string;
  userPath: string;
  memoryPath: string;
  agentExists: boolean;
  soulExists: boolean;
  promptExists: boolean;
  userExists: boolean;
  memoryExists: boolean;
  agentMarkdown: string;
  soulMarkdown: string;
  promptMarkdown: string;
  userMarkdown: string;
  memoryMarkdown: string;
  contentHash: string;
  profileHash: string;
  promptMode: "db_primary" | "file_primary" | "merged";
  memoryNamespace: string;
}

export interface AgentMemoryStatsResponse {
  definitionId: string;
  midtermCount: number;
  longtermCount: number;
}

export interface AgentDefinitionBundle {
  definition: AgentDefinitionRecord;
  profile: AgentProfileRecord | null;
  draft: AgentDefinitionDraftRecord | null;
}

export interface SkillMarketStatusDto {
  loaded: boolean;
  loadedAt: number | null;
  skillCount: number;
  meta: Record<string, unknown> | null;
  baseUrl: string | null;
  /** SkillsMP 已缓存的条目数（按搜索写入，非全量目录） */
  skillsmpCacheSize?: number;
  /** 默认使用 SkillsMP 实时搜索；Open Skill Market 为可选全量 JSON 源 */
  defaultSkillProvider?: "skillsmp";
  /** 最近一次「刷新索引」使用的提供方 */
  lastRefreshProvider?: "skillsmp" | "open";
}

/** Open Skill Market registry entry (compact JSON). */
export interface OpenSkillMarketEntryDto {
  id: string;
  name: string;
  description: string;
  /** GitHub stars（SkillsMP 直接返回；Open registry 由后端从 repositories map 回填） */
  stars?: number;
  /** ISO 字符串或 Unix 秒/毫秒（取决于上游） */
  updatedAt?: string | number;
  categories?: string[];
  author?: string;
  repo?: string;
  path?: string;
  commitHash?: string;
  files?: string[];
  version?: string;
  tags?: string[];
  compatibility?: Record<string, unknown>;
}

export interface SkillMarketPageResult {
  items: OpenSkillMarketEntryDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SkillMarketInstallRecord {
  id: string;
  projectId: string;
  registry: string;
  externalSkillId: string;
  skillName: string;
  description: string;
  metaJson: unknown;
  installStatus: string;
  installedBy: string;
  createdAt: string;
}

/** `agent_skill` 表里的统一 skill 行：覆盖市场镜像 + 本地归纳 + 演化产物。 */
export type AgentSkillSource = "agent_created" | "user_authored" | "open_skill_market" | "evolved";
export type AgentSkillState = "active" | "stale" | "archived" | "pending_review";

export interface AgentSkillRecord {
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

export interface ChatSession {
  id: string;
  workspaceId: string;
  projectId?: string | null;
  title: string;
  status: "active" | "archived";
  lastActivityAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  sender: "user" | "orchestrator" | "agent" | "system";
  content: string;
  status: "queued" | "running" | "completed" | "failed" | "awaiting_approval";
  createdAt: string;
  workflowRunIds?: string[];
  errorMessage?: string | null;
}

/** Persisted strategy bundle from IDE (linked to session + optional research workflow run). */
export interface IndicatorStrategyScriptRecord {
  id: string;
  sessionId: string;
  workflowRunId?: string | null;
  name: string;
  ideCode: string;
  signalCode: string;
  aiPromptSnapshot?: string | null;
  chartSnapshotJson?: Record<string, unknown> | string;
  purpose: StrategyScriptPurpose;
  createdAt: string;
  updatedAt: string;
  /** 导出到 dataDir 下工作流目录的路径（仅 create/update 响应可能携带） */
  artifactDir?: string;
}

export interface WorkflowArtifactsDto {
  workflowDir: string;
  reportPath: string | null;
  strategyFolders: string[];
  report: string | null;
}

export interface SessionOverview {
  sessionId: string;
  workflowCount: number;
  running: number;
  failed: number;
  latestWorkflow: unknown | null;
  workflows: unknown[];
}

export interface WorkflowTimeline {
  workflowId: string;
  instances: unknown[];
  steps: Array<
    {
      id: string;
      phase: string;
      createdAt: string;
      thought?: string | null;
    } & { toolCalls: unknown[] }
  >;
}

export interface SessionAgentBoardItem {
  instanceId: string;
  workflowRunId: string;
  workflowStartedAt?: string | null;
  workflowStatus?: string | null;
  workflowMode?: string | null;
  role: string;
  name: string;
  status: "idle" | "running" | "error" | "stopped";
  currentIteration: number;
  lastError?: string | null;
  latestStep?: {
    phase: string;
    createdAt: string;
    stepIndex: number;
  } | null;
}

export interface SessionA2AMessageItem {
  id: string;
  workflowRunId: string;
  traceId: string;
  senderInstanceId: string;
  receiverInstanceId?: string | null;
  senderRole: string;
  receiverRole?: string | null;
  messageType: string;
  payloadJson: unknown;
  createdAt: string;
}

export interface WorkflowDetail {
  workflow: Record<string, unknown>;
  instances: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  toolCalls: Array<Record<string, unknown>>;
  sandboxViolations: Array<Record<string, unknown>>;
}

/**
 * GET /monitor/workflows/:id/observability
 *
 * P0-05 (2026-06)：新增 llm.llmCalls / totalPromptTokens / totalCompletionTokens /
 * totalCostUsd，per-role 新增 llmCalls + 拆分 + cost。老字段保留兼容。
 * 详见 backend `src/runtime/monitor/workflow-observability.ts` 顶部注释。
 */
export interface WorkflowObservability {
  workflowRunId: string;
  llm: {
    reasonSteps: number;
    /** P0-05：所有真实 LLM 调用计数（含内部直调如 orchestrator planning） */
    llmCalls: number;
    totalTokenCount: number | null;
    totalPromptTokens: number | null;
    totalCompletionTokens: number | null;
    totalCostUsd: number | null;
    totalReasonLatencyMs: number | null;
  };
  tools: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    topTools: Array<{ name: string; count: number }>;
  };
  mcp: {
    total: number;
    byStatus: Record<string, number>;
    byServer: Array<{ server: string; count: number; success: number; failed: number }>;
  };
  byAgentRole: Array<{
    role: string;
    reasonSteps: number;
    toolCalls: number;
    mcpCalls: number;
    tokens: number | null;
    llmCalls: number;
    llmPromptTokens: number;
    llmCompletionTokens: number;
    llmCostUsd: number;
  }>;
}

/** GET /analyst/workflow/:id/team-graph */
/** 节点大类：user=用户 / agent=Agent / tool=Tool·MCP·CLI / skill=技能。 */
export type TeamGraphNodeType = "user" | "agent" | "tool" | "skill";

export interface AnalystTeamGraphNode {
  id: string;
  role: string;
  label: string;
  /** 后端返回的节点大类；老数据可能缺省，前端按 role 兜底推断。 */
  type?: TeamGraphNodeType;
}

export interface AnalystTeamGraphEdge {
  key: string;
  a: string;
  b: string;
  messageCount: number;
  toolCount: number;
  messagesAtoB?: number;
  messagesBtoA?: number;
  toolSuccessCount?: number;
  toolFailCount?: number;
  /** agent → __skills__ 边的 skill 召回次数（仅 skill 边非 0）。 */
  skillCount?: number;
}

export interface AnalystTeamGraphInteraction {
  id: string;
  workflowRunId: string;
  fromRole: string;
  toRole: string;
  kind: string;
  toolKind: string | null;
  toolName: string | null;
  contentText: string;
  payloadJson: unknown;
  createdAt: string;
}

export interface AnalystTeamGraphToolCall {
  id: string;
  agentRole: string;
  agentInstanceId: string;
  toolName: string;
  toolKind: string;
  status: string;
  latencyMs: number | null;
  createdAt: string;
  agentStepId: string;
  requestJson?: unknown;
  responseJson?: unknown;
  errorMessage?: string | null;
}

export interface AnalystTeamGraphMcpCall {
  id: string;
  agentRole: string;
  agentInstanceId: string;
  serverName: string;
  toolName: string;
  status: string;
  latencyMs: number | null;
  createdAt: string;
  requestJson?: unknown;
  responseJson?: unknown;
  errorCode?: string | null;
}

export interface AnalystTeamGraphAgentStep {
  id: string;
  agentRole: string;
  agentInstanceId: string;
  stepIndex: number;
  phase: string;
  actionType: string;
  thought: string | null;
  actionJson: unknown;
  observationJson: unknown;
  latencyMs: number | null;
  createdAt: string;
}

export interface AnalystTeamGraphPayload {
  nodes: AnalystTeamGraphNode[];
  edges: AnalystTeamGraphEdge[];
  interactions: AnalystTeamGraphInteraction[];
  toolCalls: AnalystTeamGraphToolCall[];
  mcpCalls: AnalystTeamGraphMcpCall[];
  agentSteps?: AnalystTeamGraphAgentStep[];
  /** update_plan 的持久化快照；用于刷新/重连后恢复计划卡片。 */
  plan?: {
    mode?: AgentControlMode;
    goal?: {
      text?: string;
      status?: "planning" | "executing" | "completed" | "blocked";
      completedSteps?: number;
      totalSteps?: number;
    };
    steps: Array<{
      id: string;
      title: string;
      status: "pending" | "in_progress" | "done" | "skipped";
      note?: string;
    }>;
    updatedAt?: string;
  } | null;
}

// ─── V2 分析师团队与 MSA 类型 ─────────────────────────────────────────────────

export type AnalystSignalValue = "buy" | "sell" | "hold";

export interface AnalystSignalRecord {
  id: string;
  workflowRunId: string;
  agentInstanceId: string | null;
  analystRole: string;
  ticker: string;
  signal: AnalystSignalValue;
  confidence: number;
  reasoning: string;
  dataSnapshotJson: unknown;
  createdAt: string;
}

/**
 * P2-F 命名空间化：原名 `SignalFusionRecord` 太泛化。本接口特指 MSA Analyst 信号
 * 融合结果在前端的 row 视图。
 */
export interface AnalystSignalFusionRecord {
  id: string;
  workflowRunId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  weightsJson: Record<string, number>;
  debateTriggered: boolean;
  createdAt: string;
}

/** @deprecated 用 `AnalystSignalFusionRecord` */
export type SignalFusionRecord = AnalystSignalFusionRecord;

/** POST /analyst/run scope（与后端 research-scope 一致） */
export type ResearchScopeInput = {
  /**
   * - "single"   单标的
   * - "basket"   多标的篮子
   * - "sector"   板块（含可选成分股）
   * - "explore"  无标的自由探索（**必须提供 `theme`**，由 Orchestrator 自主筛选标的）
   */
  kind?: "single" | "basket" | "sector" | "explore";
  symbols?: string[];
  ticker?: string;
  sector?: string;
  peers?: string[];
  /** explore 模式专用：用户给的研究主题 */
  theme?: string;
  instrument?: "equity" | "option";
  positionSide?: "long" | "short";
  exchange?: string;
  option?: {
    underlying?: string;
    contractSymbol?: string;
    expiry?: string;
    strike?: number;
    right?: "call" | "put";
  };
};

export interface AnalystTeamResult {
  fusionId: string;
  ticker: string;
  scope?: ResearchScopeInput & { displayLabel?: string; symbols?: string[] };
  perSymbol?: Array<{ symbol: string; result: AnalystTeamResult }>;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  debateTriggered: boolean;
  breakdown: Array<{
    role: string;
    signal: AnalystSignalValue;
    confidence: number;
    reasoning: string;
  }>;
  report: string;
  debate?: {
    sessionId: string;
    consensusScore: number;
    finalStance: "bull" | "bear" | "hold" | "abort";
    verdict: "agree_bull" | "agree_bear" | "no_consensus";
    reasoning: string;
  };
  risk?: {
    approved: boolean;
    vetoed: boolean;
    riskScore: number;
    reason: string;
    severity: "warning" | "block" | "critical";
    rulesTriggered: string[];
  };
}

export interface AgentRoleCatalogItem {
  role: string;
  displayName: string;
  description: string;
  team: string;
  isBuiltin: boolean;
}

export interface DebateConfig {
  confidenceThreshold: number;
  maxRounds: number;
}

export interface DebateTurnRecord {
  id: string;
  debateSessionId: string;
  roundNumber: number;
  speakerRole: string;
  stance: "bull" | "bear" | "neutral";
  statement: string;
  confidence: number;
  createdAt: string;
}

/** GET /debate/sessions/:workflowRunId 返回的辩论会话摘要 */
export interface DebateSessionRecord {
  id: string;
  workflowRunId: string;
  topic: string;
  triggerReason: string;
  maxRounds: number;
  status: string;
  consensusScore: number | null;
  verdict: string | null;
  createdAt: string;
  endedAt: string | null;
}

export interface DebateVerdictRecord {
  id: string;
  debateSessionId: string;
  orchestratorRole: string;
  reasoning: string;
  consensusScore: number;
  finalStance: "bull" | "bear" | "hold" | "abort";
  vetoByRisk: boolean;
  createdAt: string;
}

export interface DebateStreamEvent {
  workflowRunId: string;
  sessionId: string;
  type: "debate_start" | "debate_turn" | "debate_verdict" | "debate_end";
  ts: number;
  payload: Record<string, unknown>;
}

export interface RiskConfig {
  vetoThreshold: number;
  blockConfidenceThreshold: number;
  severityMode: "conservative" | "balanced" | "aggressive";
}

export interface RiskVetoLogRecord {
  id: string;
  workflowRunId: string;
  vetoTarget: string;
  vetoReason: string;
  riskScore: number;
  riskRulesTriggeredJson: string[] | unknown;
  severity: "warning" | "block" | "critical";
  createdAt: string;
}

export interface ScreenerRunRecord {
  id: string;
  workflowRunId: string;
  criteriaJson: Record<string, unknown>;
  universe: string;
  candidateCount: number;
  createdAt: string;
}

export interface ScreenerCandidateRecord {
  id: string;
  screenerRunId: string;
  ticker: string;
  companyName: string;
  score: number;
  scoreBreakdownJson: Record<string, number>;
  passedToAnalyst: boolean;
  createdAt: string;
}

export interface GeneGenerationRecord {
  id: string;
  projectId: string;
  generationNumber: number;
  populationSize: number;
  mutationRate: number;
  bestSharpe: number | null;
  createdAt: string;
}

export interface StrategyGenomeRecord {
  id: string;
  projectId: string;
  generationId: string;
  name: string;
  genesSnapshotJson: Record<string, number>;
  sharpeRatio: number | null;
  maxDrawdown: number | null;
  totalReturn: number | null;
  mutationLog: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface GeneTrendPoint {
  generationId: string;
  generationNumber: number;
  bestSharpe: number | null;
  avgSharpe: number | null;
  avgDrawdown: number | null;
  populationSize: number;
  createdAt: string;
}

export interface IntentOrderRecord {
  id: string;
  workflowRunId: string;
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  status: "pending" | "approved" | "rejected" | "executed" | "deviated";
  createdAt: string;
}

export interface ExecutionReportRecord {
  id: string;
  intentOrderId: string;
  actualPrice: number;
  actualQuantity: number;
  slippage: number;
  executionTimeMs: number;
  status: "filled" | "partial" | "rejected" | "cancelled";
  createdAt: string;
}

export interface IntentDeviationRecord {
  id: string;
  intentOrderId: string;
  executionReportId: string;
  priceDeviationPct: number;
  quantityDeviationPct: number;
  exceededThreshold: boolean;
  callbackTriggered: boolean;
  createdAt: string;
}

export interface ExecutionSafetyConfig {
  dryRunOnly: boolean;
  requireDoubleConfirm: boolean;
  confirmTokenTtlSec: number;
  finalRiskScoreThreshold: number;
}

export interface ExecutionSafetyCheckResult {
  intentOrderId: string;
  finalRiskScore: number;
  riskAllowed: boolean;
  dryRunOnly: boolean;
  requireDoubleConfirm: boolean;
  confirmToken: string;
  expiresAt: number;
  blockers: string[];
}

export interface McpServerConfigRecord {
  id: string;
  name: string;
  projectId?: string | null;
  transport: "stdio" | "http" | "ws";
  command?: string | null;
  url?: string | null;
  capabilitiesJson: unknown;
  enabled: boolean;
  createdAt: string;
  /**
   * 后端派生（详见 src/runtime/mcp/origin.ts）：
   *   - 'builtin'：seed 进 DB 的官方 MCP（mathjs / tradingcalc / mcp-financex / qubit-broker 等）
   *   - 'market' ：从 MCP Registry 安装且 install 未 removed
   *   - 'manual' ：用户在"快速添加 MCP SERVER"表单手填的
   */
  origin?: "builtin" | "market" | "manual";
}

export interface McpToolBindingRecord {
  id: string;
  projectId?: string | null;
  definitionId?: string | null;
  serverName: string;
  toolName: string;
  enabled: boolean;
  timeoutMs?: number | null;
  retryPolicyJson: unknown;
  rateLimitJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionConfirmTicketRecord {
  id: string;
  intentOrderId: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string | null;
  status: "active" | "expired" | "consumed" | "revoked";
  riskScoreSnapshot: number;
  blockersJson: unknown;
  createdAt: string;
}

export interface WorkflowQualitySnapshotRecord {
  id: string;
  workflowRunId: string;
  totalDurationMs: number | null;
  totalToolCalls: number;
  sandboxBlockCount: number;
  errorCount: number;
  qualityScore: number;
  createdAt: string;
}

export interface AgentRuntimeMetricRecord {
  id: string;
  definitionId: string;
  windowStart: string;
  windowEnd: string;
  runCount: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  avgTokenCount: number | null;
  createdAt: string;
}

export interface AlertEventRecord {
  id: string;
  scopeType: "workflow" | "agent" | "system";
  scopeId: string;
  alertType: string;
  severity: "info" | "warn" | "error" | "critical";
  title: string;
  detailsJson: Record<string, unknown>;
  status: "open" | "ack" | "resolved";
  createdAt: string;
  resolvedAt?: string | null;
}

export interface EvalDatasetRecord {
  id: string;
  name: string;
  version: string;
  scenario: string;
  sourceDesc: string;
  metaJson: Record<string, unknown>;
  createdAt: string;
}

export interface EvalRunRecord {
  id: string;
  datasetId: string;
  configSnapshotJson: Record<string, unknown>;
  modelSnapshotJson: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  summaryMetricsJson: Record<string, unknown>;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
}

export interface EvalCaseResultRecord {
  id: string;
  evalRunId: string;
  caseKey: string;
  workflowRunId?: string | null;
  expectedJson: Record<string, unknown>;
  actualJson: Record<string, unknown>;
  score: number;
  pass: boolean;
  createdAt: string;
}

export interface FutuProviderConfig {
  opendHost?: string;
  opendPort?: number;
  market?: "HK" | "US" | "CN";
  accId?: string;
}

export interface IbProviderConfig {
  host?: string;
  port?: number;
  clientId?: number;
  accountId?: string;
}

export interface CcxtProviderConfig {
  exchangeId?: string;
  apiKeyRef?: string;
  sandbox?: boolean;
  defaultType?: "spot" | "future";
  market?: "CRYPTO";
}

export type BrokerProviderConfig = FutuProviderConfig | IbProviderConfig | CcxtProviderConfig;

export interface BrokerAccountRecord {
  id: string;
  provider: "futu" | "ib" | "ccxt";
  accountRef: string;
  mode: "mock" | "sandbox" | "live";
  baseUrl?: string | null;
  providerConfigJson?: BrokerProviderConfig;
  isDefault?: boolean;
  enabled: boolean;
  healthStatus: "unknown" | "healthy" | "degraded" | "down";
  healthMessage?: string | null;
  lastHealthAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerOrderEventRecord {
  id: string;
  intentOrderId?: string | null;
  executionReportId?: string | null;
  provider: "futu" | "ib" | "ccxt";
  eventType: "submit" | "ack" | "partial_fill" | "fill" | "cancel" | "reject" | "health_check";
  brokerOrderId?: string | null;
  status: string;
  detailJson: Record<string, unknown>;
  eventAt: string;
  createdAt: string;
}

export interface WorkflowCompensationTaskRecord {
  id: string;
  workflowRunId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  actionType: "retry_from_start" | "resume" | "manual_intervention";
  reason: string;
  retryCount: number;
  maxRetries: number;
  payloadJson: Record<string, unknown>;
  lastError?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 与后端 COMMUNICATION_CHANNEL_KINDS 保持一致。 */
export const INTEGRATION_KINDS = [
  "telegram",
  "feishu",
  "wecom",
  "whatsapp",
  "dingtalk",
  "webhook",
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export interface IntegrationAdapterDescriptor {
  kind: IntegrationKind;
  displayName: string;
  docsUrl?: string;
}

export interface CommunicationChannelRecord {
  id: string;
  workspaceId: string;
  projectId?: string | null;
  kind: IntegrationKind;
  name: string;
  externalChatId: string;
  secretRef: string;
  metaJson: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationMessageLogRecord {
  id: string;
  direction: "inbound" | "outbound";
  channelKind: IntegrationKind;
  channelId?: string | null;
  externalChatId: string;
  externalMessageId?: string | null;
  payloadJson: Record<string, unknown>;
  status: "success" | "failed";
  errorMessage?: string | null;
  createdAt: string;
}

export interface ScheduledJobRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  sessionId?: string | null;
  name: string;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  payloadJson: Record<string, unknown>;
  executionMode: "paper" | "live_with_confirm" | "live_direct";
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRunRecord {
  id: string;
  jobId: string;
  triggerAt: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  workflowRunId?: string | null;
  intentOrderId?: string | null;
  executionReportId?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
}

/**
 * Schema 收敛 C4（migration 0071）后：原 mcp_catalog_item 已并入 mcp_catalog，
 * 用 `source` 字段区分 'builtin' / 'registry' / 'fsi' 来源，registry 同步条目带
 * `sourceId` / `externalId` / `version` 三列。
 */
export interface McpCatalogRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  provider: string;
  source: "builtin" | "registry" | "fsi" | string;
  /** 仅 source='registry' 时非空 */
  sourceId?: string | null;
  /** 仅 source='registry' 时有意义 */
  externalId?: string;
  /** 仅 source='registry' 时有意义 */
  version?: string;
  riskLevel: "low" | "medium" | "high";
  transport: "stdio" | "http" | "ws";
  command?: string | null;
  url?: string | null;
  defaultToolName: string;
  defaultTimeoutMs: number;
  defaultRetryPolicyJson: Record<string, unknown>;
  defaultRateLimitJson: Record<string, unknown>;
  defaultCapabilitiesJson: unknown[];
  setupSchemaJson: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpCatalogInstallRecord {
  id: string;
  catalogId: string;
  serverName: string;
  status: "installed" | "failed";
  errorMessage?: string | null;
  installedBy: string;
  createdAt: string;
}

export interface McpRegistrySourceRecord {
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "api_key";
  authRef?: string | null;
  enabled: boolean;
  isDefault: boolean;
  syncIntervalSec: number;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Schema 收敛 C4（migration 0071）：原独立的 `mcp_catalog_item` 表已并入
 * `mcp_catalog`，DTO 合并为 `McpCatalogRecord`（用 `source='registry'` 区分）。
 * 这里保留 type alias 让外部 import 不破链；新代码请直接用 McpCatalogRecord。
 */
export type McpCatalogItemRecord = McpCatalogRecord;

export interface McpCatalogPageResult {
  items: McpCatalogRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface McpProjectInstallRecord {
  id: string;
  projectId?: string | null;
  workspaceId?: string | null;
  sourceId?: string | null;
  // Schema 收敛 C4（migration 0071）后：catalogItemId 列已从 mcp_catalog_install 删除
  catalogId: string;
  serverName: string;
  status: "installed" | "failed";
  installStatus: "installed" | "failed" | "pending" | "removed";
  errorMessage?: string | null;
  installedBy: string;
  createdAt: string;
}
