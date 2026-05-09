export type WorkflowMode = "research" | "backtest" | "simulation" | "live";

export interface WorkflowCreateInput {
  projectId: string;
  goal: string;
  mode: WorkflowMode;
  sessionId?: string;
  source?: "chat" | "manual" | "api";
  messageId?: string;
}

export interface AgentSummary {
  id: string;
  definitionId: string;
  role: string;
  version: string;
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
    | "final"
    | "error";
  stepIndex: number;
  ts: number;
  payload: Record<string, unknown>;
}

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
  baseUrl?: string;
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
}

export interface AgentProfileRecord {
  id: string;
  definitionId: string;
  displayName: string;
  soulFileRef: string;
  description: string;
}

export interface AgentDefinitionBundle {
  definition: AgentDefinitionRecord;
  profile: AgentProfileRecord | null;
  draft: AgentDefinitionDraftRecord | null;
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
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  workflowRunIds?: string[];
  errorMessage?: string | null;
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

export interface WorkflowDetail {
  workflow: Record<string, unknown>;
  instances: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  toolCalls: Array<Record<string, unknown>>;
  sandboxViolations: Array<Record<string, unknown>>;
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

export interface SignalFusionRecord {
  id: string;
  workflowRunId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  weightsJson: Record<string, number>;
  debateTriggered: boolean;
  createdAt: string;
}

export interface AnalystTeamResult {
  fusionId: string;
  ticker: string;
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
  transport: "stdio" | "http" | "ws";
  command?: string | null;
  url?: string | null;
  capabilitiesJson: unknown;
  enabled: boolean;
  createdAt: string;
}

export interface McpToolBindingRecord {
  id: string;
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

export interface BrokerAccountRecord {
  id: string;
  provider: "futu" | "ib";
  accountRef: string;
  mode: "mock" | "sandbox" | "live";
  baseUrl?: string | null;
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
  provider: "futu" | "ib";
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

export interface CommunicationChannelRecord {
  id: string;
  workspaceId: string;
  projectId?: string | null;
  kind: "telegram" | "webhook";
  name: string;
  externalChatId: string;
  secretRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationMessageLogRecord {
  id: string;
  direction: "inbound" | "outbound";
  channelKind: "telegram" | "webhook";
  externalChatId: string;
  externalMessageId?: string | null;
  payloadJson: Record<string, unknown>;
  status: "success" | "failed";
  errorMessage?: string | null;
  createdAt: string;
}

