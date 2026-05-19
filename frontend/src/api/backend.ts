import { backendFetchUrl, httpDelete, httpGet, httpPatch, httpPost, httpPut } from "./client";
import type {
  AgentSummary,
  AgentDefinitionBundle,
  AgentGroupDetail,
  AgentGroupRecord,
  AgentMemoryStatsResponse,
  AgentPackResponse,
  AgentPromptPreviewResponse,
  AgentsConfigResponse,
  AgentRoleCatalogItem,
  DebateConfig,
  DebateStreamEvent,
  DebateTurnRecord,
  DebateVerdictRecord,
  DebateSessionRecord,
  ExecutionSafetyCheckResult,
  ExecutionSafetyConfig,
  ExecutionConfirmTicketRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
  AlertEventRecord,
  BrokerAccountRecord,
  BrokerOrderEventRecord,
  CommunicationChannelRecord,
  CommunicationMessageLogRecord,
  McpServerConfigRecord,
  McpToolBindingRecord,
  McpRegistrySourceRecord,
  McpCatalogPageResult,
  McpCatalogItemRecord,
  McpProjectInstallRecord,
  McpCatalogRecord,
  McpCatalogInstallRecord,
  RiskConfig,
  RiskVetoLogRecord,
  GeneGenerationRecord,
  GeneTrendPoint,
  IntentDeviationRecord,
  IntentOrderRecord,
  ExecutionReportRecord,
  StrategyGenomeRecord,
  ScreenerCandidateRecord,
  ScreenerRunRecord,
  AnalystSignalRecord,
  AnalystTeamResult,
  AnalystTeamGraphPayload,
  ChatMessage,
  ChatSession,
  IndicatorStrategyScriptRecord,
  ModelConfig,
  BuiltinConnectorConfig,
  SessionOverview,
  WorkflowQualitySnapshotRecord,
  WorkflowCompensationTaskRecord,
  AgentRuntimeMetricRecord,
  SessionAgentBoardItem,
  SessionA2AMessageItem,
  SignalFusionRecord,
  StepStreamEvent,
  WorkflowDetail,
  WorkflowObservability,
  WorkflowTimeline,
  WorkflowArtifactsDto,
  WorkflowCreateInput,
  ScheduledJobRecord,
  ScheduledJobRunRecord,
  KlineBar,
  KlinesErrorPayload,
  KlinesResponseMeta,
  MarketNewsBriefPayload,
  AgentDefinitionDraftRecord,
  OpenSkillMarketEntryDto,
  SkillMarketPageResult,
  SkillMarketInstallRecord,
  SkillMarketStatusDto,
  ToolCatalogEntry,
} from "./types";
import { normalizeFusionApiToTeamResult } from "../lib/fusionNormalize";

export async function getHealth(): Promise<{ status: string }> {
  return httpGet<{ status: string }>("/health");
}

export async function getKlines(params: {
  symbol: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
}): Promise<{ ok: boolean; data: KlineBar[]; meta: KlinesResponseMeta; error?: KlinesErrorPayload }> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol);
  if (params.exchange) q.set("exchange", params.exchange);
  if (params.timeframe) q.set("timeframe", params.timeframe);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  return httpGet<{ ok: boolean; data: KlineBar[]; meta: KlinesResponseMeta; error?: KlinesErrorPayload }>(
    `/api/v1/market/klines?${q.toString()}`
  );
}

export async function getMarketNewsBrief(params: {
  symbol: string;
  exchange?: string;
  limit?: number;
}): Promise<{ ok: boolean; data?: MarketNewsBriefPayload; error?: string }> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol);
  if (params.exchange) q.set("exchange", params.exchange);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  return httpGet<{ ok: boolean; data?: MarketNewsBriefPayload; error?: string }>(
    `/api/v1/market/news-brief?${q.toString()}`
  );
}

export type MarketBacktestJobStatus = "queued" | "running" | "completed" | "failed";

export interface MarketBacktestPostBody {
  kind?: string;
  symbol: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
  fastPeriod?: number;
  slowPeriod?: number;
  initialCapital?: number;
  commission?: number;
}

export interface MarketBacktestPostResponse {
  ok: boolean;
  data?: {
    id: string;
    status?: MarketBacktestJobStatus;
    result?: unknown;
    error?: string | null;
  };
  error?: string;
}

export async function postMarketBacktest(
  body: MarketBacktestPostBody
): Promise<MarketBacktestPostResponse> {
  return httpPost<MarketBacktestPostResponse>("/api/v1/market/backtests", body as unknown as Record<string, unknown>);
}

export async function getMarketBacktest(jobId: string): Promise<{
  ok: boolean;
  data?: {
    id: string;
    status: string;
    kind: string;
    paramsJson: unknown;
    resultJson: unknown;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
}> {
  return httpGet(`/api/v1/market/backtests/${encodeURIComponent(jobId)}`);
}

export async function postMarketStructuredTune(body: {
  base: {
    symbol: string;
    exchange?: string;
    timeframe?: string;
    limit?: number;
    startDate?: string;
    endDate?: string;
  };
  fastPeriods?: number[];
  slowPeriods?: number[];
  initialCapital?: number;
  commission?: number;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return httpPost("/api/v1/market/experiments/structured-tune", body as Record<string, unknown>);
}

export async function postMarketRegimeDetect(body: {
  symbol: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
}): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return httpPost("/api/v1/market/experiments/regime/detect", body as Record<string, unknown>);
}

export async function listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
  const res = await httpGet<{ data: Array<{ id: string; name: string }> }>("/api/v1/workspaces");
  return res.data;
}

export async function createWorkspace(input: { name: string; owner: string }): Promise<{
  data: { id: string; name: string };
}> {
  return httpPost("/api/v1/workspaces", input);
}

export async function listProjects(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await httpGet<{ data: Array<{ id: string; name: string }> }>(
    `/api/v1/workspaces/${workspaceId}/projects`
  );
  return res.data;
}

export async function createProject(params: {
  workspaceId: string;
  name: string;
  marketScope: string;
}): Promise<{ data: { id: string; name: string } }> {
  return httpPost(`/api/v1/workspaces/${params.workspaceId}/projects`, {
    name: params.name,
    marketScope: params.marketScope,
    status: "active",
  });
}

export async function listAgents(): Promise<AgentSummary[]> {
  const res = await httpGet<{ data: AgentSummary[] }>("/api/v1/agents");
  return res.data;
}

export async function createWorkflow(input: WorkflowCreateInput): Promise<{
  data: { id: string };
  runId?: string;
}> {
  return httpPost("/api/v1/workflows", input);
}

export async function patchWorkflow(
  workflowId: string,
  input: {
    sessionId?: string | null;
    goal?: string;
    status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  }
): Promise<{ data: Record<string, unknown> }> {
  return httpPatch<{ data: Record<string, unknown> }>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
    input as Record<string, unknown>
  );
}

export async function deleteWorkflow(workflowId: string): Promise<{ ok: boolean; id: string }> {
  return httpDelete<{ ok: boolean; id: string }>(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
}

export async function listScheduledJobs(input?: {
  workspaceId?: string;
  projectId?: string;
}): Promise<ScheduledJobRecord[]> {
  const params = new URLSearchParams();
  if (input?.workspaceId) params.set("workspaceId", input.workspaceId);
  if (input?.projectId) params.set("projectId", input.projectId);
  const suffix = params.toString();
  const res = await httpGet<{ data: ScheduledJobRecord[] }>(
    `/api/v1/workflows/scheduled-jobs${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function createScheduledJob(input: {
  workspaceId: string;
  projectId: string;
  sessionId?: string | null;
  name?: string;
  cronExpr: string;
  timezone?: string;
  payloadJson?: Record<string, unknown>;
  executionMode?: "paper" | "live_with_confirm" | "live_direct";
  enabled?: boolean;
}): Promise<ScheduledJobRecord> {
  const res = await httpPost<{ data: ScheduledJobRecord }>("/api/v1/workflows/scheduled-jobs", input);
  return res.data;
}

export async function patchScheduledJob(
  id: string,
  input: {
    name?: string;
    enabled?: boolean;
    cronExpr?: string;
    timezone?: string;
    payloadJson?: Record<string, unknown>;
    executionMode?: "paper" | "live_with_confirm" | "live_direct";
  }
): Promise<ScheduledJobRecord> {
  const res = await httpPatch<{ data: ScheduledJobRecord }>(`/api/v1/workflows/scheduled-jobs/${id}`, input);
  return res.data;
}

export async function runScheduledJobNow(id: string): Promise<ScheduledJobRunRecord | null> {
  const res = await httpPost<{ ok: boolean; data: ScheduledJobRunRecord | null }>(
    `/api/v1/workflows/scheduled-jobs/${id}/run-now`,
    {}
  );
  return res.data;
}

export async function listScheduledJobRuns(id: string, limit = 50): Promise<ScheduledJobRunRecord[]> {
  const res = await httpGet<{ data: ScheduledJobRunRecord[] }>(
    `/api/v1/workflows/scheduled-jobs/${id}/runs?limit=${Math.max(1, Math.min(200, limit))}`
  );
  return res.data;
}

export async function listAgentDefinitions(): Promise<AgentDefinitionBundle[]> {
  const res = await httpGet<{ data: AgentDefinitionBundle[] }>("/api/v1/agents/definitions");
  return res.data;
}

export async function createAgentDefinition(input: {
  role: string;
  name?: string;
  systemPrompt?: string;
  displayName?: string;
}): Promise<AgentDefinitionBundle> {
  const res = await httpPost<{ data: AgentDefinitionBundle }>("/api/v1/agents/definitions", input);
  return res.data;
}

export async function deleteAgentDefinition(definitionId: string): Promise<void> {
  await httpDelete<{ ok: boolean; deletedId: string }>(
    `/api/v1/agents/definitions/${encodeURIComponent(definitionId)}`
  );
}

export async function postAgentPromptPreview(
  definitionId: string,
  body: {
    systemPrompt?: string;
    promptMode?: "db_primary" | "file_primary" | "merged";
    toolsJson?: unknown;
    mcpServersJson?: unknown;
    skillsJson?: unknown;
    subscriptionsJson?: unknown;
  }
): Promise<AgentPromptPreviewResponse> {
  const res = await httpPost<{ ok: boolean; data: AgentPromptPreviewResponse }>(
    `/api/v1/agents/definitions/${encodeURIComponent(definitionId)}/prompt-preview`,
    body
  );
  return res.data;
}

export async function getAgentDefinitionPack(definitionId: string): Promise<AgentPackResponse> {
  const res = await httpGet<{ data: AgentPackResponse }>(`/api/v1/agents/definitions/${definitionId}/pack`);
  return res.data;
}

export async function putAgentDefinitionPackFiles(
  definitionId: string,
  body: { agentMarkdown?: string; soulMarkdown: string; promptMarkdown: string }
): Promise<{ packRoot: string; agentPath: string; soulPath: string; promptPath: string; hash: string }> {
  const res = await httpPut<{
    data: { packRoot: string; agentPath: string; soulPath: string; promptPath: string; hash: string };
  }>(`/api/v1/agents/definitions/${definitionId}/pack/files`, body as unknown as Record<string, unknown>);
  return res.data;
}

export async function putAgentDefinitionPackSessionSnapshot(
  definitionId: string,
  body: { userMarkdown: string; memoryMarkdown: string }
): Promise<{ packRoot: string; userPath: string; memoryPath: string; hash: string }> {
  const res = await httpPut<{
    data: { packRoot: string; userPath: string; memoryPath: string; hash: string };
  }>(`/api/v1/agents/definitions/${definitionId}/pack/session-snapshot`, body as unknown as Record<string, unknown>);
  return res.data;
}

export async function postAgentDefinitionPackEnsureLayout(definitionId: string): Promise<{
  packRoot: string;
  created: string[];
}> {
  const res = await httpPost<{ data: { packRoot: string; created: string[] } }>(
    `/api/v1/agents/definitions/${definitionId}/pack/ensure-layout`,
    {}
  );
  return res.data;
}

export async function postAgentDefinitionPackSyncFromFs(definitionId: string): Promise<{
  updatedDefinition: boolean;
  systemPromptPreview: string;
  contentHash: string;
}> {
  const res = await httpPost<{
    data: { updatedDefinition: boolean; systemPromptPreview: string; contentHash: string };
  }>(`/api/v1/agents/definitions/${definitionId}/pack/sync-from-fs`, {});
  return res.data;
}

export async function getAgentDefinitionMemoryStats(definitionId: string): Promise<AgentMemoryStatsResponse> {
  const res = await httpGet<{ data: AgentMemoryStatsResponse }>(
    `/api/v1/agents/definitions/${definitionId}/memory-stats`
  );
  return res.data;
}

export async function listAgentGroups(): Promise<AgentGroupRecord[]> {
  const res = await httpGet<{ data: AgentGroupRecord[] }>("/api/v1/agents/agent-groups");
  return res.data;
}

export async function patchAgentGroup(
  id: string,
  input: { name?: string; description?: string; relationsJson?: unknown[] }
): Promise<AgentGroupRecord> {
  const res = await httpPatch<{ data: AgentGroupRecord }>(`/api/v1/agents/agent-groups/${id}`, input);
  return res.data;
}

export async function createAgentGroup(input: { name: string; description?: string }): Promise<AgentGroupRecord> {
  const res = await httpPost<{ data: AgentGroupRecord }>("/api/v1/agents/agent-groups", input);
  return res.data;
}

export async function deleteAgentGroup(id: string): Promise<void> {
  await httpDelete<{ ok: boolean }>(`/api/v1/agents/agent-groups/${id}`);
}

export async function getAgentGroup(id: string): Promise<AgentGroupDetail> {
  const res = await httpGet<{ data: AgentGroupDetail }>(`/api/v1/agents/agent-groups/${id}`);
  return res.data;
}

export async function addAgentGroupMember(
  groupId: string,
  input: { definitionId: string; sortOrder?: number }
): Promise<{ id: string; groupId: string; definitionId: string; sortOrder: number; createdAt: string }> {
  const res = await httpPost<{
    data: { id: string; groupId: string; definitionId: string; sortOrder: number; createdAt: string };
  }>(`/api/v1/agents/agent-groups/${groupId}/members`, input);
  return res.data;
}

export async function removeAgentGroupMember(groupId: string, memberId: string): Promise<void> {
  await httpDelete<{ ok: boolean }>(`/api/v1/agents/agent-groups/${groupId}/members/${memberId}`);
}

export async function createAgentDraft(params: {
  definitionId: string;
  systemPrompt?: string;
  changeNote?: string;
  llmProvider?: string;
  maxIterations?: number;
  sandboxPolicyId?: string;
  toolsJson?: unknown;
  mcpServersJson?: unknown;
  skillsJson?: unknown;
  subscriptionsJson?: unknown;
  profile?: {
    displayName?: string;
    soulFileRef?: string;
    promptTemplateRef?: string;
    description?: string;
    configRootUri?: string;
    memoryNamespace?: string;
    promptMode?: "db_primary" | "file_primary" | "merged";
  };
}): Promise<{ id: string }> {
  const { definitionId, ...payload } = params;
  const res = await httpPost<{ data: { id: string } }>(
    `/api/v1/agents/definitions/${definitionId}/draft`,
    payload
  );
  return res.data;
}

export async function releaseAgentDraft(params: {
  definitionId: string;
  draftId: string;
  releasedVersion?: string;
  releaseNote?: string;
}): Promise<void> {
  await httpPost(`/api/v1/agents/definitions/${params.definitionId}/release`, {
    draftId: params.draftId,
    releasedVersion: params.releasedVersion,
    releaseNote: params.releaseNote,
  });
}

export async function reloadAgents(): Promise<{ ok: boolean; before: number; after: number }> {
  return httpPost("/api/v1/agents/reload");
}

export async function getAgentsConfig(): Promise<AgentsConfigResponse> {
  return httpGet<AgentsConfigResponse>("/api/v1/agents/config");
}

export async function getAgentToolCatalog(): Promise<ToolCatalogEntry[]> {
  const res = await httpGet<{ ok: boolean; data: ToolCatalogEntry[] }>("/api/v1/agents/tools/catalog");
  return res.data ?? [];
}

export async function getModelConfig(): Promise<ModelConfig> {
  const res = await httpGet<{ data: ModelConfig }>("/api/v1/agents/model-config");
  return res.data;
}

export async function saveModelConfig(input: Partial<ModelConfig>): Promise<ModelConfig> {
  const res = await httpPost<{ data: ModelConfig }>("/api/v1/agents/model-config", input);
  return res.data;
}

export async function getBuiltinConnectorConfig(): Promise<BuiltinConnectorConfig> {
  const res = await httpGet<{ data: BuiltinConnectorConfig }>("/api/v1/agents/builtin-connector-config");
  return res.data;
}

export async function saveBuiltinConnectorConfig(
  input: Partial<BuiltinConnectorConfig>
): Promise<BuiltinConnectorConfig> {
  const res = await httpPost<{ data: BuiltinConnectorConfig }>(
    "/api/v1/agents/builtin-connector-config",
    input
  );
  return res.data;
}

export async function listChatSessions(params: {
  workspaceId: string;
  projectId?: string;
}): Promise<ChatSession[]> {
  const query = new URLSearchParams({ workspaceId: params.workspaceId });
  if (params.projectId) query.set("projectId", params.projectId);
  const res = await httpGet<{ data: ChatSession[] }>(`/api/v1/chat/sessions?${query.toString()}`);
  return res.data;
}

export async function createChatSession(input: {
  workspaceId: string;
  projectId?: string;
  title?: string;
}): Promise<ChatSession> {
  const res = await httpPost<{ data: ChatSession }>("/api/v1/chat/sessions", input);
  return res.data;
}

export async function getDefaultProjectSession(projectId: string): Promise<ChatSession> {
  const res = await httpGet<{ data: ChatSession }>(`/api/v1/chat/projects/${projectId}/sessions/default`);
  return res.data;
}

export async function listSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await httpGet<{ data: ChatMessage[] }>(`/api/v1/chat/sessions/${sessionId}/messages`);
  return res.data;
}

export async function listStrategyScripts(
  sessionId: string,
  opts?: { workflowRunId?: string }
): Promise<IndicatorStrategyScriptRecord[]> {
  const q = opts?.workflowRunId?.trim()
    ? `?workflowRunId=${encodeURIComponent(opts.workflowRunId.trim())}`
    : "";
  const res = await httpGet<{ data: IndicatorStrategyScriptRecord[] }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/strategy-scripts${q}`
  );
  return res.data;
}

export async function getWorkflowArtifacts(workflowRunId: string): Promise<WorkflowArtifactsDto> {
  const res = await httpGet<{ data: WorkflowArtifactsDto }>(
    `/api/v1/workflows/${encodeURIComponent(workflowRunId)}/artifacts`
  );
  return res.data;
}

export async function saveWorkflowReportArtifact(
  workflowRunId: string,
  body: { report: string; ticker?: string }
): Promise<{ reportPath: string }> {
  const res = await httpPut<{ data: { reportPath: string } }>(
    `/api/v1/workflows/${encodeURIComponent(workflowRunId)}/artifacts/report`,
    body
  );
  return res.data;
}

export async function createStrategyScript(
  sessionId: string,
  body: {
    name: string;
    ideCode: string;
    signalCode?: string;
    workflowRunId?: string | null;
    aiPromptSnapshot?: string | null;
    chartSnapshotJson?: Record<string, unknown>;
    purpose?: "research" | "live_trading" | "both";
  }
): Promise<IndicatorStrategyScriptRecord> {
  const res = await httpPost<{ data: IndicatorStrategyScriptRecord }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/strategy-scripts`,
    body as unknown as Record<string, unknown>
  );
  return res.data;
}

export async function updateStrategyScript(
  scriptId: string,
  body: Partial<{
    name: string;
    ideCode: string;
    signalCode: string;
    workflowRunId: string | null;
    aiPromptSnapshot: string | null;
    chartSnapshotJson: Record<string, unknown>;
    purpose: "research" | "live_trading" | "both";
  }>
): Promise<IndicatorStrategyScriptRecord> {
  const res = await httpPatch<{ data: IndicatorStrategyScriptRecord }>(
    `/api/v1/chat/strategy-scripts/${encodeURIComponent(scriptId)}`,
    body as unknown as Record<string, unknown>
  );
  return res.data;
}

export async function deleteStrategyScript(scriptId: string): Promise<{ ok: boolean; deletedId: string }> {
  return httpDelete<{ ok: boolean; deletedId: string }>(
    `/api/v1/chat/strategy-scripts/${encodeURIComponent(scriptId)}`
  );
}

export async function createSessionMessage(params: {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  sender?: "user" | "orchestrator" | "agent" | "system";
  status?: "queued" | "running" | "completed" | "failed";
  workflowRunIds?: string[];
}): Promise<ChatMessage> {
  const { sessionId, ...payload } = params;
  const res = await httpPost<{ data: ChatMessage }>(`/api/v1/chat/sessions/${sessionId}/messages`, payload);
  return res.data;
}

export async function patchSessionMessage(params: {
  messageId: string;
  content?: string;
  status?: "queued" | "running" | "completed" | "failed";
  errorMessage?: string | null;
  workflowRunIds?: string[];
}): Promise<ChatMessage> {
  const { messageId, ...payload } = params;
  const res = await httpPatch<{ data: ChatMessage }>(`/api/v1/chat/messages/${messageId}`, payload);
  return res.data;
}

export async function chatHealth(): Promise<{ ok: boolean }> {
  return httpGet<{ ok: boolean }>("/api/v1/chat/health");
}

export type MonitorSummary = {
  sessionId: string | null;
  workflowTotal: number;
  statusCounts: Record<string, number>;
  running: number;
  failed: number;
  completed24h: number;
  failed24h: number;
  stuckRunning: Array<{
    id: string;
    sessionId: string | null;
    mode: string;
    startedAt: string | null;
    goal: string | null;
  }>;
  openAlerts: number;
  recentAlerts: AlertEventRecord[];
  avgQualityScore: number | null;
  snapshotCount: number;
  instanceErrors: number;
  stuckThresholdMinutes: number;
};

export async function getMonitorSummary(params?: {
  sessionId?: string;
  stuckMinutes?: number;
}): Promise<MonitorSummary> {
  const query = new URLSearchParams();
  if (params?.sessionId) query.set("sessionId", params.sessionId);
  if (params?.stuckMinutes != null) query.set("stuckMinutes", String(params.stuckMinutes));
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: MonitorSummary }>(
    `/api/v1/monitor/summary${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function scanStuckWorkflowAlerts(stuckMinutes = 120): Promise<{
  scanned: number;
  created: number;
  alertIds: string[];
}> {
  const res = await httpPost<{ ok: boolean; data: { scanned: number; created: number; alertIds: string[] } }>(
    "/api/v1/monitor/alerts/scan-stuck",
    { stuckMinutes }
  );
  return res.data;
}

export async function getSessionOverview(sessionId: string): Promise<SessionOverview> {
  const res = await httpGet<{ data: SessionOverview }>(`/api/v1/monitor/sessions/${sessionId}/overview`);
  return res.data;
}

export async function getWorkflowTimeline(workflowId: string): Promise<WorkflowTimeline> {
  const res = await httpGet<{ data: WorkflowTimeline }>(`/api/v1/monitor/workflows/${workflowId}/timeline`);
  return res.data;
}

export async function getWorkflowSandboxViolations(workflowId: string): Promise<unknown[]> {
  const res = await httpGet<{ data: unknown[] }>(
    `/api/v1/monitor/workflows/${workflowId}/sandbox-violations`
  );
  return res.data;
}

export async function listMonitorWorkflows(params: {
  sessionId?: string;
  status?: string;
  mode?: string;
}): Promise<unknown[]> {
  const query = new URLSearchParams();
  if (params.sessionId) query.set("sessionId", params.sessionId);
  if (params.status) query.set("status", params.status);
  if (params.mode) query.set("mode", params.mode);
  const res = await httpGet<{ data: unknown[] }>(`/api/v1/monitor/workflows?${query.toString()}`);
  return res.data;
}

export async function getWorkflowDetail(workflowId: string): Promise<WorkflowDetail> {
  const res = await httpGet<{ data: WorkflowDetail }>(`/api/v1/monitor/workflows/${workflowId}/detail`);
  return res.data;
}

export async function getWorkflowObservability(workflowId: string): Promise<WorkflowObservability> {
  const res = await httpGet<{ ok: boolean; data: WorkflowObservability }>(
    `/api/v1/monitor/workflows/${workflowId}/observability`
  );
  return res.data;
}

export async function getSessionAgentsBoard(sessionId: string): Promise<SessionAgentBoardItem[]> {
  const res = await httpGet<{ data: { agents: SessionAgentBoardItem[] } }>(
    `/api/v1/monitor/sessions/${sessionId}/agents-board`
  );
  return res.data.agents;
}

export async function getSessionA2AMessages(
  sessionId: string,
  limit = 120
): Promise<SessionA2AMessageItem[]> {
  const res = await httpGet<{ data: { messages: SessionA2AMessageItem[] } }>(
    `/api/v1/monitor/sessions/${sessionId}/a2a-messages?limit=${encodeURIComponent(String(limit))}`
  );
  return res.data.messages;
}

export async function createWorkflowQuality(workflowId: string): Promise<WorkflowQualitySnapshotRecord> {
  const res = await httpPost<{ ok: boolean; data: WorkflowQualitySnapshotRecord }>(
    `/api/v1/monitor/quality/workflows/${workflowId}/snapshot`,
    {}
  );
  return res.data;
}

export async function listWorkflowQuality(workflowId: string): Promise<WorkflowQualitySnapshotRecord[]> {
  const res = await httpGet<{ ok: boolean; data: WorkflowQualitySnapshotRecord[] }>(
    `/api/v1/monitor/quality/workflows/${workflowId}/snapshots`
  );
  return res.data;
}

export async function aggregateAgentQuality(input?: {
  windowStart?: string;
  windowEnd?: string;
}): Promise<AgentRuntimeMetricRecord[]> {
  const res = await httpPost<{ ok: boolean; data: AgentRuntimeMetricRecord[] }>(
    "/api/v1/monitor/quality/agents/aggregate",
    input ?? {}
  );
  return res.data;
}

export async function listAgentQuality(input?: {
  windowStart?: string;
  windowEnd?: string;
}): Promise<AgentRuntimeMetricRecord[]> {
  const query = new URLSearchParams();
  if (input?.windowStart) query.set("windowStart", input.windowStart);
  if (input?.windowEnd) query.set("windowEnd", input.windowEnd);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: AgentRuntimeMetricRecord[] }>(
    `/api/v1/monitor/quality/agents/metrics${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function triggerWorkflowAlerts(workflowId: string): Promise<AlertEventRecord[]> {
  const res = await httpPost<{ ok: boolean; data: AlertEventRecord[] }>(
    `/api/v1/monitor/alerts/workflows/${workflowId}/trigger`,
    {}
  );
  return res.data;
}

export async function listAlerts(input?: {
  scopeType?: "workflow" | "agent" | "system";
  scopeId?: string;
  status?: "open" | "ack" | "resolved";
}): Promise<AlertEventRecord[]> {
  const query = new URLSearchParams();
  if (input?.scopeType) query.set("scopeType", input.scopeType);
  if (input?.scopeId) query.set("scopeId", input.scopeId);
  if (input?.status) query.set("status", input.status);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: AlertEventRecord[] }>(
    `/api/v1/monitor/alerts${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function ackAlert(alertId: string): Promise<AlertEventRecord> {
  const res = await httpPost<{ ok: boolean; data: AlertEventRecord }>(`/api/v1/monitor/alerts/${alertId}/ack`, {});
  return res.data;
}

export async function resolveAlert(alertId: string): Promise<AlertEventRecord> {
  const res = await httpPost<{ ok: boolean; data: AlertEventRecord }>(
    `/api/v1/monitor/alerts/${alertId}/resolve`,
    {}
  );
  return res.data;
}

export async function createEvalDataset(input: {
  name: string;
  version?: string;
  scenario?: string;
  sourceDesc?: string;
  metaJson?: Record<string, unknown>;
}): Promise<EvalDatasetRecord> {
  const res = await httpPost<{ ok: boolean; data: EvalDatasetRecord }>("/api/v1/monitor/eval/datasets", input);
  return res.data;
}

export async function listEvalDatasets(): Promise<EvalDatasetRecord[]> {
  const res = await httpGet<{ ok: boolean; data: EvalDatasetRecord[] }>("/api/v1/monitor/eval/datasets");
  return res.data;
}

export async function runEval(input: {
  datasetId: string;
  caseCount?: number;
  toggle?: { msa?: boolean; sdp?: boolean; rfv?: boolean };
  baselineToggle?: { msa?: boolean; sdp?: boolean; rfv?: boolean };
}): Promise<{
  runId: string;
  baselineRunId?: string | null;
  summaryMetricsJson: Record<string, unknown>;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      runId: string;
      baselineRunId?: string | null;
      summaryMetricsJson: Record<string, unknown>;
    };
  }>("/api/v1/monitor/eval/runs", input);
  return res.data;
}

export async function listEvalRuns(datasetId?: string): Promise<EvalRunRecord[]> {
  const suffix = datasetId ? `?datasetId=${encodeURIComponent(datasetId)}` : "";
  const res = await httpGet<{ ok: boolean; data: EvalRunRecord[] }>(`/api/v1/monitor/eval/runs${suffix}`);
  return res.data;
}

export async function getEvalRunDetail(runId: string): Promise<{
  run: EvalRunRecord;
  cases: EvalCaseResultRecord[];
}> {
  const res = await httpGet<{ ok: boolean; data: { run: EvalRunRecord; cases: EvalCaseResultRecord[] } }>(
    `/api/v1/monitor/eval/runs/${runId}`
  );
  return res.data;
}

// ─── V2 分析师团队 API ────────────────────────────────────────────────────────

/**
 * 启动分析师团队分析（异步任务）。
 * 后端立即返回 jobId，前端通过 pollAnalystJob 轮询结果。
 * 避免 WebView 系统级 ~60s 超时（分析可能耗时 2-10 分钟）。
 */
export async function startAnalystTeam(params: {
  workflowRunId: string;
  ticker: string;
  context?: string;
  agentGroupId?: string;
  /** 仅运行这些 analyst_* 角色（与编组/定义取交集） */
  analystRoles?: string[];
  /** 仅运行这些 definition id（与编组槽位取交集）；若提供则优先于 analystRoles */
  analystDefinitionIds?: string[];
}): Promise<{ jobId: string }> {
  const res = await httpPost<{ ok: boolean; jobId: string; status: string }>(
    "/api/v1/analyst/run",
    params
  );
  return { jobId: res.jobId };
}

/** 轮询分析任务状态，直到完成或失败 */
export async function pollAnalystJob(
  jobId: string,
  opts?: { intervalMs?: number; timeoutMs?: number; onProgress?: (elapsedMs: number) => void }
): Promise<AnalystTeamResult> {
  const intervalMs = opts?.intervalMs ?? 3000;
  const timeoutMs = opts?.timeoutMs ?? 900_000; // 15 minutes
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await httpGet<{
      ok: boolean;
      jobId: string;
      status: "running" | "completed" | "failed";
      result?: AnalystTeamResult;
      error?: string;
      elapsedMs: number;
    }>(`/api/v1/analyst/job/${jobId}`);

    if (res.status === "completed" && res.result) {
      return res.result;
    }
    if (res.status === "failed") {
      throw new Error(res.error ?? "analyst team job failed");
    }
    opts?.onProgress?.(res.elapsedMs);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("analyst team job timed out after 15 minutes");
}

/** 保留旧名称向后兼容 */
export async function runAnalystTeam(params: {
  workflowRunId: string;
  ticker: string;
  context?: string;
  onProgress?: (elapsedMs: number) => void;
  agentGroupId?: string;
  analystRoles?: string[];
  analystDefinitionIds?: string[];
}): Promise<AnalystTeamResult> {
  const { jobId } = await startAnalystTeam(params);
  return pollAnalystJob(jobId, { onProgress: params.onProgress });
}

export async function getAnalystSignals(workflowId: string): Promise<AnalystSignalRecord[]> {
  const res = await httpGet<{ ok: boolean; data: AnalystSignalRecord[] }>(
    `/api/v1/analyst/signals/${workflowId}`
  );
  return res.data;
}

export async function getSignalFusion(workflowId: string): Promise<AnalystTeamResult | null> {
  const res = await httpGet<{ ok: boolean; data: unknown }>(`/api/v1/analyst/fusion/${workflowId}`);
  return normalizeFusionApiToTeamResult(res.data);
}

export async function listDebateSessionsForWorkflow(workflowRunId: string): Promise<DebateSessionRecord[]> {
  const res = await httpGet<{ ok: boolean; data: DebateSessionRecord[] }>(
    `/api/v1/debate/sessions/${encodeURIComponent(workflowRunId)}`
  );
  return Array.isArray(res.data) ? res.data : [];
}

export async function getAnalystTeamGraph(workflowRunId: string): Promise<AnalystTeamGraphPayload | null> {
  const res = await httpGet<{ ok: boolean; data?: AnalystTeamGraphPayload; error?: string }>(
    `/api/v1/analyst/workflow/${encodeURIComponent(workflowRunId)}/team-graph`
  );
  if (!(res as { ok?: boolean }).ok) return null;
  return (res as { data?: AnalystTeamGraphPayload }).data ?? null;
}

export async function getAgentRoles(): Promise<AgentRoleCatalogItem[]> {
  const res = await httpGet<{ ok: boolean; data: AgentRoleCatalogItem[] }>("/api/v1/analyst/roles");
  return res.data;
}

export async function getFusionHistory(params?: {
  ticker?: string;
  limit?: number;
  offset?: number;
}): Promise<SignalFusionRecord[]> {
  const query = new URLSearchParams();
  if (params?.ticker) query.set("ticker", params.ticker);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  const res = await httpGet<{ ok?: boolean; data?: SignalFusionRecord[] | null }>(
    `/api/v1/analyst/fusion/history?${query.toString()}`
  );
  const rows = (res as { data?: unknown } | null)?.data;
  return Array.isArray(rows) ? (rows as SignalFusionRecord[]) : [];
}

export async function getDebateConfig(): Promise<DebateConfig> {
  const res = await httpGet<{ ok: boolean; data: DebateConfig }>("/api/v1/debate/config");
  return res.data;
}

export async function saveDebateConfig(input: Partial<DebateConfig>): Promise<DebateConfig> {
  const res = await httpPut<{ ok: boolean; data: DebateConfig }>("/api/v1/debate/config", input);
  return res.data;
}

export async function getDebateTurns(sessionId: string): Promise<DebateTurnRecord[]> {
  const res = await httpGet<{ ok: boolean; data: DebateTurnRecord[] }>(
    `/api/v1/debate/sessions/${sessionId}/turns`
  );
  return res.data;
}

export async function getDebateVerdict(sessionId: string): Promise<DebateVerdictRecord | null> {
  const res = await httpGet<{ ok: boolean; data: DebateVerdictRecord | null }>(
    `/api/v1/debate/sessions/${sessionId}/verdict`
  );
  return res.data;
}

export function subscribeDebateStream(params: {
  workflowRunId: string;
  onEvent: (event: DebateStreamEvent) => void;
  onError?: (err: Event) => void;
}): () => void {
  const url = backendFetchUrl(`/api/v1/debate/stream/${params.workflowRunId}`);
  const es = new EventSource(url);
  const types: DebateStreamEvent["type"][] = [
    "debate_start",
    "debate_turn",
    "debate_verdict",
    "debate_end",
  ];
  for (const t of types) {
    es.addEventListener(t, (ev) => {
      const msg = ev as MessageEvent<string>;
      params.onEvent(JSON.parse(msg.data) as DebateStreamEvent);
    });
  }
  es.onerror = (err) => {
    params.onError?.(err);
  };
  return () => es.close();
}

export async function getRiskConfig(): Promise<RiskConfig> {
  const res = await httpGet<{ ok: boolean; data: RiskConfig }>("/api/v1/risk/config");
  return res.data;
}

export async function saveRiskConfig(input: Partial<RiskConfig>): Promise<RiskConfig> {
  const res = await httpPut<{ ok: boolean; data: RiskConfig }>("/api/v1/risk/config", input);
  return res.data;
}

export async function getRiskVetoLogs(workflowRunId: string): Promise<RiskVetoLogRecord[]> {
  const res = await httpGet<{ ok: boolean; data: RiskVetoLogRecord[] }>(
    `/api/v1/risk/veto-logs/${workflowRunId}`
  );
  return res.data;
}

export async function runScreener(params: {
  workflowRunId: string;
  universe?: "CN-A" | "US" | "HK";
  criteria?: {
    minMarketCapBillion?: number;
    maxPe?: number;
    minMomentum30d?: number;
  };
  topN?: number;
}): Promise<{
  screenerRunId: string;
  universe: string;
  candidateCount: number;
  candidates: Array<{
    ticker: string;
    companyName: string;
    score: number;
    scoreBreakdown: Record<string, number>;
  }>;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      screenerRunId: string;
      universe: string;
      candidateCount: number;
      candidates: Array<{
        ticker: string;
        companyName: string;
        score: number;
        scoreBreakdown: Record<string, number>;
      }>;
    };
  }>("/api/v1/screener/run", params);
  return res.data;
}

export async function listScreenerRuns(workflowRunId: string): Promise<ScreenerRunRecord[]> {
  const res = await httpGet<{ ok: boolean; data: ScreenerRunRecord[] }>(`/api/v1/screener/runs/${workflowRunId}`);
  return res.data;
}

export async function listScreenerCandidates(screenerRunId: string): Promise<ScreenerCandidateRecord[]> {
  const res = await httpGet<{ ok: boolean; data: ScreenerCandidateRecord[] }>(
    `/api/v1/screener/candidates/${screenerRunId}`
  );
  return res.data;
}

export async function initGenePool(input: {
  projectId: string;
  populationSize?: number;
  mutationRate?: number;
}): Promise<{ generationId: string; generationNumber: number; populationSize: number }> {
  const res = await httpPost<{
    ok: boolean;
    data: { generationId: string; generationNumber: number; populationSize: number };
  }>("/api/v1/gene/init", input);
  return res.data;
}

export async function evolveGenePool(projectId: string): Promise<{ generationId: string; generationNumber: number }> {
  const res = await httpPost<{ ok: boolean; data: { generationId: string; generationNumber: number } }>(
    "/api/v1/gene/evolve",
    { projectId }
  );
  return res.data;
}

export async function listGeneGenerations(projectId: string): Promise<GeneGenerationRecord[]> {
  const res = await httpGet<{ ok: boolean; data: GeneGenerationRecord[] }>(`/api/v1/gene/generations/${projectId}`);
  return res.data;
}

export async function listGenomes(generationId: string): Promise<StrategyGenomeRecord[]> {
  const res = await httpGet<{ ok: boolean; data: StrategyGenomeRecord[] }>(`/api/v1/gene/genomes/${generationId}`);
  return res.data;
}

export async function listGeneTrends(projectId: string): Promise<GeneTrendPoint[]> {
  const res = await httpGet<{ ok: boolean; data: GeneTrendPoint[] }>(`/api/v1/gene/trends/${projectId}`);
  return res.data;
}

export async function createIntentOrder(input: {
  workflowRunId: string;
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  expectedReturn?: number;
  expectedRisk?: number;
}): Promise<{ id: string }> {
  const res = await httpPost<{ ok: boolean; data: { id: string } }>("/api/v1/reia/intent", input);
  return res.data;
}

export async function executeIntent(input: {
  intentOrderId: string;
  deviationThreshold?: number;
}): Promise<{
  intentOrderId: string;
  executionReportId: string;
  deviationId: string;
  exceededThreshold: boolean;
  priceDeviationPct: number;
  quantityDeviationPct: number;
  threshold: number;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      intentOrderId: string;
      executionReportId: string;
      deviationId: string;
      exceededThreshold: boolean;
      priceDeviationPct: number;
      quantityDeviationPct: number;
      threshold: number;
    };
  }>("/api/v1/reia/execute", input);
  return res.data;
}

export async function listIntentOrders(workflowRunId: string): Promise<IntentOrderRecord[]> {
  const res = await httpGet<{ ok: boolean; data: IntentOrderRecord[] }>(`/api/v1/reia/intents/${workflowRunId}`);
  return res.data;
}

export async function getIntentExecutionView(intentOrderId: string): Promise<{
  intent: IntentOrderRecord | null;
  report: ExecutionReportRecord | null;
  deviation: IntentDeviationRecord | null;
}> {
  const res = await httpGet<{
    ok: boolean;
    data: {
      intent: IntentOrderRecord | null;
      report: ExecutionReportRecord | null;
      deviation: IntentDeviationRecord | null;
    };
  }>(`/api/v1/reia/view/${intentOrderId}`);
  return res.data;
}

export async function getExecutionSafetyConfig(): Promise<ExecutionSafetyConfig> {
  const res = await httpGet<{ ok: boolean; data: ExecutionSafetyConfig }>("/api/v1/reia/safety/config");
  return res.data;
}

export async function saveExecutionSafetyConfig(
  input: Partial<ExecutionSafetyConfig>
): Promise<ExecutionSafetyConfig> {
  const res = await httpPut<{ ok: boolean; data: ExecutionSafetyConfig }>("/api/v1/reia/safety/config", input);
  return res.data;
}

export async function requestExecutionConfirmation(intentOrderId: string): Promise<ExecutionSafetyCheckResult> {
  const res = await httpPost<{ ok: boolean; data: ExecutionSafetyCheckResult }>(
    "/api/v1/reia/safety/request-confirm",
    { intentOrderId }
  );
  return res.data;
}

export async function executeIntentConfirmed(input: {
  intentOrderId: string;
  confirmToken?: string;
  deviationThreshold?: number;
  forceDryRun?: boolean;
  provider?: "futu" | "ib";
}): Promise<{
  gate: {
    executeMode: "paper" | "live";
    safety: ExecutionSafetyConfig;
  };
  data: {
    intentOrderId: string;
    executionReportId: string;
    deviationId: string;
    exceededThreshold: boolean;
    priceDeviationPct: number;
    quantityDeviationPct: number;
    threshold: number;
    provider?: "futu" | "ib";
    brokerOrderId?: string;
  };
}> {
  const res = await httpPost<{
    ok: boolean;
    gate: {
      executeMode: "paper" | "live";
      safety: ExecutionSafetyConfig;
    };
    data: {
      intentOrderId: string;
      executionReportId: string;
      deviationId: string;
      exceededThreshold: boolean;
      priceDeviationPct: number;
      quantityDeviationPct: number;
      threshold: number;
      provider?: "futu" | "ib";
      brokerOrderId?: string;
    };
  }>("/api/v1/reia/safety/execute-confirmed", input);
  return { gate: res.gate, data: res.data };
}

export async function listExecutionConfirmTickets(intentOrderId: string): Promise<ExecutionConfirmTicketRecord[]> {
  const res = await httpGet<{ ok: boolean; data: ExecutionConfirmTicketRecord[] }>(
    `/api/v1/reia/safety/tickets/${intentOrderId}`
  );
  return res.data;
}

export async function cleanupExecutionConfirmTickets(): Promise<{ cleaned: number }> {
  const res = await httpPost<{ ok: boolean; data: { cleaned: number } }>(
    "/api/v1/reia/safety/tickets/cleanup",
    {}
  );
  return res.data;
}

export async function listBrokerAccounts(provider?: "futu" | "ib"): Promise<BrokerAccountRecord[]> {
  const suffix = provider ? `?provider=${provider}` : "";
  const res = await httpGet<{ ok: boolean; data: BrokerAccountRecord[] }>(`/api/v1/reia/broker/accounts${suffix}`);
  return res.data;
}

export async function upsertBrokerAccount(input: {
  provider: "futu" | "ib";
  accountRef: string;
  mode?: "mock" | "sandbox" | "live";
  baseUrl?: string;
  providerConfig?: import("./types").BrokerProviderConfig;
  isDefault?: boolean;
  enabled?: boolean;
}): Promise<BrokerAccountRecord> {
  const res = await httpPost<{ ok: boolean; data: BrokerAccountRecord }>("/api/v1/reia/broker/accounts/upsert", input);
  return res.data;
}

export async function checkBrokerHealth(input: {
  provider: "futu" | "ib";
  accountRef: string;
}): Promise<{ provider: "futu" | "ib"; status: "healthy" | "degraded" | "down"; message: string; checkedAt: string }> {
  const res = await httpPost<{
    ok: boolean;
    data: { provider: "futu" | "ib"; status: "healthy" | "degraded" | "down"; message: string; checkedAt: string };
  }>("/api/v1/reia/broker/health-check", input);
  return res.data;
}

export async function listBrokerEvents(provider?: "futu" | "ib", limit = 100): Promise<BrokerOrderEventRecord[]> {
  const query = new URLSearchParams();
  if (provider) query.set("provider", provider);
  query.set("limit", String(limit));
  const res = await httpGet<{ ok: boolean; data: BrokerOrderEventRecord[] }>(
    `/api/v1/reia/broker/events?${query.toString()}`
  );
  return res.data;
}

export async function enqueueWorkflowCompensation(input: {
  workflowRunId: string;
  actionType?: "retry_from_start" | "resume" | "manual_intervention";
  reason?: string;
  payloadJson?: Record<string, unknown>;
  maxRetries?: number;
}): Promise<WorkflowCompensationTaskRecord> {
  const res = await httpPost<{ ok: boolean; data: WorkflowCompensationTaskRecord }>(
    "/api/v1/workflows/compensation/enqueue",
    input
  );
  return res.data;
}

export async function listWorkflowCompensations(input?: {
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  workflowRunId?: string;
  limit?: number;
}): Promise<WorkflowCompensationTaskRecord[]> {
  const query = new URLSearchParams();
  if (input?.status) query.set("status", input.status);
  if (input?.workflowRunId) query.set("workflowRunId", input.workflowRunId);
  if (input?.limit) query.set("limit", String(input.limit));
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: WorkflowCompensationTaskRecord[] }>(
    `/api/v1/workflows/compensation/tasks${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function processWorkflowCompensations(limit = 10): Promise<{ picked: number; success: number; failed: number }> {
  const res = await httpPost<{ ok: boolean; data: { picked: number; success: number; failed: number } }>(
    "/api/v1/workflows/compensation/process",
    { limit }
  );
  return res.data;
}

export async function listIntegrationChannels(kind?: "telegram" | "webhook"): Promise<CommunicationChannelRecord[]> {
  const suffix = kind ? `?kind=${kind}` : "";
  const res = await httpGet<{ ok: boolean; data: CommunicationChannelRecord[] }>(`/api/v1/integrations/channels${suffix}`);
  return res.data;
}

export async function upsertIntegrationChannel(input: {
  id?: string;
  workspaceId: string;
  projectId?: string | null;
  kind: "telegram" | "webhook";
  name: string;
  externalChatId: string;
  secretRef?: string;
  enabled?: boolean;
}): Promise<CommunicationChannelRecord> {
  const res = await httpPost<{ ok: boolean; data: CommunicationChannelRecord }>(
    "/api/v1/integrations/channels/upsert",
    input
  );
  return res.data;
}

export async function listIntegrationLogs(kind?: "telegram" | "webhook", limit = 100): Promise<CommunicationMessageLogRecord[]> {
  const query = new URLSearchParams();
  if (kind) query.set("kind", kind);
  query.set("limit", String(limit));
  const res = await httpGet<{ ok: boolean; data: CommunicationMessageLogRecord[] }>(
    `/api/v1/integrations/logs?${query.toString()}`
  );
  return res.data;
}

/** Parse one SSE block (lines between blank lines). */
function parseSseBlock(block: string): { eventName: string; data: string } | null {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  let eventName = "message";
  const dataLines: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
    }
  }
  const data = dataLines.join("\n");
  if (!data) return null;
  return { eventName, data };
}

/**
 * Subscribe to workflow step stream (SSE). Uses fetch + ReadableStream instead of EventSource
 * so Tauri/WebView does not treat normal stream close as a spurious error/reconnect loop.
 */
export function subscribeWorkflowStream(params: {
  workflowId: string;
  runId: string;
  onEvent: (event: StepStreamEvent) => void;
  onError?: (err: Event) => void;
}): () => void {
  const url = backendFetchUrl(`/api/v1/workflows/${params.workflowId}/stream/${params.runId}`);
  const ac = new AbortController();
  let active = true;

  const run = async (): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) {
        if (active) params.onError?.(new Event("http-error"));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (active) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        if (done) {
          buf += decoder.decode();
          break;
        }
        buf = buf.replace(/\r\n/g, "\n");
        for (;;) {
          const sep = buf.indexOf("\n\n");
          if (sep < 0) break;
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          try {
            params.onEvent(JSON.parse(parsed.data) as StepStreamEvent);
          } catch {
            // ignore malformed JSON
          }
        }
      }
      if (active && buf.trim()) {
        const parsed = parseSseBlock(buf);
        if (parsed) {
          try {
            params.onEvent(JSON.parse(parsed.data) as StepStreamEvent);
          } catch {
            // ignore
          }
        }
      }
    } catch (e) {
      if (!active) return;
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError") return;
      params.onError?.(new Event("fetch-error"));
    }
  };

  void run();

  return () => {
    active = false;
    ac.abort();
  };
}

export async function listMcpServers(projectId?: string): Promise<McpServerConfigRecord[]> {
  const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await httpGet<{ data: McpServerConfigRecord[] }>(`/api/v1/agents/mcp/servers${suffix}`);
  return res.data;
}

export async function upsertMcpServer(input: {
  name: string;
  projectId?: string;
  transport: "stdio" | "http" | "ws";
  command?: string;
  url?: string;
  capabilitiesJson?: unknown[];
  enabled?: boolean;
}): Promise<McpServerConfigRecord> {
  const res = await httpPost<{ data: McpServerConfigRecord }>("/api/v1/agents/mcp/servers/upsert", input);
  return res.data;
}

export async function listMcpBindings(projectId?: string, definitionId?: string): Promise<McpToolBindingRecord[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (definitionId) params.set("definitionId", definitionId);
  const q = params.toString();
  const suffix = q ? `?${q}` : "";
  const res = await httpGet<{ data: McpToolBindingRecord[] }>(`/api/v1/agents/mcp/bindings${suffix}`);
  return res.data;
}

export async function upsertMcpBinding(input: {
  projectId?: string;
  definitionId?: string | null;
  serverName: string;
  toolName: string;
  enabled?: boolean;
  timeoutMs?: number;
  retryPolicyJson?: Record<string, unknown>;
  rateLimitJson?: Record<string, unknown>;
}): Promise<McpToolBindingRecord> {
  const res = await httpPost<{ data: McpToolBindingRecord }>("/api/v1/agents/mcp/bindings/upsert", input);
  return res.data;
}

export async function testMcpCall(input: {
  projectId?: string;
  definitionId?: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}): Promise<{
  serverName: string;
  toolName: string;
  transport: "stdio" | "http" | "ws";
  accepted: boolean;
  output: Record<string, unknown>;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      serverName: string;
      toolName: string;
      transport: "stdio" | "http" | "ws";
      accepted: boolean;
      output: Record<string, unknown>;
    };
  }>("/api/v1/agents/mcp/test", input);
  return res.data;
}

export async function listMcpCatalog(): Promise<McpCatalogRecord[]> {
  const res = await httpGet<{ data: McpCatalogRecord[] }>("/api/v1/agents/mcp/catalog");
  return res.data;
}

export async function listMcpSources(): Promise<McpRegistrySourceRecord[]> {
  const res = await httpGet<{ data: McpRegistrySourceRecord[] }>("/api/v1/agents/mcp/sources");
  return res.data;
}

export async function upsertMcpSource(input: {
  id?: string;
  name: string;
  baseUrl: string;
  authType?: "none" | "bearer" | "api_key";
  authRef?: string;
  enabled?: boolean;
  isDefault?: boolean;
  syncIntervalSec?: number;
}): Promise<McpRegistrySourceRecord> {
  if (input.id) {
    const res = await httpPatch<{ data: McpRegistrySourceRecord }>(`/api/v1/agents/mcp/sources/${input.id}`, input);
    return res.data;
  }
  const res = await httpPost<{ data: McpRegistrySourceRecord }>("/api/v1/agents/mcp/sources", input);
  return res.data;
}

export async function syncMcpSource(id: string): Promise<{
  sourceId: string;
  syncedCount: number;
  usedFallback: boolean;
}> {
  const res = await httpPost<{ ok: boolean; data: { sourceId: string; syncedCount: number; usedFallback: boolean } }>(
    `/api/v1/agents/mcp/sources/${id}/sync`,
    {}
  );
  return res.data;
}

export async function listMcpMarketCatalog(input?: {
  sourceId?: string;
  q?: string;
  risk?: "low" | "medium" | "high";
  page?: number;
  pageSize?: number;
}): Promise<McpCatalogPageResult> {
  const query = new URLSearchParams();
  if (input?.sourceId) query.set("sourceId", input.sourceId);
  if (input?.q?.trim()) query.set("q", input.q.trim());
  if (input?.risk) query.set("risk", input.risk);
  if (input?.page != null) query.set("page", String(input.page));
  if (input?.pageSize != null) query.set("pageSize", String(input.pageSize));
  const suffix = query.toString();
  const res = await httpGet<{ data: McpCatalogPageResult | McpCatalogItemRecord[] }>(
    `/api/v1/agents/mcp/market/catalog${suffix ? `?${suffix}` : ""}`
  );
  const data = res.data;
  if (Array.isArray(data)) {
    return { items: data, total: data.length, page: 1, pageSize: data.length, totalPages: 1 };
  }
  return {
    items: data.items ?? [],
    total: data.total ?? 0,
    page: data.page ?? 1,
    pageSize: data.pageSize ?? 24,
    totalPages: data.totalPages ?? 1,
  };
}

export async function installMcpMarket(input: {
  projectId: string;
  catalogItemId: string;
  serverName: string;
  installedBy?: string;
  command?: string;
  url?: string;
  toolName?: string;
  timeoutMs?: number;
}): Promise<McpProjectInstallRecord> {
  const res = await httpPost<{ data: McpProjectInstallRecord }>("/api/v1/agents/mcp/market/install", input);
  return res.data;
}

export async function listMcpProjectInstalls(projectId: string): Promise<McpProjectInstallRecord[]> {
  const res = await httpGet<{ data: McpProjectInstallRecord[] }>(
    `/api/v1/agents/mcp/market/installs?projectId=${encodeURIComponent(projectId)}`
  );
  return res.data;
}

export async function getSkillMarketStatus(): Promise<SkillMarketStatusDto> {
  const res = await httpGet<{ data: SkillMarketStatusDto }>("/api/v1/agents/skills/market/status");
  return res.data;
}

export async function refreshSkillMarketRegistry(input?: {
  baseUrl?: string;
  provider?: "skillsmp" | "open";
  apiKey?: string;
}): Promise<SkillMarketStatusDto> {
  const res = await httpPost<{ data: SkillMarketStatusDto }>("/api/v1/agents/skills/market/refresh", {
    baseUrl: input?.baseUrl?.trim() || undefined,
    provider: input?.provider,
    apiKey: input?.apiKey?.trim() || undefined,
  });
  return res.data;
}

export async function searchSkillMarket(input?: {
  q?: string;
  page?: number;
  pageSize?: number;
  provider?: "skillsmp" | "open";
}): Promise<SkillMarketPageResult> {
  const params = new URLSearchParams();
  if (input?.q?.trim()) params.set("q", input.q.trim());
  if (input?.page != null) params.set("page", String(input.page));
  if (input?.pageSize != null) params.set("pageSize", String(input.pageSize));
  params.set("provider", input?.provider ?? "skillsmp");
  const res = await httpGet<{ data: SkillMarketPageResult | OpenSkillMarketEntryDto[] }>(
    `/api/v1/agents/skills/market/search?${params.toString()}`
  );
  const data = res.data;
  if (Array.isArray(data)) {
    return { items: data, total: data.length, page: 1, pageSize: data.length, totalPages: 1 };
  }
  return {
    items: data.items ?? [],
    total: data.total ?? 0,
    page: data.page ?? 1,
    pageSize: data.pageSize ?? 24,
    totalPages: data.totalPages ?? 1,
  };
}

export async function listSkillMarketInstalls(projectId: string): Promise<SkillMarketInstallRecord[]> {
  const res = await httpGet<{ data: SkillMarketInstallRecord[] }>(
    `/api/v1/agents/skills/installs?projectId=${encodeURIComponent(projectId)}`
  );
  return res.data;
}

export async function installSkillFromMarket(input: {
  projectId: string;
  externalSkillId: string;
}): Promise<SkillMarketInstallRecord> {
  const res = await httpPost<{ data: SkillMarketInstallRecord }>("/api/v1/agents/skills/installs", input);
  return res.data;
}

export async function deleteSkillMarketInstall(projectId: string, installId: string): Promise<void> {
  await httpDelete<{ ok: boolean }>(
    `/api/v1/agents/skills/installs/${encodeURIComponent(installId)}?projectId=${encodeURIComponent(projectId)}`
  );
}

export async function appendAgentDraftSkills(
  definitionId: string,
  skillNames: string[]
): Promise<AgentDefinitionDraftRecord> {
  const res = await httpPost<{ data: AgentDefinitionDraftRecord }>(
    `/api/v1/agents/definitions/${encodeURIComponent(definitionId)}/draft/append-skills`,
    { skillNames }
  );
  return res.data;
}

export async function uninstallMcpProjectInstall(input: {
  projectId: string;
  installId: string;
}): Promise<McpProjectInstallRecord> {
  const res = await httpDelete<{ data: McpProjectInstallRecord }>(
    `/api/v1/agents/mcp/market/installs/${encodeURIComponent(input.installId)}?projectId=${encodeURIComponent(input.projectId)}`
  );
  return res.data;
}

export async function testMcpProjectInstall(input: {
  installId: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
}): Promise<{
  serverName: string;
  toolName: string;
  transport: "stdio" | "http" | "ws";
  accepted: boolean;
  output: Record<string, unknown>;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      serverName: string;
      toolName: string;
      transport: "stdio" | "http" | "ws";
      accepted: boolean;
      output: Record<string, unknown>;
    };
  }>(`/api/v1/agents/mcp/market/installs/${input.installId}/test`, {
    toolName: input.toolName,
    arguments: input.arguments,
  });
  return res.data;
}

export async function installMcpCatalog(input: {
  catalogId: string;
  serverName: string;
  command?: string;
  url?: string;
  toolName?: string;
  timeoutMs?: number;
}): Promise<McpCatalogInstallRecord> {
  const res = await httpPost<{ data: McpCatalogInstallRecord }>("/api/v1/agents/mcp/catalog/install", input);
  return res.data;
}

export async function testMcpCatalog(input: {
  catalogId: string;
  serverName: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
}): Promise<{
  serverName: string;
  toolName: string;
  transport: "stdio" | "http" | "ws";
  accepted: boolean;
  output: Record<string, unknown>;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      serverName: string;
      toolName: string;
      transport: "stdio" | "http" | "ws";
      accepted: boolean;
      output: Record<string, unknown>;
    };
  }>(`/api/v1/agents/mcp/catalog/${input.catalogId}/test`, {
    serverName: input.serverName,
    toolName: input.toolName,
    arguments: input.arguments ?? { ping: true, ts: Date.now() },
  });
  return res.data;
}

export type TraderSessionContext = {
  workflowRunId: string;
  projectId: string;
  sessionId: string;
  created?: boolean;
};

export type TraderDriverKind =
  | "scheduled_job"
  | "strategy_runtime"
  | "news"
  | "communication"
  | "alert"
  | "user_command"
  | "interval_poll";

export type TraderDriverEvent = {
  type: "driver";
  id: string;
  ts: string;
  driverKind: TraderDriverKind;
  title: string;
  detail: string;
  payload?: Record<string, unknown>;
};

export type TraderAgentMessageEvent = {
  type: "agent_message";
  id: string;
  ts: string;
  workflowRunId: string;
  messageType: string;
  senderRole: string;
  receiverRole: string | null;
  summary: string;
  payload: Record<string, unknown>;
};

export type TraderFeedEvent =
  | {
      type: "strategy_log";
      id: string;
      ts: string;
      runtimeId: string;
      level: string;
      message: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "order";
      id: string;
      ts: string;
      side: string;
      symbol: string;
      qty: number;
      status: string;
      orderIntentId: string;
    };

export async function ensureTraderSession(input: {
  projectId: string;
  sessionId: string;
}): Promise<TraderSessionContext> {
  const res = await httpPost<{ ok: boolean; data: TraderSessionContext }>("/api/v1/trader/session", input);
  return res.data;
}

export async function placeTraderOrder(input: {
  workflowRunId: string;
  symbol: string;
  exchange: string;
  side: "buy" | "sell";
  qty: number;
  price?: number | null;
  orderType?: "market" | "limit";
  timeframe?: string;
  rationale?: string;
  executionMode?: "paper" | "live";
  strategyRuntimeId?: string;
  signalBarTime?: string;
}): Promise<{
  orderIntentId: string;
  executionTaskId: string | null;
  riskOutcome: string;
  riskReason: string;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      orderIntentId: string;
      executionTaskId: string | null;
      riskOutcome: string;
      riskReason: string;
    };
    error?: string;
  }>("/api/v1/trader/orders", input);
  if (!res.ok) throw new Error(res.error ?? "place_order_failed");
  return res.data;
}

export async function cancelTraderOrder(input: {
  orderIntentId?: string;
  brokerOrderId?: string;
  workflowRunId?: string;
}): Promise<{ cancelled: boolean; detail: string }> {
  const res = await httpPost<{
    ok: boolean;
    data: { cancelled: boolean; detail: string };
    error?: string;
  }>("/api/v1/trader/orders/cancel", input);
  if (!res.ok) throw new Error(res.error ?? "cancel_failed");
  return res.data;
}

export type TraderContextMessageDto = {
  id: string;
  ts: string;
  role: string;
  kind: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
};

export async function pollTraderFeed(input: {
  sessionId: string;
  workflowRunId: string;
  symbol: string;
  exchange: string;
  since?: string;
  includeNews?: boolean;
}): Promise<{
  events: TraderFeedEvent[];
  drivers: TraderDriverEvent[];
  agentMessages: TraderAgentMessageEvent[];
  contextMessages: TraderContextMessageDto[];
  serverTime: string;
}> {
  const q = new URLSearchParams();
  q.set("sessionId", input.sessionId);
  q.set("workflowRunId", input.workflowRunId);
  q.set("symbol", input.symbol);
  if (input.exchange) q.set("exchange", input.exchange);
  if (input.since) q.set("since", input.since);
  if (input.includeNews === false) q.set("includeNews", "false");
  const res = await httpGet<{
    ok: boolean;
    data: {
      events: TraderFeedEvent[];
      drivers: TraderDriverEvent[];
      agentMessages: TraderAgentMessageEvent[];
      contextMessages: TraderContextMessageDto[];
      serverTime: string;
    };
  }>(`/api/v1/trader/feed?${q.toString()}`);
  return res.data;
}

export async function runTraderCommand(input: {
  workflowRunId: string;
  sessionId: string;
  symbol: string;
  exchange: string;
  timeframe?: string;
  text: string;
  executionMode?: "paper" | "live";
}): Promise<{
  data?: {
    orderIntentId: string;
    executionTaskId: string | null;
    riskOutcome: string;
    riskReason: string;
  };
  parsed: { action: string; qty?: number };
}> {
  const res = await httpPost<{
    ok: boolean;
    data?: {
      orderIntentId: string;
      executionTaskId: string | null;
      riskOutcome: string;
      riskReason: string;
    };
    parsed: { action: string; qty?: number };
    error?: string;
  }>("/api/v1/trader/command", input);
  if (!res.ok) throw new Error(res.error ?? "command_failed");
  return { data: res.data, parsed: res.parsed };
}

export async function listStrategyRuntimeLogs(
  runtimeId: string,
  limit = 50
): Promise<{ id: string; level: string; message: string; createdAt: string; payloadJson?: Record<string, unknown> }[]> {
  const res = await httpGet<{
    ok: boolean;
    data: { id: string; level: string; message: string; createdAt: string; payloadJson?: Record<string, unknown> }[];
  }>(`/api/v1/strategy-runtimes/${encodeURIComponent(runtimeId)}/logs?limit=${limit}`);
  return res.data;
}

export type StrategyRuntimeRecord = {
  id: string;
  strategyScriptId: string;
  brokerAccountId: string | null;
  status: "stopped" | "starting" | "running" | "error" | "stopping";
  executionMode: "paper" | "live";
  market: string;
  symbol: string;
  timeframe: string;
  paramsJson: Record<string, unknown>;
  lastBarTime: string | null;
  lastSignalAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listStrategyRuntimes(input?: {
  workflowRunId?: string;
  sessionId?: string;
  status?: string;
}): Promise<StrategyRuntimeRecord[]> {
  const q = new URLSearchParams();
  if (input?.workflowRunId) q.set("workflowRunId", input.workflowRunId);
  if (input?.sessionId) q.set("sessionId", input.sessionId);
  if (input?.status) q.set("status", input.status);
  const suffix = q.toString();
  const res = await httpGet<{ ok: boolean; data: StrategyRuntimeRecord[] }>(
    `/api/v1/strategy-runtimes${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function createStrategyRuntime(input: {
  strategyScriptId: string;
  market: string;
  symbol: string;
  timeframe?: string;
  executionMode?: "paper" | "live";
  brokerAccountId?: string;
  params?: Record<string, unknown>;
  autoStart?: boolean;
}): Promise<StrategyRuntimeRecord> {
  const res = await httpPost<{ ok: boolean; data: StrategyRuntimeRecord; error?: string }>(
    "/api/v1/strategy-runtimes",
    input
  );
  if (!res.ok) throw new Error(res.error ?? "create_strategy_runtime_failed");
  return res.data;
}

export async function startStrategyRuntime(id: string): Promise<StrategyRuntimeRecord> {
  const res = await httpPost<{ ok: boolean; data: StrategyRuntimeRecord }>(
    `/api/v1/strategy-runtimes/${id}/start`,
    {}
  );
  return res.data;
}

export async function stopStrategyRuntime(id: string): Promise<StrategyRuntimeRecord> {
  const res = await httpPost<{ ok: boolean; data: StrategyRuntimeRecord }>(
    `/api/v1/strategy-runtimes/${id}/stop`,
    {}
  );
  return res.data;
}

export async function getStrategyRuntime(id: string): Promise<{
  runtime: StrategyRuntimeRecord;
  recentLogs: { id: string; level: string; message: string; createdAt: string }[];
}> {
  const res = await httpGet<{
    ok: boolean;
    data: {
      runtime: StrategyRuntimeRecord;
      recentLogs: { id: string; level: string; message: string; createdAt: string }[];
    };
  }>(`/api/v1/strategy-runtimes/${id}`);
  return res.data;
}

