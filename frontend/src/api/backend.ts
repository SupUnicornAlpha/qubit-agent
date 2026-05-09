import { httpGet, httpPatch, httpPost, httpPut } from "./client";
import type {
  AgentSummary,
  AgentDefinitionBundle,
  AgentsConfigResponse,
  AgentRoleCatalogItem,
  DebateConfig,
  DebateStreamEvent,
  DebateTurnRecord,
  DebateVerdictRecord,
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
  ChatMessage,
  ChatSession,
  ModelConfig,
  SessionOverview,
  SessionAgentBoardItem,
  SignalFusionRecord,
  StepStreamEvent,
  WorkflowDetail,
  WorkflowTimeline,
  WorkflowCreateInput,
} from "./types";

export async function getHealth(): Promise<{ status: string }> {
  return httpGet<{ status: string }>("/health");
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
  runId: string;
}> {
  return httpPost("/api/v1/workflows", input);
}

export async function listAgentDefinitions(): Promise<AgentDefinitionBundle[]> {
  const res = await httpGet<{ data: AgentDefinitionBundle[] }>("/api/v1/agents/definitions");
  return res.data;
}

export async function createAgentDraft(params: {
  definitionId: string;
  systemPrompt?: string;
  changeNote?: string;
  llmProvider?: string;
  maxIterations?: number;
  profile?: {
    displayName?: string;
    soulFileRef?: string;
    description?: string;
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

export async function getModelConfig(): Promise<ModelConfig> {
  const res = await httpGet<{ data: ModelConfig }>("/api/v1/agents/model-config");
  return res.data;
}

export async function saveModelConfig(input: Partial<ModelConfig>): Promise<ModelConfig> {
  const res = await httpPost<{ data: ModelConfig }>("/api/v1/agents/model-config", input);
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

export async function getSessionAgentsBoard(sessionId: string): Promise<SessionAgentBoardItem[]> {
  const res = await httpGet<{ data: { agents: SessionAgentBoardItem[] } }>(
    `/api/v1/monitor/sessions/${sessionId}/agents-board`
  );
  return res.data.agents;
}

// ─── V2 分析师团队 API ────────────────────────────────────────────────────────

export async function runAnalystTeam(params: {
  workflowRunId: string;
  ticker: string;
  context?: string;
}): Promise<AnalystTeamResult> {
  const res = await httpPost<{ ok: boolean; data: AnalystTeamResult }>("/api/v1/analyst/run", params);
  return res.data;
}

export async function getAnalystSignals(workflowId: string): Promise<AnalystSignalRecord[]> {
  const res = await httpGet<{ ok: boolean; data: AnalystSignalRecord[] }>(
    `/api/v1/analyst/signals/${workflowId}`
  );
  return res.data;
}

export async function getSignalFusion(workflowId: string): Promise<AnalystTeamResult | null> {
  const res = await httpGet<{ ok: boolean; data: AnalystTeamResult | null }>(
    `/api/v1/analyst/fusion/${workflowId}`
  );
  return res.data;
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
  const res = await httpGet<{ ok: boolean; data: SignalFusionRecord[] }>(
    `/api/v1/analyst/fusion/history?${query.toString()}`
  );
  return res.data;
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
  const base = localStorage.getItem("qubit_backend_url") ?? "http://localhost:3000";
  const url = `${base}/api/v1/debate/stream/${params.workflowRunId}`;
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

export function subscribeWorkflowStream(params: {
  workflowId: string;
  runId: string;
  onEvent: (event: StepStreamEvent) => void;
  onError?: (err: Event) => void;
}): () => void {
  const base = localStorage.getItem("qubit_backend_url") ?? "http://localhost:3000";
  const url = `${base}/api/v1/workflows/${params.workflowId}/stream/${params.runId}`;
  const es = new EventSource(url);
  const types: StepStreamEvent["type"][] = [
    "token",
    "tool_call_start",
    "tool_call_end",
    "observe",
    "step_persisted",
    "final",
    "error",
  ];
  for (const t of types) {
    es.addEventListener(t, (ev) => {
      const msg = ev as MessageEvent<string>;
      params.onEvent(JSON.parse(msg.data) as StepStreamEvent);
    });
  }
  es.onerror = (err) => {
    params.onError?.(err);
  };
  return () => es.close();
}

