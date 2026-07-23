import { backendFetchUrl, httpDelete, httpGet, httpPatch, httpPost, httpPut } from "./client";
import type {
  AgentLoopKind,
  AgentSkillRecord,
  AgentSkillState,
  AgentSummary,
  AgentDefinitionBundle,
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
  IntegrationAdapterDescriptor,
  IntegrationKind,
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
  SubAgentTaskRecord,
  AnalystSignalFusionRecord,
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
  WindSessionStatus,
  AgentDefinitionDraftRecord,
  OpenSkillMarketEntryDto,
  SkillMarketPageResult,
  SkillMarketInstallRecord,
  SkillMarketStatusDto,
  ToolCatalogEntry,
  RecommendationRecord,
  RecommendationSide,
  RecommendationStats,
  RecommendationStatus,
} from "./types";
import { normalizeFusionApiToTeamResult } from "../lib/fusionNormalize";

export async function runSystemBootstrap(input?: {
  skipPython?: boolean;
}): Promise<{
  migrations: boolean;
  seed: boolean;
  pythonVenv: string;
  pythonMessage?: string;
  dataDir: string;
  appRoot: string;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      migrations: boolean;
      seed: boolean;
      pythonVenv: string;
      pythonMessage?: string;
      dataDir: string;
      appRoot: string;
    };
  }>("/api/v1/system/bootstrap", input ?? {});
  return res.data;
}

export async function listRecommendations(
  params: {
    projectId?: string;
    symbol?: string;
    side?: RecommendationSide;
    status?: RecommendationStatus;
    limit?: number;
  } = {}
): Promise<RecommendationRecord[]> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("project_id", params.projectId);
  if (params.symbol) query.set("symbol", params.symbol);
  if (params.side) query.set("side", params.side);
  if (params.status) query.set("status", params.status);
  if (params.limit != null) query.set("limit", String(params.limit));
  const res = await httpGet<{ ok: boolean; data: RecommendationRecord[] }>(
    `/api/v1/recommendations?${query.toString()}`
  );
  return res.data;
}

export async function getRecommendationStats(projectId?: string): Promise<RecommendationStats> {
  const query = new URLSearchParams();
  if (projectId) query.set("project_id", projectId);
  const res = await httpGet<{ ok: boolean; data: RecommendationStats }>(
    `/api/v1/recommendations/stats?${query.toString()}`
  );
  return res.data;
}

export async function runRecommendationOutcomes(
  input: {
    projectId?: string;
    limit?: number;
    force?: boolean;
  } = {}
): Promise<{
  scanned: number;
  evaluated: number;
  notReady: number;
  invalid: number;
  failed: number;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: { scanned: number; evaluated: number; notReady: number; invalid: number; failed: number };
  }>("/api/v1/recommendations/outcomes/run", input);
  return res.data;
}

export interface SystemPythonDepStatus {
  name: string;
  available: boolean;
  required: boolean;
  version?: string;
  error?: string;
}

export interface SystemPythonHealthReport {
  ok: boolean;
  binPath: string;
  binKind: "system" | "venv" | "explicit";
  pythonVersion?: string;
  dependencies: SystemPythonDepStatus[];
  errorCode?:
    | "python_unavailable"
    | "python_exit_nonzero"
    | "python_deps_missing"
    | "probe_timeout";
  hint?: string;
  checkedAt: string;
}

/**
 * Python 沙箱/算子运行时健康自检：解释器路径、版本、必需(pandas/numpy)与可选(scipy)依赖。
 * 默认会命中后端 60s 缓存；force=true 强制重新探测（venv 冷启可能 10-30s）。
 */
export async function getSystemPythonHealth(force?: boolean): Promise<SystemPythonHealthReport> {
  const path = force ? "/api/v1/system/python-health?force=true" : "/api/v1/system/python-health";
  const res = await httpGet<{ ok: boolean; data: SystemPythonHealthReport }>(path);
  return res.data;
}

// ─── EnvironmentManager（详见 docs/ENVIRONMENT_MANAGER_DESIGN.md §6.6）──────

export type EnvKind = "python" | "npm";
export type EnvStatus = "enabled" | "disabled";
export type EnvSource = "requirements" | "connector-meta" | "seed-mcp" | "user";
export type EnvOk = "ok" | "warn" | "error";

export interface ExpectedPackage {
  id: string;
  kind: EnvKind;
  name: string;
  displayName: string;
  description: string;
  versionSpec: string | null;
  userVersionSpec: string | null;
  effectiveVersionSpec: string | null;
  optional: boolean;
  capability: string;
  source: EnvSource;
  status: EnvStatus;
  isBuiltin: boolean;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InstalledPackage {
  name: string;
  version: string;
  installPath?: string;
}

export interface PackageDiff {
  expected: ExpectedPackage[];
  installed: InstalledPackage[];
  satisfied: ExpectedPackage[];
  missing: ExpectedPackage[];
  versionMismatch: Array<{ expected: ExpectedPackage; installed: InstalledPackage }>;
  orphan: InstalledPackage[];
}

export interface ConnectorProbe {
  name: string;
  type: string;
  status: "healthy" | "degraded" | "unhealthy" | "error";
  latencyMs: number | null;
  message: string;
  checkedAt: string;
}

export interface EnvironmentStatus {
  ok: EnvOk;
  summary: string;
  pythonBin: string;
  python: PackageDiff & { hasPipFailure: boolean };
  npm: PackageDiff;
  connectors: ConnectorProbe[];
  generatedAt: string;
}

export type EnvInstallLogStatus = "running" | "success" | "failed" | "timeout";
export type EnvInstallOperation = "install" | "uninstall" | "upgrade";

export interface EnvInstallLogEntry {
  id: string;
  kind: EnvKind;
  operation: EnvInstallOperation;
  packageName: string;
  requestedVersion: string | null;
  installedVersion: string | null;
  status: EnvInstallLogStatus;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string;
}

export interface EnvRegistryCreateInput {
  kind: EnvKind;
  packageName: string;
  displayName: string;
  description?: string;
  versionSpec?: string | null;
  optional?: boolean;
  capability?: string;
}

export interface EnvRegistryPatchInput {
  status?: EnvStatus;
  userVersionSpec?: string | null;
  displayName?: string;
  description?: string;
  optional?: boolean;
  capability?: string;
}

/**
 * 顶层环境状态（python diff + npm diff + connector probes）。
 * 该接口比较慢（拉 pip list + 扫盘 + connector probes），UI 上记得显示 loading
 * 并避免高频轮询；status 页面建议手动 refresh。
 */
export async function getEnvironmentStatus(): Promise<EnvironmentStatus> {
  const r = await httpGet<{ ok: boolean; data: EnvironmentStatus }>("/api/v1/environment/status");
  return r.data;
}

export async function listEnvRegistry(kind?: EnvKind): Promise<ExpectedPackage[]> {
  const path = kind
    ? `/api/v1/environment/registry?kind=${encodeURIComponent(kind)}`
    : "/api/v1/environment/registry";
  const r = await httpGet<{ ok: boolean; data: ExpectedPackage[] }>(path);
  return r.data;
}

export async function createEnvRegistryItem(
  input: EnvRegistryCreateInput
): Promise<ExpectedPackage> {
  const r = await httpPost<{ ok: boolean; data: ExpectedPackage }>(
    "/api/v1/environment/registry",
    input
  );
  return r.data;
}

export async function patchEnvRegistryItem(
  id: string,
  patch: EnvRegistryPatchInput
): Promise<ExpectedPackage> {
  const r = await httpPatch<{ ok: boolean; data: ExpectedPackage }>(
    `/api/v1/environment/registry/${encodeURIComponent(id)}`,
    patch
  );
  return r.data;
}

export async function deleteEnvRegistryItem(id: string): Promise<void> {
  await httpDelete(`/api/v1/environment/registry/${encodeURIComponent(id)}`);
}

export async function installEnvPackage(
  kind: EnvKind,
  packageName: string,
  versionSpec?: string
): Promise<{ logId: string }> {
  const path =
    kind === "python" ? "/api/v1/environment/python/install" : "/api/v1/environment/npm/install";
  const body =
    kind === "python"
      ? { packageName, versionSpec: versionSpec ?? null }
      : { packageName, version: versionSpec ?? null };
  const r = await httpPost<{ ok: boolean; data: { logId: string } }>(path, body);
  return r.data;
}

export async function uninstallEnvPackage(
  kind: EnvKind,
  packageName: string
): Promise<{ logId: string }> {
  const path =
    kind === "python"
      ? "/api/v1/environment/python/uninstall"
      : "/api/v1/environment/npm/uninstall";
  const r = await httpPost<{ ok: boolean; data: { logId: string } }>(path, {
    packageName,
  });
  return r.data;
}

export async function listEnvInstallLog(filter: {
  kind?: EnvKind;
  packageName?: string;
  limit?: number;
}): Promise<EnvInstallLogEntry[]> {
  const params = new URLSearchParams();
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.packageName) params.set("packageName", filter.packageName);
  if (filter.limit) params.set("limit", String(filter.limit));
  const path = params.toString()
    ? `/api/v1/environment/install-log?${params.toString()}`
    : "/api/v1/environment/install-log";
  const r = await httpGet<{ ok: boolean; data: EnvInstallLogEntry[] }>(path);
  return r.data;
}

export async function getHealth(): Promise<{
  status: "ok" | "degraded" | string;
  marketData?: import("./types").MarketDataReadiness;
}> {
  return httpGet<{
    status: "ok" | "degraded" | string;
    marketData?: import("./types").MarketDataReadiness;
  }>("/health");
}

export async function listMarketDataSources(): Promise<{
  data: import("./types").MarketDataSourceRecord[];
  readiness: import("./types").MarketDataReadiness;
}> {
  const res = await httpGet<{
    ok: boolean;
    data: import("./types").MarketDataSourceRecord[];
    readiness: import("./types").MarketDataReadiness;
  }>("/api/v1/market/data-sources");
  return { data: res.data, readiness: res.readiness };
}

export async function checkMarketDataSources(sourceId?: string): Promise<{
  data: import("./types").MarketDataSourceRecord[];
  readiness: import("./types").MarketDataReadiness;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: import("./types").MarketDataSourceRecord[];
    readiness: import("./types").MarketDataReadiness;
  }>("/api/v1/market/data-sources/health", sourceId ? { sourceId } : {});
  return { data: res.data, readiness: res.readiness };
}

export async function patchMarketDataSource(
  id: string,
  patch: { status?: "active" | "inactive"; priority?: number; isFallback?: boolean }
): Promise<void> {
  await httpPatch(`/api/v1/market/data-sources/${encodeURIComponent(id)}`, patch);
}

export async function getKlines(params: {
  symbol: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
}): Promise<{
  ok: boolean;
  data: KlineBar[];
  meta: KlinesResponseMeta;
  error?: KlinesErrorPayload;
}> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol);
  if (params.exchange) q.set("exchange", params.exchange);
  if (params.timeframe) q.set("timeframe", params.timeframe);
  if (params.limit !== undefined) q.set("limit", String(params.limit));
  return httpGet<{
    ok: boolean;
    data: KlineBar[];
    meta: KlinesResponseMeta;
    error?: KlinesErrorPayload;
  }>(`/api/v1/market/klines?${q.toString()}`);
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

export async function getWindSessionStatus(): Promise<{
  ok: boolean;
  data?: WindSessionStatus;
  error?: string;
}> {
  return httpGet<{ ok: boolean; data?: WindSessionStatus; error?: string }>(
    "/api/v1/market/wind/session"
  );
}

export async function loginWindSession(input?: {
  username?: string;
  password?: string;
  startWaitSec?: number;
}): Promise<{ ok: boolean; data?: WindSessionStatus; error?: string }> {
  return httpPost<{ ok: boolean; data?: WindSessionStatus; error?: string }>(
    "/api/v1/market/wind/session/login",
    input ?? {}
  );
}

export async function reconnectWindSession(): Promise<{
  ok: boolean;
  data?: WindSessionStatus;
  error?: string;
}> {
  return httpPost<{ ok: boolean; data?: WindSessionStatus; error?: string }>(
    "/api/v1/market/wind/session/reconnect",
    {}
  );
}

export async function resetWindSession(): Promise<{
  ok: boolean;
  data?: { reset: boolean };
  error?: string;
}> {
  return httpPost<{ ok: boolean; data?: { reset: boolean }; error?: string }>(
    "/api/v1/market/wind/session/reset",
    {}
  );
}

export type MarketBacktestJobStatus = "queued" | "running" | "completed" | "failed";

export interface MarketBacktestPostBody {
  kind?: "sma_crossover" | "python_strategy" | string;
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
  /** kind=python_strategy 时携带的 Python on_init/on_bar 源码（=IDE 左侧代码）。 */
  strategyCode?: string;
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
  return httpPost<MarketBacktestPostResponse>(
    "/api/v1/market/backtests",
    body as unknown as Record<string, unknown>
  );
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

/**
 * 单租户兜底 workspace。前端任何 boot 路径都该走这个，**不要再自己 createWorkspace** ——
 * 历史 3 处 `if (!workspaces[0]) createWorkspace(...)` 兜底因为 A2A Pool（system）
 * 永远占着 workspaces[0]，从未触发；导致桌面用户上车默认用了 system workspace。
 * 详见 src/runtime/bootstrap/ensure-default-workspace.ts。
 */
export async function getDefaultWorkspace(): Promise<{ id: string; name: string; owner: string }> {
  const res = await httpGet<{ data: { id: string; name: string; owner: string } }>(
    "/api/v1/workspaces/default"
  );
  return res.data;
}

export async function createWorkspace(input: { name: string; owner: string }): Promise<{
  data: { id: string; name: string };
}> {
  return httpPost("/api/v1/workspaces", input);
}

export async function listProjects(
  workspaceId: string
): Promise<Array<{ id: string; name: string }>> {
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

/**
 * 幂等 get-or-create default project（后端写死稳定 ID）。
 *
 * 前端 boot 路径统一走这个，**不要再自己 createProject 兜底** —— 历史 4 处
 * `if (!project) createProject({name:"QUBIT Default Project"})` 并发上车会各建一份同名
 * project，攒出重复。后端 get-or-create 天然幂等，并发多少次都返回同一行。
 * 详见 src/runtime/bootstrap/ensure-default-workspace.ts:ensureDefaultUserProject。
 */
export async function getOrCreateDefaultProject(): Promise<{
  id: string;
  workspaceId: string;
  name: string;
  marketScope: string;
}> {
  const res = await httpGet<{
    data: { id: string; workspaceId: string; name: string; marketScope: string };
  }>("/api/v1/workspaces/default/projects/default");
  return res.data;
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

export async function createConversationTurn(input: {
  sessionId: string;
  projectId: string;
  message: string;
  workflowRunId?: string;
  workflowMode?: import("./types").WorkflowMode;
  reuseSessionWorkflow?: boolean;
  loopKind?: import("./types").AgentLoopKind;
  roleReasoner?: import("./types").AgentLoopKind;
  hitlMode?: "off" | "ai" | "always";
  agentMode?: import("./types").AgentControlMode;
  processConfig?: import("./types").WorkflowProcessConfig;
}): Promise<import("./types").ConversationTurnResult> {
  const { sessionId, ...body } = input;
  const res = await httpPost<{
    ok: boolean;
    data: import("./types").ConversationTurnResult;
  }>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns`, body);
  return res.data;
}

/**
 * Agent 心跳 / loop 活跃度。
 *
 * 用法：前端在拓扑画布 / 会话流 / 工作流列表 旁边定时 poll（建议 3-5s 一次）
 * 来显示"Agent 还在跑吗、第几轮、最后一步是什么阶段、沉默了多久"。
 *
 * 沉默阈值建议：
 *   - silenceMs < 30_000  → 绿色（健康）
 *   - 30_000-120_000     → 橙色（缓慢但仍活跃）
 *   - > 120_000          → 红色（疑似卡住，建议给提示）
 */
export type AgentHeartbeat = {
  instanceId: string;
  role: string;
  name: string;
  status: string;
  currentIteration: number;
  lastPhase: "perceive" | "reason" | "act" | "observe" | "finalize" | null;
  lastStepIndex: number | null;
  lastStepAt: string | null;
  silenceMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  alive: boolean;
};

export type WorkflowAgentHeartbeatsResponse = {
  workflowRunId: string;
  status: string;
  heartbeats: AgentHeartbeat[];
  summary: {
    aliveAgents: number;
    totalAgents: number;
    lastStepAt: string | null;
    silenceMs: number | null;
    totalSteps: number;
    asOf: string;
  };
};

export async function getWorkflowAgentHeartbeats(
  workflowId: string
): Promise<WorkflowAgentHeartbeatsResponse> {
  return httpGet<WorkflowAgentHeartbeatsResponse>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/agent-heartbeats`
  );
}

export type WorkflowHeartbeatStreamCallbacks = {
  onSnapshot: (snapshot: WorkflowAgentHeartbeatsResponse) => void;
  /** workflow 落入终态时收到一次（status='completed' / 'failed' / ...）。
   *  之后 SSE 流会被服务端关闭，前端可停止等待新事件。 */
  onEnd?: (info: { workflowRunId: string; status: string }) => void;
  /** 网络错误 / workflow 不存在时收到一次。前端可降级到 polling。 */
  onError?: (info: { reason: "http_error" | "fetch_error" | "workflow_not_found" }) => void;
};

/**
 * 订阅 workflow 心跳 SSE 推流，替代 4s polling。
 *
 * - 使用 fetch + ReadableStream（跟 subscribeWorkflowStream 一致），避免 EventSource 在
 *   Tauri/WebView 下的伪 reconnect / "error on close" 问题。
 * - 服务端在 workflow 终态时会主动 close；前端 onEnd 回调先触发再结束。
 * - 返回的 unsubscribe 可在组件 unmount 时调用。
 */
export function subscribeWorkflowHeartbeatStream(params: {
  workflowId: string;
  callbacks: WorkflowHeartbeatStreamCallbacks;
}): () => void {
  const { workflowId, callbacks } = params;
  const url = backendFetchUrl(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/agent-heartbeats/stream`
  );
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
        if (active) callbacks.onError?.({ reason: "http_error" });
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
          dispatchHeartbeatEvent(parsed.eventName, parsed.data, callbacks);
        }
      }
    } catch (e) {
      if (!active) return;
      const name = e instanceof Error ? e.name : "";
      if (name === "AbortError") return;
      callbacks.onError?.({ reason: "fetch_error" });
    }
  };

  void run();

  return () => {
    active = false;
    ac.abort();
  };
}

function dispatchHeartbeatEvent(
  eventName: string,
  rawData: string,
  callbacks: WorkflowHeartbeatStreamCallbacks
): void {
  try {
    const data = JSON.parse(rawData) as unknown;
    if (eventName === "heartbeat") {
      callbacks.onSnapshot(data as WorkflowAgentHeartbeatsResponse);
    } else if (eventName === "heartbeat_end") {
      const info = data as { workflowRunId: string; status: string };
      callbacks.onEnd?.(info);
    } else if (eventName === "heartbeat_error") {
      const info = data as { workflowRunId: string; error: string };
      if (info.error === "workflow_not_found") {
        callbacks.onError?.({ reason: "workflow_not_found" });
      } else {
        callbacks.onError?.({ reason: "fetch_error" });
      }
    }
    /** 其他事件名静默忽略（兼容服务端将来加新事件） */
  } catch {
    /** malformed JSON：忽略，下一帧再说 */
  }
}

export async function approveWorkflowHitl(
  workflowId: string,
  requestId: string
): Promise<{ workflowRunId: string; resumed: boolean; runId?: string; idempotent?: boolean }> {
  const res = await httpPost<{
    ok: boolean;
    data: { workflowRunId: string; resumed: boolean; runId?: string; idempotent?: boolean };
  }>(`/api/v1/workflows/${workflowId}/hitl/${requestId}/approve`, {});
  return res.data;
}

export async function rejectWorkflowHitl(
  workflowId: string,
  requestId: string
): Promise<{ workflowRunId: string; resumed: boolean; idempotent?: boolean }> {
  const res = await httpPost<{
    ok: boolean;
    data: { workflowRunId: string; resumed: boolean; idempotent?: boolean };
  }>(`/api/v1/workflows/${workflowId}/hitl/${requestId}/reject`, {});
  return res.data;
}

/**
 * 运行中「随时插话」：把一条用户消息入队，ReAct 循环下一轮 reason 前 drain 注入。
 * 软注入，不阻塞工作流；返回当前还有多少条未消费（queued）。
 */
export async function injectWorkflowMessage(
  workflowId: string,
  content: string,
  targetRole?: string | null
): Promise<{ id: string; queued: number }> {
  const res = await httpPost<{ ok: boolean; data: { id: string; queued: number } }>(
    `/api/v1/workflows/${workflowId}/inject-message`,
    { content, targetRole: targetRole ?? null }
  );
  return res.data;
}

/**
 * 对话消息入口（区别于「启动团队分析」按钮）：把消息交给 Orchestrator 跑 ReAct 自主判断
 * （直接回答 / assign_task 派单 / run_analyst_team 跑全队）。立即返回 202，结果经 token
 * firehose 流式 + team-graph 轮询出现在右栏。
 */
export async function runOrchestratorChat(
  workflowRunId: string,
  message: string,
  hitlMode?: "off" | "ai" | "always",
  roleReasoner?: AgentLoopKind,
  agentMode?: import("./types").AgentControlMode
): Promise<{ status: string }> {
  const res = await httpPost<{ ok: boolean; status: string }>("/api/v1/analyst/orchestrator-chat", {
    workflowRunId,
    message,
    ...(hitlMode ? { hitlMode } : {}),
    ...(roleReasoner ? { roleReasoner } : {}),
    ...(agentMode ? { agentMode } : {}),
  });
  return { status: res.status ?? "running" };
}

/**
 * 协作式中断：请求中断正在运行的团队研究。团队会在下一个 wave 边界停在断点，起一个
 * free_form HITL 等用户输入新提示词后续跑。立即返回（真正暂停发生在下一个安全断点）。
 */
export async function interruptWorkflow(
  workflowId: string
): Promise<{ workflowRunId: string; requested: boolean }> {
  const res = await httpPost<{ ok: boolean; data: { workflowRunId: string; requested: boolean } }>(
    `/api/v1/workflows/${workflowId}/interrupt`,
    {}
  );
  return res.data;
}

/**
 * v2：HITL 卡片支持的 4 种交互形态。
 * - approve_only：批准 / 拒绝（v1 兼容默认值）
 * - single_choice：单选（inputSchema.options 列出选项）
 * - multi_choice：多选（同上 + 可选 min/maxSelect）
 * - free_form：自由文本（inputSchema.placeholder/maxLength）
 */
export type HitlInputKind = "approve_only" | "single_choice" | "multi_choice" | "free_form";

export interface HitlInputSchema {
  options?: Array<{ label: string; value: string; description?: string }>;
  placeholder?: string;
  maxLength?: number;
  minSelect?: number;
  maxSelect?: number;
}

export interface HitlPendingRequest {
  id: string;
  title: string;
  summary: string;
  /** v2：交互形态；后端 drizzle 返回字段名为 inputKind */
  inputKind?: HitlInputKind;
  /** v2：渲染所需 schema；drizzle 返回字段名为 inputSchemaJson */
  inputSchemaJson?: HitlInputSchema;
  /** 已批准/拒绝时回填的用户内容（drizzle responseJson） */
  responseJson?: Record<string, unknown> | null;
}

export async function listPendingWorkflowHitl(workflowId: string): Promise<HitlPendingRequest[]> {
  const res = await httpGet<{
    data: HitlPendingRequest[];
  }>(`/api/v1/workflows/${workflowId}/hitl/pending`);
  return res.data;
}

/**
 * v2 统一端点 — 推荐前端使用。
 *   - approve_only：response 省略
 *   - single_choice：response = { value: string }
 *   - multi_choice：response = { values: string[] }
 *   - free_form：response = { text: string }
 * 详见 docs/HITL_REDESIGN.md §8。
 */
export async function resolveWorkflowHitl(
  workflowId: string,
  requestId: string,
  decision: "approved" | "rejected",
  response?: Record<string, unknown> | null
): Promise<{ workflowRunId: string; resumed: boolean; runId?: string; idempotent?: boolean }> {
  const res = await httpPost<{
    ok: boolean;
    data: { workflowRunId: string; resumed: boolean; runId?: string; idempotent?: boolean };
  }>(`/api/v1/workflows/${workflowId}/hitl/${requestId}/resolve`, {
    decision,
    response: response ?? null,
  });
  return res.data;
}

export async function patchWorkflow(
  workflowId: string,
  input: {
    sessionId?: string | null;
    goal?: string;
    status?: "pending" | "running" | "completed" | "failed" | "cancelled";
    loopOptionsJson?: Partial<import("./types").LoopOptionsJson>;
  }
): Promise<{ data: Record<string, unknown> }> {
  return httpPatch<{ data: Record<string, unknown> }>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
    input as Record<string, unknown>
  );
}

/**
 * 删除工作流。
 * - `{ hard: false }`（默认）：软删除，置为 cancelled，保留审计数据。
 * - `{ hard: true }`：硬删除，级联清理所有衍生数据（agent_*、a2a/acp、screener、order_intent、
 *   intent_order、langgraph_checkpoint 等），并把 audit_log / scheduled_job_run 等保留型反向引用置空。
 *
 * 调用前必须在 UI 上做二次确认。
 */
export async function deleteWorkflow(
  workflowId: string,
  options?: { hard?: boolean }
): Promise<{ ok: boolean; id: string; hard?: boolean; details?: Record<string, number> }> {
  const url = options?.hard
    ? `/api/v1/workflows/${encodeURIComponent(workflowId)}?hard=true`
    : `/api/v1/workflows/${encodeURIComponent(workflowId)}`;
  return httpDelete<{ ok: boolean; id: string; hard?: boolean; details?: Record<string, number> }>(
    url
  );
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
  const res = await httpPost<{ data: ScheduledJobRecord }>(
    "/api/v1/workflows/scheduled-jobs",
    input
  );
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
  const res = await httpPatch<{ data: ScheduledJobRecord }>(
    `/api/v1/workflows/scheduled-jobs/${id}`,
    input
  );
  return res.data;
}

export async function runScheduledJobNow(id: string): Promise<ScheduledJobRunRecord | null> {
  const res = await httpPost<{ ok: boolean; data: ScheduledJobRunRecord | null }>(
    `/api/v1/workflows/scheduled-jobs/${id}/run-now`,
    {}
  );
  return res.data;
}

export async function listScheduledJobRuns(
  id: string,
  limit = 50
): Promise<ScheduledJobRunRecord[]> {
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

export type ReloadBuiltinSeedResponse = {
  ok: boolean;
  report: {
    definitions: { total: number; reset: number; preserved: number };
    groups: { total: number; reset: number; preserved: number };
    force: boolean;
  };
  runtime: { before: number; after: number };
};

/**
 * 强制把所有内置 Agent 定义与编组重置回系统预设（会覆盖用户对内置项的改动）。
 */
export async function reloadBuiltinAgentSeed(): Promise<ReloadBuiltinSeedResponse> {
  return httpPost<ReloadBuiltinSeedResponse>("/api/v1/agents/builtin/reload", {});
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
  const res = await httpGet<{ data: AgentPackResponse }>(
    `/api/v1/agents/definitions/${definitionId}/pack`
  );
  return res.data;
}

export async function putAgentDefinitionPackFiles(
  definitionId: string,
  body: { agentMarkdown?: string; soulMarkdown: string; promptMarkdown: string }
): Promise<{
  packRoot: string;
  agentPath: string;
  soulPath: string;
  promptPath: string;
  hash: string;
}> {
  const res = await httpPut<{
    data: {
      packRoot: string;
      agentPath: string;
      soulPath: string;
      promptPath: string;
      hash: string;
    };
  }>(
    `/api/v1/agents/definitions/${definitionId}/pack/files`,
    body as unknown as Record<string, unknown>
  );
  return res.data;
}

export async function putAgentDefinitionPackSessionSnapshot(
  definitionId: string,
  body: { userMarkdown: string; memoryMarkdown: string }
): Promise<{ packRoot: string; userPath: string; memoryPath: string; hash: string }> {
  const res = await httpPut<{
    data: { packRoot: string; userPath: string; memoryPath: string; hash: string };
  }>(
    `/api/v1/agents/definitions/${definitionId}/pack/session-snapshot`,
    body as unknown as Record<string, unknown>
  );
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

export async function getAgentDefinitionMemoryStats(
  definitionId: string
): Promise<AgentMemoryStatsResponse> {
  const res = await httpGet<{ data: AgentMemoryStatsResponse }>(
    `/api/v1/agents/definitions/${definitionId}/memory-stats`
  );
  return res.data;
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
  const res = await httpGet<{ ok: boolean; data: ToolCatalogEntry[] }>(
    "/api/v1/agents/tools/catalog"
  );
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
  const res = await httpGet<{ data: BuiltinConnectorConfig }>(
    "/api/v1/agents/builtin-connector-config"
  );
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

/**
 * 删除会话。
 * - `{ hard: false }`（默认）：软删除，标记为 archived，保留消息与衍生数据。
 * - `{ hard: true }`：硬删除，级联删除该会话下的所有 workflow_run、chat_message、
 *   chat_message_workflow_link、indicator_strategy_script、scheduled_job 等。
 *
 * 调用前必须在 UI 上做二次确认（不可恢复）。
 */
export async function deleteChatSession(
  sessionId: string,
  options?: { hard?: boolean }
): Promise<{
  ok: boolean;
  id: string;
  hard?: boolean;
  details?: Record<string, number>;
  workflowRunIds?: string[];
}> {
  const url = options?.hard
    ? `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}?hard=true`
    : `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
  return httpDelete<{
    ok: boolean;
    id: string;
    hard?: boolean;
    details?: Record<string, number>;
    workflowRunIds?: string[];
  }>(url);
}

export async function getDefaultProjectSession(projectId: string): Promise<ChatSession> {
  const res = await httpGet<{ data: ChatSession }>(
    `/api/v1/chat/projects/${projectId}/sessions/default`
  );
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

export async function deleteStrategyScript(
  scriptId: string
): Promise<{ ok: boolean; deletedId: string }> {
  return httpDelete<{ ok: boolean; deletedId: string }>(
    `/api/v1/chat/strategy-scripts/${encodeURIComponent(scriptId)}`
  );
}

/**
 * 量化工作台「脚本工坊」专用聚合 DTO —— 返回 project 维度的 script summary，
 * 字段从 chat.routes 的 sessionId-only 列表升级到带 sessionTitle / projectId /
 * 代码长度统计，便于工坊侧无需逐条 fetch 全文。
 *
 * 注意：列表接口不返回 ideCode / signalCode 全文（数据量大），点详情时单查。
 */
export interface QuantStrategyScriptSummary {
  id: string;
  sessionId: string;
  sessionTitle: string;
  projectId: string | null;
  workflowRunId: string | null;
  name: string;
  purpose: "research" | "live_trading" | "both";
  ideCodeLength: number;
  signalCodeLength: number;
  hasAiPrompt: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuantStrategyScriptDetail extends QuantStrategyScriptSummary {
  ideCode: string;
  signalCode: string;
  aiPromptSnapshot: string | null;
  chartSnapshotJson: Record<string, unknown>;
}

export async function listProjectStrategyScripts(filter?: {
  projectId?: string;
  purpose?: "research" | "live_trading" | "both";
  workflowRunId?: string;
  sessionId?: string;
}): Promise<QuantStrategyScriptSummary[]> {
  const qs: string[] = [];
  if (filter?.projectId) qs.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  if (filter?.purpose) qs.push(`purpose=${encodeURIComponent(filter.purpose)}`);
  if (filter?.workflowRunId) qs.push(`workflow_run_id=${encodeURIComponent(filter.workflowRunId)}`);
  if (filter?.sessionId) qs.push(`session_id=${encodeURIComponent(filter.sessionId)}`);
  const url = qs.length
    ? `/api/v1/quant/strategy-scripts?${qs.join("&")}`
    : `/api/v1/quant/strategy-scripts`;
  const res = await httpGet<{ ok: boolean; data: QuantStrategyScriptSummary[] }>(url);
  return res.data;
}

export async function getProjectStrategyScript(
  scriptId: string
): Promise<QuantStrategyScriptDetail> {
  const res = await httpGet<{ ok: boolean; data: QuantStrategyScriptDetail }>(
    `/api/v1/quant/strategy-scripts/${encodeURIComponent(scriptId)}`
  );
  return res.data;
}

export async function createSessionMessage(params: {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  sender?: "user" | "orchestrator" | "agent" | "system";
  status?: "queued" | "running" | "completed" | "failed" | "awaiting_approval";
  workflowRunIds?: string[];
}): Promise<ChatMessage> {
  const { sessionId, ...payload } = params;
  const res = await httpPost<{ data: ChatMessage }>(
    `/api/v1/chat/sessions/${sessionId}/messages`,
    payload
  );
  return res.data;
}

export async function patchSessionMessage(params: {
  messageId: string;
  content?: string;
  status?: "queued" | "running" | "completed" | "failed" | "awaiting_approval";
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

/**
 * Agent 下钻详情：byTool / byMcp / bySkill / errorTopN + 最近实例。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3 与 src/runtime/monitor/quality-metrics.ts。
 */
export type AgentMetricBreakdownView = {
  byTool: Record<string, { count: number; error: number; avgLatencyMs: number | null }>;
  byMcp: Record<string, { count: number; error: number; avgLatencyMs: number | null }>;
  bySkill: Record<string, { count: number; fail: number }>;
  errorTopN: Array<{ message: string; count: number }>;
};

export type AgentRuntimeDetail = {
  definition: {
    id: string;
    role: string;
    name: string;
    version: string | number | null;
  } | null;
  window: { windowStart: string; windowEnd: string };
  metric: AgentRuntimeMetricRecord | null;
  breakdown: AgentMetricBreakdownView | null;
  recentInstances: Array<{
    id: string;
    workflowRunId: string;
    status: string;
    currentIteration: number;
    startedAt: string | null;
    endedAt: string | null;
    errorMessage: string | null;
  }>;
  failedInstances: Array<{
    id: string;
    workflowRunId: string;
    status: string;
    errorMessage: string | null;
    endedAt: string | null;
  }>;
};

export async function getAgentRuntimeDetail(
  definitionId: string,
  params?: { windowStart?: string; windowEnd?: string }
): Promise<AgentRuntimeDetail> {
  const query = new URLSearchParams();
  if (params?.windowStart) query.set("windowStart", params.windowStart);
  if (params?.windowEnd) query.set("windowEnd", params.windowEnd);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: AgentRuntimeDetail }>(
    `/api/v1/monitor/agents/${encodeURIComponent(definitionId)}/detail${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

/**
 * 监控 · Skills 聚合（按 skill）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.4 与 src/runtime/monitor/skills-summary.ts。
 */
export type MonitorSkillSummaryRow = {
  skillId: string;
  skillName: string;
  category: string;
  totalRuns: number;
  successCount: number;
  failCount: number;
  partialCount: number;
  unknownCount: number;
  successRate: number;
  avgScore: number | null;
  lastUsedAt: string | null;
};

export async function listMonitorSkillsSummary(input?: {
  windowMinutes?: number;
  sessionId?: string;
}): Promise<MonitorSkillSummaryRow[]> {
  const query = new URLSearchParams();
  if (input?.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: MonitorSkillSummaryRow[] }>(
    `/api/v1/monitor/skills/summary${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

/**
 * 监控失败列表（跨 tool / mcp / skill / agent）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.2 与 src/runtime/monitor/failure-list.ts。
 */
export type MonitorFailureScope = "tool" | "mcp" | "skill" | "agent";

export type MonitorFailureRow = {
  id: string;
  scope: MonitorFailureScope;
  name: string;
  status: string;
  errorMessage: string | null;
  stepIndex: number | null;
  workflowRunId: string | null;
  ts: string;
};

export async function listMonitorFailures(input?: {
  scope?: MonitorFailureScope;
  windowMinutes?: number;
  limit?: number;
  sessionId?: string;
}): Promise<MonitorFailureRow[]> {
  const query = new URLSearchParams();
  if (input?.scope) query.set("scope", input.scope);
  if (input?.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input?.limit != null) query.set("limit", String(input.limit));
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: MonitorFailureRow[] }>(
    `/api/v1/monitor/failures${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

/**
 * 监控 · 工具维度聚合（跨工作流，窗口内）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.2 / src/runtime/monitor/tools-summary.ts。
 */
export type MonitorToolKind = "acp_connector" | "mcp" | "skill" | "builtin";

export type MonitorToolSummaryRow = {
  toolKind: MonitorToolKind;
  toolName: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  successRate: number;
  avgLatencyMs: number | null;
  lastCalledAt: string | null;
};

export async function listMonitorToolsSummary(input?: {
  windowMinutes?: number;
  sessionId?: string;
  toolKind?: MonitorToolKind;
}): Promise<MonitorToolSummaryRow[]> {
  const query = new URLSearchParams();
  if (input?.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  if (input?.toolKind) query.set("toolKind", input.toolKind);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: MonitorToolSummaryRow[] }>(
    `/api/v1/monitor/tools/summary${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

/**
 * 监控 · MCP 维度聚合（含熔断态）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3 / src/runtime/monitor/mcp-summary.ts。
 */
export type MonitorMcpSummaryRow = {
  serverName: string;
  totalCalls: number;
  successCount: number;
  failedCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  successRate: number;
  avgLatencyMs: number | null;
  health: {
    circuitState: "closed" | "open" | "half_open";
    failureCount: number;
    successCount: number;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
    openedAt: string | null;
    lastErrorMessage: string | null;
    updatedAt: string;
  } | null;
  byTool: Array<{
    toolName: string;
    totalCalls: number;
    successCount: number;
    failedCount: number;
  }>;
  lastCalledAt: string | null;
};

export async function listMonitorMcpSummary(input?: {
  windowMinutes?: number;
  sessionId?: string;
}): Promise<MonitorMcpSummaryRow[]> {
  const query = new URLSearchParams();
  if (input?.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: MonitorMcpSummaryRow[] }>(
    `/api/v1/monitor/mcp/summary${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

/**
 * 监控 · 单一 Tool 排障详情（"工具/MCP 排障 tab"右侧详情面板用）。
 * 详见 src/runtime/monitor/tools-diagnostics.ts。
 */
export type MonitorToolDiagCall = {
  id: string;
  status: "success" | "error" | "timeout" | "sandbox_blocked";
  errorMessage: string | null;
  latencyMs: number | null;
  retryCount: number;
  workflowRunId: string | null;
  agentStepId: string;
  stepIndex: number | null;
  createdAt: string;
};

export type MonitorErrorTopRow = {
  errorMessage: string;
  count: number;
  lastSeenAt: string;
  sampleWorkflowRunId: string | null;
};

export type MonitorSandboxViolationGroup = {
  violationType: string;
  count: number;
  lastSeenAt: string;
  sampleWorkflowRunId: string | null;
  samplePolicyId: string | null;
};

export type MonitorToolDiagnostics = {
  summary: MonitorToolSummaryRow;
  latency: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    samples: number;
  };
  recentCalls: MonitorToolDiagCall[];
  errorTop: MonitorErrorTopRow[];
  sandboxViolations: MonitorSandboxViolationGroup[];
};

export async function getMonitorToolDiagnostics(input: {
  toolName: string;
  toolKind?: MonitorToolKind;
  windowMinutes?: number;
  recentLimit?: number;
  errorTopLimit?: number;
  sessionId?: string;
}): Promise<MonitorToolDiagnostics> {
  const query = new URLSearchParams();
  if (input.toolKind) query.set("toolKind", input.toolKind);
  if (input.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input.recentLimit != null) query.set("recentLimit", String(input.recentLimit));
  if (input.errorTopLimit != null) query.set("errorTopLimit", String(input.errorTopLimit));
  if (input.sessionId) query.set("sessionId", input.sessionId);
  const suffix = query.toString();
  const path = `/api/v1/monitor/tools/${encodeURIComponent(input.toolName)}/detail${
    suffix ? `?${suffix}` : ""
  }`;
  const res = await httpGet<{ ok: boolean; data: MonitorToolDiagnostics }>(path);
  return res.data;
}

/**
 * 监控 · 单一 MCP server 排障详情。
 * 详见 src/runtime/monitor/mcp-diagnostics.ts。
 */
export type MonitorMcpDiagCall = {
  id: string;
  toolName: string;
  status: "success" | "timeout" | "failed" | "sandbox_blocked";
  errorCode: string | null;
  latencyMs: number | null;
  retryCount: number;
  workflowRunId: string;
  agentStepId: string;
  createdAt: string;
};

export type MonitorMcpErrorTopRow = {
  errorCode: string;
  sampleMessage: string | null;
  count: number;
  lastSeenAt: string;
  sampleWorkflowRunId: string | null;
};

export type MonitorMcpByToolStat = {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failedCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  avgLatencyMs: number | null;
};

export type MonitorMcpDiagnostics = {
  serverName: string;
  windowMinutes: number;
  summary: {
    totalCalls: number;
    successCount: number;
    failedCount: number;
    timeoutCount: number;
    sandboxBlockedCount: number;
    successRate: number;
    avgLatencyMs: number | null;
    lastCalledAt: string | null;
  };
  health: {
    circuitState: "closed" | "open" | "half_open";
    failureCount: number;
    successCount: number;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
    openedAt: string | null;
    lastErrorMessage: string | null;
    updatedAt: string;
    cooldownMs: number;
  } | null;
  latency: { p50: number | null; p95: number | null; p99: number | null; samples: number };
  recentCalls: MonitorMcpDiagCall[];
  errorTop: MonitorMcpErrorTopRow[];
  byTool: MonitorMcpByToolStat[];
};

export async function getMonitorMcpDiagnostics(input: {
  serverName: string;
  windowMinutes?: number;
  recentLimit?: number;
  errorTopLimit?: number;
  sessionId?: string;
}): Promise<MonitorMcpDiagnostics> {
  const query = new URLSearchParams();
  if (input.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input.recentLimit != null) query.set("recentLimit", String(input.recentLimit));
  if (input.errorTopLimit != null) query.set("errorTopLimit", String(input.errorTopLimit));
  if (input.sessionId) query.set("sessionId", input.sessionId);
  const suffix = query.toString();
  const path = `/api/v1/monitor/mcp/${encodeURIComponent(input.serverName)}/detail${
    suffix ? `?${suffix}` : ""
  }`;
  const res = await httpGet<{ ok: boolean; data: MonitorMcpDiagnostics }>(path);
  return res.data;
}

/**
 * 监控 · LLM 用量聚合（24h token / cost / 错误 top）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.1 / §7.5 / src/runtime/monitor/llm-usage.ts。
 */
export type MonitorLlmUsageGroup = {
  provider: string;
  model: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  fallbackCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** P3-2 监控闭环：prompt cache 命中 token、reasoning token、TTFT 分位、finish reason 分布、length retry 次数 */
  cachedPromptTokens: number;
  reasoningTokens: number;
  costUsd: number;
  avgLatencyMs: number | null;
  p50FirstTokenLatencyMs: number | null;
  p95FirstTokenLatencyMs: number | null;
  finishReasonBreakdown: Record<string, number>;
  lengthRetryCount: number;
  successRate: number;
  lastCalledAt: string | null;
};

export type MonitorLlmUsageSummary = {
  windowMinutes: number;
  totals: {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    fallbackCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens: number;
    reasoningTokens: number;
    costUsd: number;
    avgLatencyMs: number | null;
    p50FirstTokenLatencyMs: number | null;
    p95FirstTokenLatencyMs: number | null;
    finishReasonBreakdown: Record<string, number>;
    lengthRetryCount: number;
    successRate: number;
  };
  byProviderModel: MonitorLlmUsageGroup[];
  errorTopN: Array<{ message: string; count: number }>;
};

export async function getMonitorLlmUsage(input?: {
  windowMinutes?: number;
  sessionId?: string;
}): Promise<MonitorLlmUsageSummary> {
  const query = new URLSearchParams();
  if (input?.windowMinutes != null) query.set("windowMinutes", String(input.windowMinutes));
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: MonitorLlmUsageSummary }>(
    `/api/v1/monitor/llm/usage${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

/**
 * 监控 V3 P0：统一 timeseries 查询客户端。
 *
 * 服务端路由：src/routes/monitor.routes.ts → /api/v1/monitor/timeseries
 * 后端核心：src/runtime/monitor/timeseries.ts:queryTimeseries
 *
 * 调用方都是 monitor/* 下的图表组件；不要在业务页面直接 import。
 */
export type MonitorTimeseriesSource =
  | "llm_call_log"
  | "tool_call_log"
  | "mcp_call_log"
  | "skill_recall_log";

export type MonitorTimeseriesMetric = "count" | "errorCount" | "tokens" | "cost" | "avgLatency";

export type MonitorTimeseriesInterval = "1m" | "5m" | "15m" | "1h" | "1d";

export type MonitorTimeseriesGroupBy =
  | "provider"
  | "model"
  | "agentDefinitionId"
  | "definitionId"
  | "serverName"
  | "toolName"
  | "toolKind"
  | "transport"
  | "circuitState"
  | "status"
  | "connectorName"
  | "operation"
  | "executed";

export type MonitorTimeseriesResult = {
  source: MonitorTimeseriesSource;
  metric: MonitorTimeseriesMetric;
  interval: MonitorTimeseriesInterval;
  from: string;
  to: string;
  /** 完整桶时间戳列表（与每个 series.points 一一对应） */
  buckets: string[];
  /** 至少一条 series；缺数据时返回空数组（前端展示 "窗口内无数据"） */
  series: Array<{ name: string; points: number[] }>;
};

export async function getMonitorTimeseries(input: {
  source: MonitorTimeseriesSource;
  metric: MonitorTimeseriesMetric;
  interval: MonitorTimeseriesInterval;
  from: string;
  to: string;
  groupBy?: MonitorTimeseriesGroupBy;
  sessionId?: string;
}): Promise<MonitorTimeseriesResult> {
  const query = new URLSearchParams({
    source: input.source,
    metric: input.metric,
    interval: input.interval,
    from: input.from,
    to: input.to,
  });
  if (input.groupBy) query.set("groupBy", input.groupBy);
  if (input.sessionId) query.set("sessionId", input.sessionId);
  const res = await httpGet<{ ok: boolean; data: MonitorTimeseriesResult }>(
    `/api/v1/monitor/timeseries?${query.toString()}`
  );
  return res.data;
}

export async function scanStuckWorkflowAlerts(stuckMinutes = 120): Promise<{
  scanned: number;
  created: number;
  alertIds: string[];
}> {
  const res = await httpPost<{
    ok: boolean;
    data: { scanned: number; created: number; alertIds: string[] };
  }>("/api/v1/monitor/alerts/scan-stuck", { stuckMinutes });
  return res.data;
}

export async function getSessionOverview(sessionId: string): Promise<SessionOverview> {
  const res = await httpGet<{ data: SessionOverview }>(
    `/api/v1/monitor/sessions/${sessionId}/overview`
  );
  return res.data;
}

export async function getWorkflowTimeline(workflowId: string): Promise<WorkflowTimeline> {
  const res = await httpGet<{ data: WorkflowTimeline }>(
    `/api/v1/monitor/workflows/${workflowId}/timeline`
  );
  return res.data;
}

export async function getWorkflowSandboxViolations(workflowId: string): Promise<unknown[]> {
  const res = await httpGet<{ data: unknown[] }>(
    `/api/v1/monitor/workflows/${workflowId}/sandbox-violations`
  );
  return res.data;
}

export async function listMonitorWorkflows(params: {
  /**
   * 项目级粗粒度过滤（来自 MonitorDashboard 顶部 project 切换下拉）。
   * 后端 `/api/v1/monitor/workflows` 在 routes/monitor.routes.ts 中支持 projectId 过滤，
   * 配合 `idx_workflow_run_project_created` 索引，能让"打开监控面板就能看到当前 project 的全部
   * workflow"成为默认行为，而不必依赖更窄的 sessionId 过滤。
   */
  projectId?: string;
  sessionId?: string;
  status?: string;
  mode?: string;
}): Promise<unknown[]> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.sessionId) query.set("sessionId", params.sessionId);
  if (params.status) query.set("status", params.status);
  if (params.mode) query.set("mode", params.mode);
  const res = await httpGet<{ data: unknown[] }>(`/api/v1/monitor/workflows?${query.toString()}`);
  return res.data;
}

export async function getWorkflowDetail(workflowId: string): Promise<WorkflowDetail> {
  const res = await httpGet<{ data: WorkflowDetail }>(
    `/api/v1/monitor/workflows/${workflowId}/detail`
  );
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

export async function listSubAgentTasks(input: {
  projectId: string;
  sessionId?: string;
  limit?: number;
}): Promise<{ items: SubAgentTaskRecord[]; total: number; active: number }> {
  const query = new URLSearchParams({ projectId: input.projectId });
  if (input.sessionId) query.set("sessionId", input.sessionId);
  if (input.limit != null) query.set("limit", String(input.limit));
  const res = await httpGet<{
    ok: boolean;
    data: {
      items: SubAgentTaskRecord[];
      total: number;
      active: number;
      projectId: string;
      sessionId: string | null;
    };
  }>(`/api/v1/monitor/sub-agent-tasks?${query.toString()}`);
  return res.data;
}

export async function createWorkflowQuality(
  workflowId: string
): Promise<WorkflowQualitySnapshotRecord> {
  const res = await httpPost<{ ok: boolean; data: WorkflowQualitySnapshotRecord }>(
    `/api/v1/monitor/quality/workflows/${workflowId}/snapshot`,
    {}
  );
  return res.data;
}

export async function listWorkflowQuality(
  workflowId: string
): Promise<WorkflowQualitySnapshotRecord[]> {
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
  limit?: number;
}): Promise<AlertEventRecord[]> {
  const query = new URLSearchParams();
  if (input?.scopeType) query.set("scopeType", input.scopeType);
  if (input?.scopeId) query.set("scopeId", input.scopeId);
  if (input?.status) query.set("status", input.status);
  if (input?.limit != null) query.set("limit", String(input.limit));
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: AlertEventRecord[] }>(
    `/api/v1/monitor/alerts${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function ackAlert(alertId: string): Promise<AlertEventRecord> {
  const res = await httpPost<{ ok: boolean; data: AlertEventRecord }>(
    `/api/v1/monitor/alerts/${alertId}/ack`,
    {}
  );
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
  const res = await httpPost<{ ok: boolean; data: EvalDatasetRecord }>(
    "/api/v1/monitor/eval/datasets",
    input
  );
  return res.data;
}

export async function listEvalDatasets(): Promise<EvalDatasetRecord[]> {
  const res = await httpGet<{ ok: boolean; data: EvalDatasetRecord[] }>(
    "/api/v1/monitor/eval/datasets"
  );
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
  const res = await httpGet<{ ok: boolean; data: EvalRunRecord[] }>(
    `/api/v1/monitor/eval/runs${suffix}`
  );
  return res.data;
}

export async function getEvalRunDetail(runId: string): Promise<{
  run: EvalRunRecord;
  cases: EvalCaseResultRecord[];
}> {
  const res = await httpGet<{
    ok: boolean;
    data: { run: EvalRunRecord; cases: EvalCaseResultRecord[] };
  }>(`/api/v1/monitor/eval/runs/${runId}`);
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
  ticker?: string;
  scope?: import("./types").ResearchScopeInput;
  context?: string;
  analystRoles?: string[];
  analystDefinitionIds?: string[];
  /**
   * @deprecated v1 兼容；前端自 P1-H 起不再写入。后端 resolveTeamHitlMode 仍兼容
   * 老调用方。新代码请用 `hitlMode`。
   */
  hitlTeam?: boolean;
  /**
   * v2 推荐：HITL 三档模式。
   *   - 'off'：永不主动；仅硬规则触发
   *   - 'ai'：默认 — Orchestrator 自评 needed=true 或硬规则命中才触发
   *   - 'always'：每次规划都触发（v1 行为）
   */
  hitlMode?: "off" | "ai" | "always";
  /** Agent 底座/引擎：每个角色单轮 reason 用哪个引擎（写入 loopOptions.roleReasoner）。 */
  roleReasoner?: AgentLoopKind;
  /** Agent 工作模式（Agent / Plan / Goal）。 */
  agentMode?: import("./types").AgentControlMode;
}): Promise<{ jobId: string }> {
  const res = await httpPost<{ ok: boolean; jobId: string; status: string }>(
    "/api/v1/analyst/run",
    params
  );
  return { jobId: res.jobId };
}

/** 团队研究 HITL 的待审批状态，供前端展示批准/拒绝卡片 */
export interface AnalystTeamAwaitingApproval {
  jobId: string;
  workflowRunId: string;
  requestId: string;
  title: string;
  summary: string;
}

/**
 * 轮询服务端 analyst job 状态，直到完成 / 失败 / 超时 / 调用方主动取消。
 *
 * 重要语义：
 *  - 这里的 `timeoutMs` 是**前端轮询超时**，超时后只是不再发 GET，**后端任务仍在运行**，
 *    结果会照常落库，可在「研究画布」刷新拓扑或重新轮询查看。
 *  - `signal` 用于让调用方主动「停止等待」（同样不会终止后端任务）。
 *  - 抛错时把 `jobId` 一并带在 message 里方便排查；调用方可通过 try/catch + jobId 自行决定后续动作。
 */
export class AnalystJobPollError extends Error {
  jobId: string;
  reason: "timeout" | "aborted" | "failed";
  elapsedMs?: number;
  constructor(opts: {
    message: string;
    jobId: string;
    reason: "timeout" | "aborted" | "failed";
    elapsedMs?: number;
  }) {
    super(opts.message);
    this.name = "AnalystJobPollError";
    this.jobId = opts.jobId;
    this.reason = opts.reason;
    if (opts.elapsedMs !== undefined) this.elapsedMs = opts.elapsedMs;
  }
}

export async function pollAnalystJob(
  jobId: string,
  opts?: {
    intervalMs?: number;
    /** 默认 30 分钟。设置为 0 或负数表示不超时（直到完成 / 失败 / abort）。 */
    timeoutMs?: number;
    onProgress?: (elapsedMs: number) => void;
    /** 团队 HITL 命中时持续被回调；前端据此渲染审批卡片。同一 requestId 只会触发一次。 */
    onAwaitingApproval?: (info: AnalystTeamAwaitingApproval) => void;
    /** awaiting_approval 状态下转回 running 时回调一次（用户已批准） */
    onResume?: () => void;
    signal?: AbortSignal;
  }
): Promise<AnalystTeamResult> {
  const intervalMs = opts?.intervalMs ?? 3000;
  const timeoutMs = opts?.timeoutMs ?? 1_800_000; // 30 分钟
  const noTimeout = !Number.isFinite(timeoutMs) || timeoutMs <= 0;
  const start = Date.now();
  const deadline = noTimeout ? Number.POSITIVE_INFINITY : start + timeoutMs;
  // HITL 暂停时不计入「等待上限」——人工审批可能花很久。
  let awaitingStartedAt: number | null = null;
  let lastAwaitingRequestId: string | null = null;

  while (true) {
    if (opts?.signal?.aborted) {
      throw new AnalystJobPollError({
        message: `已停止等待（jobId=${jobId}）。后端任务可能仍在运行，结果将继续落库；可在拓扑/对话流刷新查看。`,
        jobId,
        reason: "aborted",
        elapsedMs: Date.now() - start,
      });
    }
    const res = await httpGet<{
      ok: boolean;
      jobId: string;
      status: "running" | "completed" | "failed" | "awaiting_approval";
      result?: AnalystTeamResult;
      error?: string;
      elapsedMs: number;
      workflowRunId?: string;
      hitlRequestId?: string;
      hitlTitle?: string;
      hitlSummary?: string;
    }>(`/api/v1/analyst/job/${jobId}`);

    if (res.status === "completed" && res.result) {
      return res.result;
    }
    if (res.status === "failed") {
      throw new AnalystJobPollError({
        message: res.error ?? "analyst team job failed",
        jobId,
        reason: "failed",
        elapsedMs: res.elapsedMs,
      });
    }
    if (res.status === "awaiting_approval" && res.hitlRequestId) {
      if (awaitingStartedAt === null) awaitingStartedAt = Date.now();
      if (lastAwaitingRequestId !== res.hitlRequestId) {
        lastAwaitingRequestId = res.hitlRequestId;
        opts?.onAwaitingApproval?.({
          jobId,
          workflowRunId: res.workflowRunId ?? "",
          requestId: res.hitlRequestId,
          title: res.hitlTitle ?? "",
          summary: res.hitlSummary ?? "",
        });
      }
    } else {
      if (awaitingStartedAt !== null) {
        // 由 awaiting_approval 转回 running —— 用户已批准，把这段挂起时长从 deadline 里"补回去"。
        opts?.onResume?.();
        awaitingStartedAt = null;
        lastAwaitingRequestId = null;
      }
      opts?.onProgress?.(res.elapsedMs);
      if (!noTimeout && Date.now() >= deadline) break;
    }
    // 等下一轮，但中途也响应 abort
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      opts?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    });
  }
  const minutes = Math.round(timeoutMs / 60_000);
  throw new AnalystJobPollError({
    message: `前端轮询已超时（${minutes} 分钟未完成，jobId=${jobId}）。后端任务可能仍在运行，结果将继续落库；可在拓扑/对话流刷新查看，或下次启动前调大「等待上限」。`,
    jobId,
    reason: "timeout",
    elapsedMs: Date.now() - start,
  });
}

/** 保留旧名称向后兼容 */
export async function runAnalystTeam(params: {
  workflowRunId: string;
  ticker?: string;
  scope?: import("./types").ResearchScopeInput;
  context?: string;
  onProgress?: (elapsedMs: number) => void;
  analystRoles?: string[];
  analystDefinitionIds?: string[];
  /** 前端轮询超时（毫秒），<=0 表示不超时。默认 30 分钟。 */
  timeoutMs?: number;
  /** 主动停止等待。 */
  signal?: AbortSignal;
  /**
   * @deprecated v1 兼容；前端自 P1-H 起不再写入。新代码请用 `hitlMode`。
   */
  hitlTeam?: boolean;
  /** v2：HITL 三档模式 */
  hitlMode?: "off" | "ai" | "always";
  /** Agent 底座/引擎：每个角色单轮 reason 用哪个引擎（写入 loopOptions.roleReasoner）。 */
  roleReasoner?: AgentLoopKind;
  /** Agent 工作模式（Agent / Plan / Goal）。 */
  agentMode?: import("./types").AgentControlMode;
  onAwaitingApproval?: (info: AnalystTeamAwaitingApproval) => void;
  onResume?: () => void;
}): Promise<AnalystTeamResult> {
  const { jobId } = await startAnalystTeam(params);
  return pollAnalystJob(jobId, {
    onProgress: params.onProgress,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    ...(params.onAwaitingApproval !== undefined
      ? { onAwaitingApproval: params.onAwaitingApproval }
      : {}),
    ...(params.onResume !== undefined ? { onResume: params.onResume } : {}),
  });
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

export async function listDebateSessionsForWorkflow(
  workflowRunId: string
): Promise<DebateSessionRecord[]> {
  const res = await httpGet<{ ok: boolean; data: DebateSessionRecord[] }>(
    `/api/v1/debate/sessions/${encodeURIComponent(workflowRunId)}`
  );
  return Array.isArray(res.data) ? res.data : [];
}

export async function getAnalystTeamGraph(
  workflowRunId: string
): Promise<AnalystTeamGraphPayload | null> {
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
}): Promise<AnalystSignalFusionRecord[]> {
  const query = new URLSearchParams();
  if (params?.ticker) query.set("ticker", params.ticker);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));
  const res = await httpGet<{ ok?: boolean; data?: AnalystSignalFusionRecord[] | null }>(
    `/api/v1/analyst/fusion/history?${query.toString()}`
  );
  const rows = (res as { data?: unknown } | null)?.data;
  return Array.isArray(rows) ? (rows as AnalystSignalFusionRecord[]) : [];
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
  const res = await httpGet<{ ok: boolean; data: ScreenerRunRecord[] }>(
    `/api/v1/screener/runs/${workflowRunId}`
  );
  return res.data;
}

export async function listScreenerCandidates(
  screenerRunId: string
): Promise<ScreenerCandidateRecord[]> {
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

export async function evolveGenePool(
  projectId: string
): Promise<{ generationId: string; generationNumber: number }> {
  const res = await httpPost<{
    ok: boolean;
    data: { generationId: string; generationNumber: number };
  }>("/api/v1/gene/evolve", { projectId });
  return res.data;
}

export async function listGeneGenerations(projectId: string): Promise<GeneGenerationRecord[]> {
  const res = await httpGet<{ ok: boolean; data: GeneGenerationRecord[] }>(
    `/api/v1/gene/generations/${projectId}`
  );
  return res.data;
}

export async function listGenomes(generationId: string): Promise<StrategyGenomeRecord[]> {
  const res = await httpGet<{ ok: boolean; data: StrategyGenomeRecord[] }>(
    `/api/v1/gene/genomes/${generationId}`
  );
  return res.data;
}

export async function listGeneTrends(projectId: string): Promise<GeneTrendPoint[]> {
  const res = await httpGet<{ ok: boolean; data: GeneTrendPoint[] }>(
    `/api/v1/gene/trends/${projectId}`
  );
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
  const res = await httpGet<{ ok: boolean; data: IntentOrderRecord[] }>(
    `/api/v1/reia/intents/${workflowRunId}`
  );
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
  const res = await httpGet<{ ok: boolean; data: ExecutionSafetyConfig }>(
    "/api/v1/reia/safety/config"
  );
  return res.data;
}

export async function saveExecutionSafetyConfig(
  input: Partial<ExecutionSafetyConfig>
): Promise<ExecutionSafetyConfig> {
  const res = await httpPut<{ ok: boolean; data: ExecutionSafetyConfig }>(
    "/api/v1/reia/safety/config",
    input
  );
  return res.data;
}

export async function requestExecutionConfirmation(
  intentOrderId: string
): Promise<ExecutionSafetyCheckResult> {
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

export async function listExecutionConfirmTickets(
  intentOrderId: string
): Promise<ExecutionConfirmTicketRecord[]> {
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
  const res = await httpGet<{ ok: boolean; data: BrokerAccountRecord[] }>(
    `/api/v1/reia/broker/accounts${suffix}`
  );
  return res.data;
}

export async function upsertBrokerAccount(input: {
  provider: "futu" | "ib" | "ccxt";
  accountRef: string;
  mode?: "mock" | "sandbox" | "live";
  baseUrl?: string;
  providerConfig?: import("./types").BrokerProviderConfig;
  isDefault?: boolean;
  enabled?: boolean;
}): Promise<BrokerAccountRecord> {
  const res = await httpPost<{ ok: boolean; data: BrokerAccountRecord }>(
    "/api/v1/reia/broker/accounts/upsert",
    input
  );
  return res.data;
}

export async function checkBrokerHealth(input: {
  provider: "futu" | "ib" | "ccxt";
  accountRef: string;
}): Promise<{
  provider: "futu" | "ib" | "ccxt";
  status: "healthy" | "degraded" | "down";
  message: string;
  checkedAt: string;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      provider: "futu" | "ib" | "ccxt";
      status: "healthy" | "degraded" | "down";
      message: string;
      checkedAt: string;
    };
  }>("/api/v1/reia/broker/health-check", input);
  return res.data;
}

export async function listBrokerEvents(
  provider?: "futu" | "ib",
  limit = 100
): Promise<BrokerOrderEventRecord[]> {
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

export async function processWorkflowCompensations(
  limit = 10
): Promise<{ picked: number; success: number; failed: number }> {
  const res = await httpPost<{
    ok: boolean;
    data: { picked: number; success: number; failed: number };
  }>("/api/v1/workflows/compensation/process", { limit });
  return res.data;
}

export async function listIntegrationCatalog(): Promise<IntegrationAdapterDescriptor[]> {
  const res = await httpGet<{ ok: boolean; data: IntegrationAdapterDescriptor[] }>(
    "/api/v1/integrations/catalog"
  );
  return res.data;
}

export async function listIntegrationChannels(
  kind?: IntegrationKind
): Promise<CommunicationChannelRecord[]> {
  const suffix = kind ? `?kind=${kind}` : "";
  const res = await httpGet<{ ok: boolean; data: CommunicationChannelRecord[] }>(
    `/api/v1/integrations/channels${suffix}`
  );
  return res.data;
}

export async function upsertIntegrationChannel(input: {
  id?: string;
  workspaceId: string;
  projectId?: string | null;
  kind: IntegrationKind;
  name: string;
  externalChatId: string;
  secretRef?: string;
  metaJson?: Record<string, unknown> | null;
  enabled?: boolean;
}): Promise<CommunicationChannelRecord> {
  const res = await httpPost<{ ok: boolean; data: CommunicationChannelRecord }>(
    "/api/v1/integrations/channels/upsert",
    input
  );
  return res.data;
}

export async function deleteIntegrationChannel(id: string): Promise<void> {
  await httpDelete(`/api/v1/integrations/channels/${encodeURIComponent(id)}`);
}

export interface IntegrationSendResult {
  ok: boolean;
  externalMessageId?: string;
  payload?: unknown;
  errorMessage?: string;
  logId: string;
}

export async function sendIntegrationMessage(
  channelId: string,
  text: string,
  extra?: Record<string, unknown>
): Promise<IntegrationSendResult> {
  const res = await httpPost<{ ok: boolean; data: IntegrationSendResult }>(
    `/api/v1/integrations/channels/${encodeURIComponent(channelId)}/send`,
    extra ? { text, extra } : { text }
  );
  return res.data;
}

export async function listIntegrationLogs(
  kind?: IntegrationKind,
  limit = 100,
  channelId?: string
): Promise<CommunicationMessageLogRecord[]> {
  const query = new URLSearchParams();
  if (kind) query.set("kind", kind);
  if (channelId) query.set("channelId", channelId);
  query.set("limit", String(limit));
  const res = await httpGet<{ ok: boolean; data: CommunicationMessageLogRecord[] }>(
    `/api/v1/integrations/logs?${query.toString()}`
  );
  return res.data;
}

export async function deleteScheduledJob(id: string): Promise<void> {
  await httpDelete(`/api/v1/workflows/scheduled-jobs/${encodeURIComponent(id)}`);
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

/**
 * Subscribe to the WORKFLOW-level firehose (SSE): all agent runs under one workflow.
 * 研究团队页用它逐字渲染 Orchestrator/各子 agent 的 LLM 输出（事件自带 role/runId 供路由）。
 * 与 subscribeWorkflowStream 同样用 fetch + ReadableStream，避免 EventSource 在 Tauri 的重连噪声。
 */
export function subscribeWorkflowEvents(params: {
  workflowId: string;
  onEvent: (event: StepStreamEvent) => void;
  onError?: (err: Event) => void;
}): () => void {
  const url = backendFetchUrl(`/api/v1/workflows/${params.workflowId}/events`);
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
  const res = await httpGet<{ data: McpServerConfigRecord[] }>(
    `/api/v1/agents/mcp/servers${suffix}`
  );
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
  const res = await httpPost<{ data: McpServerConfigRecord }>(
    "/api/v1/agents/mcp/servers/upsert",
    input
  );
  return res.data;
}

export async function listMcpBindings(
  projectId?: string,
  definitionId?: string
): Promise<McpToolBindingRecord[]> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (definitionId) params.set("definitionId", definitionId);
  const q = params.toString();
  const suffix = q ? `?${q}` : "";
  const res = await httpGet<{ data: McpToolBindingRecord[] }>(
    `/api/v1/agents/mcp/bindings${suffix}`
  );
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
  const res = await httpPost<{ data: McpToolBindingRecord }>(
    "/api/v1/agents/mcp/bindings/upsert",
    input
  );
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
    const res = await httpPatch<{ data: McpRegistrySourceRecord }>(
      `/api/v1/agents/mcp/sources/${input.id}`,
      input
    );
    return res.data;
  }
  const res = await httpPost<{ data: McpRegistrySourceRecord }>(
    "/api/v1/agents/mcp/sources",
    input
  );
  return res.data;
}

export async function syncMcpSource(id: string): Promise<{
  sourceId: string;
  syncedCount: number;
  usedFallback: boolean;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: { sourceId: string; syncedCount: number; usedFallback: boolean };
  }>(`/api/v1/agents/mcp/sources/${id}/sync`, {});
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
  const res = await httpPost<{ data: McpProjectInstallRecord }>(
    "/api/v1/agents/mcp/market/install",
    input
  );
  return res.data;
}

export async function listMcpProjectInstalls(
  projectId: string
): Promise<McpProjectInstallRecord[]> {
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
  const res = await httpPost<{ data: SkillMarketStatusDto }>(
    "/api/v1/agents/skills/market/refresh",
    {
      baseUrl: input?.baseUrl?.trim() || undefined,
      provider: input?.provider,
      apiKey: input?.apiKey?.trim() || undefined,
    }
  );
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

export async function listSkillMarketInstalls(
  projectId: string
): Promise<SkillMarketInstallRecord[]> {
  const res = await httpGet<{ data: SkillMarketInstallRecord[] }>(
    `/api/v1/agents/skills/installs?projectId=${encodeURIComponent(projectId)}`
  );
  return res.data;
}

export async function installSkillFromMarket(input: {
  projectId: string;
  externalSkillId: string;
}): Promise<SkillMarketInstallRecord> {
  const res = await httpPost<{ data: SkillMarketInstallRecord }>(
    "/api/v1/agents/skills/installs",
    input
  );
  return res.data;
}

export async function installManualSkill(input: {
  projectId: string;
  skillName: string;
  description?: string;
  externalSkillId?: string;
  repo?: string;
  path?: string;
  localPath?: string;
  tags?: string[];
}): Promise<SkillMarketInstallRecord> {
  const res = await httpPost<{ data: SkillMarketInstallRecord }>("/api/v1/agents/skills/installs", {
    ...input,
    registry: "manual",
  });
  return res.data;
}

export async function deleteSkillMarketInstall(
  projectId: string,
  installId: string
): Promise<void> {
  await httpDelete<{ ok: boolean }>(
    `/api/v1/agents/skills/installs/${encodeURIComponent(installId)}?projectId=${encodeURIComponent(projectId)}`
  );
}

/**
 * 拉取 `agent_skill` 库（覆盖 curator 归纳 / GEPA 演化 / 市场镜像 / 用户手写），
 * 用于"配置中心 → SKILLS → 归纳与演化"指示表。
 */
export async function listSkillLibrary(
  projectId: string,
  opts?: { includeArchived?: boolean; state?: AgentSkillState }
): Promise<AgentSkillRecord[]> {
  const params = new URLSearchParams({ projectId });
  if (opts?.includeArchived) params.set("includeArchived", "true");
  if (opts?.state) params.set("state", opts.state);
  const res = await httpGet<{ data: AgentSkillRecord[] }>(
    `/api/v1/agents/skills/library?${params.toString()}`
  );
  return res.data;
}

/** PATCH 单条 agent_skill（归档 / pin / 修改描述等）。 */
export async function patchAgentSkill(
  skillId: string,
  patch: Partial<{
    description: string;
    bodyMd: string;
    category: string;
    pinned: boolean;
    state: AgentSkillState;
    bumpVersion: boolean;
  }>
): Promise<AgentSkillRecord> {
  const res = await httpPatch<{ data: AgentSkillRecord }>(
    `/api/v1/agents/skills/library/${encodeURIComponent(skillId)}`,
    patch
  );
  return res.data;
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
  const res = await httpPost<{ data: McpCatalogInstallRecord }>(
    "/api/v1/agents/mcp/catalog/install",
    input
  );
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
  const res = await httpPost<{ ok: boolean; data: TraderSessionContext }>(
    "/api/v1/trader/session",
    input
  );
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

export async function placeTraderBracketOrder(input: {
  workflowRunId: string;
  symbol: string;
  exchange: string;
  side: "buy" | "sell";
  qty: number;
  entryOrderType?: "market" | "limit";
  takeProfitPrice: number;
  stopLossPrice: number;
  timeframe?: string;
  executionMode?: "paper" | "live";
}): Promise<{
  bracketId: string;
  ocoGroupId: string;
  entry: { orderIntentId: string; riskOutcome: string; riskReason: string };
  takeProfit: { orderIntentId: string; riskOutcome: string; riskReason: string };
  stopLoss: { orderIntentId: string; riskOutcome: string; riskReason: string };
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      bracketId: string;
      ocoGroupId: string;
      entry: { orderIntentId: string; riskOutcome: string; riskReason: string };
      takeProfit: { orderIntentId: string; riskOutcome: string; riskReason: string };
      stopLoss: { orderIntentId: string; riskOutcome: string; riskReason: string };
    };
    error?: string;
  }>("/api/v1/trader/orders/bracket", input);
  if (!res.ok) throw new Error(res.error ?? "place_bracket_order_failed");
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

export type PositionReconciliationReport = {
  projectId: string;
  provider: "futu" | "ib" | "ccxt";
  accountRef: string | null;
  asof: string;
  summary: {
    symbols: number;
    matched: number;
    mismatched: number;
    matchRate: number;
    absoluteNotionalDelta: number;
  };
  rows: Array<{
    symbol: string;
    internalQty: number;
    brokerQty: number;
    quantityDelta: number;
    internalAvgPrice: number | null;
    brokerAvgPrice: number | null;
    averagePriceDeltaPct: number | null;
    notionalDelta: number | null;
    matched: boolean;
  }>;
};

export type PositionRemediationPlan = {
  planHash: string;
  mode: "proposal_only";
  autoExecuted: false;
  actions: Array<{
    symbol: string;
    action: "buy" | "sell";
    quantity: number;
    estimatedNotional: number;
    reason: string;
    requiresApproval: true;
  }>;
};

export async function getPositionReconciliation(input: {
  projectId: string;
  provider: "futu" | "ib" | "ccxt";
  accountRef?: string;
}): Promise<PositionReconciliationReport> {
  const query = new URLSearchParams({ projectId: input.projectId, provider: input.provider });
  if (input.accountRef) query.set("accountRef", input.accountRef);
  const res = await httpGet<{ ok: boolean; data: PositionReconciliationReport }>(
    `/api/v1/execution/reconciliation/positions?${query.toString()}`,
  );
  return res.data;
}

export async function scanPositionReconciliation(input: {
  projectId: string;
  provider: "futu" | "ib" | "ccxt";
  accountRef?: string;
}): Promise<{
  report: PositionReconciliationReport;
  remediation: PositionRemediationPlan;
  alert: { id: string | null; created: boolean; resolved: boolean };
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      report: PositionReconciliationReport;
      remediation: PositionRemediationPlan;
      alert: { id: string | null; created: boolean; resolved: boolean };
    };
  }>("/api/v1/execution/reconciliation/positions/scan", input);
  return res.data;
}

export async function remediatePositionReconciliation(input: {
  projectId: string;
  provider: "futu" | "ib" | "ccxt";
  accountRef?: string;
  expectedPlanHash: string;
  strategyRuntimeId: string;
}): Promise<{
  planHash: string;
  orders: Array<{
    orderIntentId: string;
    executionTaskId: string | null;
    riskOutcome: string;
    riskReason: string;
  }>;
  note?: string;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      planHash: string;
      orders: Array<{
        orderIntentId: string;
        executionTaskId: string | null;
        riskOutcome: string;
        riskReason: string;
      }>;
      note?: string;
    };
    error?: string;
  }>("/api/v1/execution/reconciliation/positions/remediate", {
    ...input,
    confirmation: "CONFIRM_RECONCILIATION",
  });
  if (!res.ok) throw new Error(res.error ?? "position_reconciliation_remediation_failed");
  return res.data;
}

export type PortfolioAllocationPlan = {
  asof: string;
  config: {
    capital: number;
    grossLimit: number;
    netLimit: number;
    perPositionMax: number;
    totalRiskBudget: number;
    maxSectorGross: number;
    defaultStopDistancePct: number;
  };
  rows: Array<{
    symbol: string;
    side: "long" | "short";
    price: number;
    targetWeight: number;
    targetNotional: number;
    targetQty: number;
    currentQty: number;
    rebalanceQty: number;
    riskContributionPct: number;
    sector: string;
    beta: number;
  }>;
  exposures: {
    longGross: number;
    shortGross: number;
    grossExposure: number;
    netExposure: number;
    estimatedLossAtStopsPct: number;
    concentrationHhi: number;
    portfolioBeta: number;
    weightedAverageCorrelation: number | null;
    sectorGross: Record<string, number>;
    sectorNet: Record<string, number>;
    style: Record<string, number>;
    factor: Record<string, number>;
  };
  warnings: string[];
  risk: null | {
    asof: string;
    status: "ready" | "insufficient_data";
    metrics: null | {
      observations: number;
      historicalVar95Pct: number;
      historicalVar99Pct: number;
      expectedShortfall95Pct: number;
      expectedShortfall99Pct: number;
      annualizedVolatilityPct: number;
      historicalMaxDrawdownPct: number;
    };
    correlationMatrix: Record<string, Record<string, number>>;
    covarianceMatrix: Record<string, Record<string, number>>;
    weightedAverageCorrelation: number | null;
    stressTests: Array<{
      scenario: string;
      portfolioReturnPct: number;
      lossAmount: number;
      contributions: Record<string, number>;
    }>;
    lineage: Array<{
      symbol: string;
      exchange: string;
      bars: number;
      firstAsof: string | null;
      lastAsof: string | null;
      status: "used" | "insufficient" | "error";
      error?: string;
    }>;
    warnings: string[];
  };
};

export async function createPortfolioAllocationPlan(input: {
  projectId: string;
  capital: number;
  grossLimit?: number;
  netLimit?: number;
  perPositionMax?: number;
  totalRiskBudget?: number;
  maxSectorGross?: number;
}): Promise<PortfolioAllocationPlan> {
  const res = await httpPost<{ ok: boolean; data: PortfolioAllocationPlan; error?: string }>(
    "/api/v1/execution/portfolio/plan",
    {
      projectId: input.projectId,
      config: {
        capital: input.capital,
        grossLimit: input.grossLimit,
        netLimit: input.netLimit,
        perPositionMax: input.perPositionMax,
        totalRiskBudget: input.totalRiskBudget,
        maxSectorGross: input.maxSectorGross,
      },
      includeHistoricalRisk: true,
    },
  );
  if (!res.ok) throw new Error(res.error ?? "portfolio_allocation_failed");
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
): Promise<
  {
    id: string;
    level: string;
    message: string;
    createdAt: string;
    payloadJson?: Record<string, unknown>;
  }[]
> {
  const res = await httpGet<{
    ok: boolean;
    data: {
      id: string;
      level: string;
      message: string;
      createdAt: string;
      payloadJson?: Record<string, unknown>;
    }[];
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

export interface PaperEvaluationDto {
  id: string;
  strategyRuntimeId: string;
  strategyVersionId: string;
  tradingDays: number;
  netPnl: number;
  netReturn: number;
  sharpe: number;
  maxDrawdown: number;
  turnover: number;
  pass: boolean;
}

export interface StrategyPromotionAssessmentDto {
  strategyVersionId: string;
  backtestPassed: boolean;
  walkForwardPassed: boolean;
  paperPassed: boolean;
  manuallyApproved: boolean;
  liveEligible: boolean;
}

export async function evaluatePaperRuntime(id: string): Promise<PaperEvaluationDto> {
  const res = await httpPost<{ ok: boolean; data: PaperEvaluationDto }>(
    `/api/v1/strategy-runtimes/${encodeURIComponent(id)}/evaluate-paper`,
    {}
  );
  return res.data;
}

export async function approveStrategyRuntimeForLive(
  id: string,
  reviewer = "user"
): Promise<StrategyPromotionAssessmentDto> {
  const res = await httpPost<{ ok: boolean; data: StrategyPromotionAssessmentDto }>(
    `/api/v1/strategy-runtimes/${encodeURIComponent(id)}/approve-live`,
    { reviewer }
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

// ─── M4: Provider registry ──────────────────────────────────────────────────

export type ProviderKind =
  | "factor_compute"
  | "factor_eval"
  | "rule_engine"
  | "backtest"
  | "live_ems"
  | "market_data"
  | "llm"
  | "factor_miner";

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  providerKey: string;
  displayName: string;
  description?: string;
  capability: Record<string, unknown>;
  status: "enabled" | "disabled";
  priority: number;
  version: string;
  isBuiltin: boolean;
  isFallback: boolean;
  updatedAt: string;
}

export interface ProviderHealthRecord {
  kind: ProviderKind;
  providerKey: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export async function listProviders(kind?: ProviderKind): Promise<ProviderRecord[]> {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const res = await httpGet<{ ok: boolean; data: ProviderRecord[] }>(`/api/v1/providers${q}`);
  return res.data;
}

export async function patchProvider(
  id: string,
  patch: { status?: "enabled" | "disabled"; priority?: number }
): Promise<void> {
  await httpPatch<{ ok: boolean }>(`/api/v1/providers/${id}`, patch);
}

export async function listProviderHealth(): Promise<ProviderHealthRecord[]> {
  const res = await httpGet<{ ok: boolean; data: ProviderHealthRecord[] }>(
    "/api/v1/providers/health"
  );
  return res.data;
}

// ─── M4: Factor / Composition / Backtest Job / Discovery ────────────────────

export type FactorCategory = "value" | "momentum" | "volatility" | "news" | "quality" | "macro";
export type FactorLang = "qlib_expr" | "python" | "sql" | "jsonlogic";
export type FactorStatus = "draft" | "active" | "archived";

/**
 * 量化工作台产物 lineage 来源标识（migration 0080）。
 *
 * 与后端 `factor_definition.created_by` / `rule_definition.created_by` 等列
 * 对齐，前端 `<LineageBadge>` 用此值决定徽章配色与图标。
 */
export type LineageCreatedBy = "user" | "agent" | "discovery_promote" | "clone" | "system" | string;

export interface FactorRecord {
  id: string;
  projectId: string;
  name: string;
  category: FactorCategory;
  expr: string;
  lang: FactorLang;
  universe: string;
  horizon: number;
  status: FactorStatus;
  providerKey: string;
  /** 产出该 factor 的 workflow_run.id；NULL = IDE / REST / 历史数据 */
  workflowRunId: string | null;
  /** 产物 lineage（migration 0080） */
  createdBy: LineageCreatedBy;
  agentInstanceId: string | null;
  /** discovery_promote 时记录上游 discovery_job.id */
  sourceJobId: string | null;
  definition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FactorValueRow {
  symbol: string;
  date: string;
  value: number | null;
}

export interface FactorValueStats {
  rowCount: number;
  symbolCount: number;
  minDate: string | null;
  maxDate: string | null;
}

export interface FactorComputeResultDto {
  rows: FactorValueRow[];
  meta: { factorId?: string; rowCount: number; latencyMs: number };
}

export interface FactorEvalResultDto {
  ic: number;
  rankIc: number;
  ir: number;
  turnover: number;
  decayCurve: number[];
  groupReturns: number[];
  sampleSize: number;
  latencyMs: number;
  evaluationId?: string;
  meta?: { horizonDays: number; decayHorizons: number[] };
  error?: string;
}

export interface FactorEvaluationLogRow {
  id: string;
  factorId: string;
  asof: string;
  universe: string;
  providerId: string | null;
  ic: number | null;
  rankIc: number | null;
  ir: number | null;
  turnover: number | null;
  sampleSize: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

export async function listFactors(filter?: {
  projectId?: string;
  category?: FactorCategory;
  status?: FactorStatus;
  /**
   * 严格按工作流过滤；研究产出侧栏专用，仅显示"本工作流期间 Agent 产出"的因子。
   * 不传则返回项目下全部（量化工坊 / 因子工坊场景）。
   */
  workflowRunId?: string;
  /** lineage 过滤：created_by IN ('user'|'agent'|'discovery_promote'|'clone'|...) */
  createdBy?: LineageCreatedBy;
  /** lineage 过滤：单 agent 实例发起的所有产物 */
  agentInstanceId?: string;
}): Promise<FactorRecord[]> {
  const qs: string[] = [];
  if (filter?.projectId) qs.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  if (filter?.category) qs.push(`category=${encodeURIComponent(filter.category)}`);
  if (filter?.status) qs.push(`status=${encodeURIComponent(filter.status)}`);
  if (filter?.workflowRunId) qs.push(`workflow_run_id=${encodeURIComponent(filter.workflowRunId)}`);
  if (filter?.createdBy) qs.push(`created_by=${encodeURIComponent(filter.createdBy)}`);
  if (filter?.agentInstanceId)
    qs.push(`agent_instance_id=${encodeURIComponent(filter.agentInstanceId)}`);
  const q = qs.length ? `?${qs.join("&")}` : "";
  const res = await httpGet<{ ok: boolean; data: FactorRecord[] }>(`/api/v1/factors${q}`);
  return res.data;
}

export async function getFactor(id: string): Promise<FactorRecord> {
  const res = await httpGet<{ ok: boolean; data: FactorRecord }>(`/api/v1/factors/${id}`);
  return res.data;
}

export async function registerFactor(body: {
  projectId: string;
  name: string;
  category: FactorCategory;
  expr: string;
  lang?: FactorLang;
  universe?: string;
  horizon?: number;
  status?: FactorStatus;
  providerKey?: string;
  definition?: Record<string, unknown>;
}): Promise<FactorRecord> {
  const res = await httpPost<{ ok: boolean; data: FactorRecord }>(`/api/v1/factors`, body);
  return res.data;
}

export async function setFactorStatus(id: string, status: FactorStatus): Promise<void> {
  await httpPatch<{ ok: boolean }>(`/api/v1/factors/${id}`, { status });
}

export async function computeFactor(
  id: string,
  body: { startDate: string; endDate: string; symbols?: string[]; providerKey?: string }
): Promise<FactorComputeResultDto> {
  const res = await httpPost<{ ok: boolean; data: FactorComputeResultDto }>(
    `/api/v1/factors/${id}/compute`,
    body
  );
  return res.data;
}

export async function autoEvaluateFactor(
  id: string,
  body: {
    startDate: string;
    endDate: string;
    symbols?: string[];
    horizonDays?: number;
    decayHorizons?: number[];
    groupCount?: number;
    providerKey?: string;
  }
): Promise<FactorEvalResultDto> {
  const res = await httpPost<{ ok: boolean; data: FactorEvalResultDto }>(
    `/api/v1/factors/${id}/auto-evaluate`,
    body
  );
  return res.data;
}

export async function loadFactorValues(
  id: string,
  q?: { symbols?: string[]; startDate?: string; endDate?: string; latestN?: number }
): Promise<FactorValueRow[]> {
  const qs: string[] = [];
  if (q?.symbols && q.symbols.length > 0)
    qs.push(`symbols=${encodeURIComponent(q.symbols.join(","))}`);
  if (q?.startDate) qs.push(`startDate=${encodeURIComponent(q.startDate)}`);
  if (q?.endDate) qs.push(`endDate=${encodeURIComponent(q.endDate)}`);
  if (typeof q?.latestN === "number") qs.push(`latestN=${q.latestN}`);
  const url = `/api/v1/factors/${id}/values${qs.length ? `?${qs.join("&")}` : ""}`;
  const res = await httpGet<{ ok: boolean; data: FactorValueRow[] }>(url);
  return res.data;
}

export async function factorValuesStats(id: string): Promise<FactorValueStats> {
  const res = await httpGet<{ ok: boolean; data: FactorValueStats }>(
    `/api/v1/factors/${id}/values/stats`
  );
  return res.data;
}

export async function listFactorEvaluations(
  id: string,
  limit = 20
): Promise<FactorEvaluationLogRow[]> {
  const res = await httpGet<{ ok: boolean; data: FactorEvaluationLogRow[] }>(
    `/api/v1/factors/${id}/evaluations?limit=${limit}`
  );
  return res.data;
}

// ── Backtest Job ──

export type BacktestJobStatus = "pending" | "running" | "completed" | "failed";

export interface BacktestSignalSpecFactorScore {
  kind: "factor_score";
  factorId?: string;
  expr: string;
  lang: "qlib_expr" | "python" | "sql" | "jsonlogic";
  reverse?: boolean;
}
export type BacktestSignalSpec =
  | BacktestSignalSpecFactorScore
  | { kind: string; [k: string]: unknown };

export interface BacktestRequestDto {
  strategyVersionId?: string;
  signals: BacktestSignalSpec;
  universe: string;
  symbols: string[];
  startDate: string;
  endDate: string;
  capital: number;
  costs: { commissionBps: number; slippageBps: number; minCommission?: number };
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
}

export interface BacktestMetricsDto {
  totalReturn: number;
  annualReturn: number;
  annualVol: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
  turnover: number;
}

export interface BacktestEquityPoint {
  date: string;
  equity: number;
  benchmarkEquity?: number;
}

export interface BacktestTradeDto {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  commission: number;
}

export interface BacktestResultDto {
  equityCurve: BacktestEquityPoint[];
  trades: BacktestTradeDto[];
  metrics: BacktestMetricsDto;
  meta: { latencyMs: number; sampleSize: number; barCount: number; skippedDays: number };
  error?: string;
}

export interface StrategyGateCheckDto {
  key: "sample_size" | "net_sharpe" | "max_drawdown" | "turnover" | "annual_return";
  label: string;
  value: number;
  threshold: number;
  operator: ">=" | "<=" | ">";
  pass: boolean;
}

export interface StrategyEvaluationDto {
  id: string;
  backtestRunId: string;
  strategyVersionId: string | null;
  evalKind: "backtest" | "paper" | "live" | "walk_forward" | "recommendation";
  qualityScore: number | null;
  pass: boolean | null;
  metrics: Record<string, unknown>;
  checks: StrategyGateCheckDto[];
  createdAt: string;
}

export interface WalkForwardEvaluationDto {
  id: string;
  backtestRunId: string;
  folds: Array<{
    fold: number;
    trainStart: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    purgeDays: number;
    metrics: BacktestMetricsDto;
    sampleSize: number;
    regime: string;
    regimeSource: "market_benchmark" | "benchmark_equity" | "strategy_equity";
  }>;
  aggregate: {
    foldCount: number;
    compoundedOosReturn: number;
    averageSharpe: number;
    worstMaxDrawdown: number;
    averageTurnover: number;
    positiveFoldRate: number;
    regimeStability: number;
  };
  pass: boolean;
}

export interface BacktestJobRecord {
  id: string;
  strategyVersionId: string;
  status: BacktestJobStatus;
  engineKey: string;
  providerId: string | null;
  config: BacktestRequestDto;
  result: BacktestResultDto | null;
  startedAt: string;
  endedAt: string | null;
  /** lineage（migration 0080） */
  createdBy: LineageCreatedBy;
  workflowRunId: string | null;
  agentInstanceId: string | null;
  /** 当回测来自 composition 时记录上游 strategy_composition.id */
  compositionId: string | null;
  evaluation: StrategyEvaluationDto | null;
}

export interface BacktestJobSubmitBody {
  strategyVersionId: string;
  compositionId?: string;
  signals?: BacktestSignalSpec;
  symbols: string[];
  universe?: string;
  startDate: string;
  endDate: string;
  capital?: number;
  costs?: { commissionBps: number; slippageBps: number; minCommission?: number };
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  providerKey?: string;
}

export async function listBacktestJobs(filter?: {
  strategyVersionId?: string;
  status?: BacktestJobStatus;
  projectId?: string;
  workflowRunId?: string;
}): Promise<BacktestJobRecord[]> {
  const qs: string[] = [];
  if (filter?.strategyVersionId)
    qs.push(`strategy_version_id=${encodeURIComponent(filter.strategyVersionId)}`);
  if (filter?.status) qs.push(`status=${encodeURIComponent(filter.status)}`);
  if (filter?.projectId) qs.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  if (filter?.workflowRunId)
    qs.push(`workflow_run_id=${encodeURIComponent(filter.workflowRunId)}`);
  const url = `/api/v1/backtest-jobs${qs.length ? `?${qs.join("&")}` : ""}`;
  const res = await httpGet<{ ok: boolean; data: BacktestJobRecord[] }>(url);
  return res.data;
}

export async function getBacktestJob(id: string): Promise<BacktestJobRecord> {
  const res = await httpGet<{ ok: boolean; data: BacktestJobRecord }>(
    `/api/v1/backtest-jobs/${id}`
  );
  return res.data;
}

export async function runBacktestJobNow(body: BacktestJobSubmitBody): Promise<BacktestJobRecord> {
  const res = await httpPost<{ ok: boolean; data: BacktestJobRecord }>(
    `/api/v1/backtest-jobs/run-now`,
    body
  );
  return res.data;
}

export async function runWalkForwardEvaluation(
  backtestRunId: string,
  body: { folds?: number; purgeDays?: number } = {}
): Promise<WalkForwardEvaluationDto> {
  const res = await httpPost<{ ok: boolean; data: WalkForwardEvaluationDto }>(
    `/api/v1/backtest-jobs/${encodeURIComponent(backtestRunId)}/walk-forward`,
    body
  );
  return res.data;
}

export interface FactorBacktestPromotionResult {
  strategyVersion: StrategyVersionRecord;
  composition: StrategyCompositionRecord;
  backtest: BacktestJobRecord;
  factorIds: string[];
  symbols: string[];
  universe: string;
}

export async function runFactorBacktestPromotionNow(body: {
  projectId?: string;
  factorIds: string[];
  strategyName?: string;
  versionTag?: string;
  compositionName?: string;
  description?: string;
  symbols?: string[];
  universe?: string;
  startDate: string;
  endDate: string;
  capital?: number;
  costs?: { commissionBps: number; slippageBps: number; minCommission?: number };
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  providerKey?: string;
  workflowRunId?: string | null;
  agentInstanceId?: string | null;
  createdBy?: string;
}): Promise<FactorBacktestPromotionResult> {
  const res = await httpPost<{ ok: boolean; data: FactorBacktestPromotionResult }>(
    "/api/v1/quant/factor-backtest-promotions/run-now",
    {
      ...(body.projectId ? { project_id: body.projectId } : {}),
      factor_ids: body.factorIds,
      ...(body.strategyName ? { strategy_name: body.strategyName } : {}),
      ...(body.versionTag ? { version_tag: body.versionTag } : {}),
      ...(body.compositionName ? { composition_name: body.compositionName } : {}),
      ...(body.description ? { description: body.description } : {}),
      ...(body.symbols ? { symbols: body.symbols } : {}),
      ...(body.universe ? { universe: body.universe } : {}),
      start_date: body.startDate,
      end_date: body.endDate,
      ...(body.capital !== undefined ? { capital: body.capital } : {}),
      ...(body.costs ? { costs: body.costs } : {}),
      ...(body.rebalance ? { rebalance: body.rebalance } : {}),
      ...(body.topN !== undefined ? { top_n: body.topN } : {}),
      ...(body.longShort !== undefined ? { longShort: body.longShort } : {}),
      ...(body.benchmark ? { benchmark: body.benchmark } : {}),
      ...(body.providerKey ? { provider_key: body.providerKey } : {}),
      ...(body.workflowRunId !== undefined ? { workflow_run_id: body.workflowRunId } : {}),
      ...(body.agentInstanceId !== undefined ? { agent_instance_id: body.agentInstanceId } : {}),
      ...(body.createdBy ? { created_by: body.createdBy } : {}),
    }
  );
  return res.data;
}

// ── Discovery ──

export type DiscoveryKind =
  | "factor_alpha101"
  | "factor_gp"
  | "factor_llm"
  | "rule_llm"
  | "genome_evolve";
export type DiscoveryStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stopped_early";

export interface DiscoveryCandidateDto {
  id: string;
  expr: string;
  lang: "qlib_expr";
  description?: string;
  category?: string;
  metrics: { ic: number; rankIc: number; sampleSize: number; score: number };
  error?: string;
}

export interface DiscoveryJobRecord {
  id: string;
  projectId: string;
  workflowRunId: string | null;
  kind: DiscoveryKind;
  status: DiscoveryStatus;
  input: {
    projectId: string;
    kind: DiscoveryKind;
    symbols: string[];
    startDate: string;
    endDate: string;
    horizonDays?: number;
    topK?: number;
    candidateCount?: number;
    seed?: number;
  };
  candidates: DiscoveryCandidateDto[];
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  /** lineage（migration 0080） */
  createdBy: LineageCreatedBy;
  agentInstanceId: string | null;
}

export interface DiscoverySubmitBody {
  projectId: string;
  kind: DiscoveryKind;
  symbols: string[];
  startDate: string;
  endDate: string;
  horizonDays?: number;
  topK?: number;
  candidateCount?: number;
  seed?: number;
  workflowRunId?: string;
}

export async function listDiscoveryJobs(filter?: {
  projectId?: string;
  kind?: DiscoveryKind;
}): Promise<DiscoveryJobRecord[]> {
  const qs: string[] = [];
  if (filter?.projectId) qs.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  if (filter?.kind) qs.push(`kind=${encodeURIComponent(filter.kind)}`);
  const url = `/api/v1/discovery-jobs${qs.length ? `?${qs.join("&")}` : ""}`;
  const res = await httpGet<{ ok: boolean; data: DiscoveryJobRecord[] }>(url);
  return res.data;
}

export async function getDiscoveryJob(id: string): Promise<DiscoveryJobRecord> {
  const res = await httpGet<{ ok: boolean; data: DiscoveryJobRecord }>(
    `/api/v1/discovery-jobs/${id}`
  );
  return res.data;
}

export async function runDiscoveryNow(body: DiscoverySubmitBody): Promise<DiscoveryJobRecord> {
  const res = await httpPost<{ ok: boolean; data: DiscoveryJobRecord }>(
    `/api/v1/discovery-jobs/run-now`,
    body
  );
  return res.data;
}

export async function promoteDiscoveryCandidate(
  jobId: string,
  candidateId: string,
  body: { name: string; category?: FactorCategory; status?: FactorStatus }
): Promise<FactorRecord> {
  const res = await httpPost<{ ok: boolean; data: FactorRecord }>(
    `/api/v1/discovery-jobs/${jobId}/candidates/${encodeURIComponent(candidateId)}/promote`,
    body
  );
  return res.data;
}

// ── Strategy + StrategyVersion (前端选择用) ──

export interface StrategyVersionFlatRecord {
  id: string;
  strategyId: string;
  versionTag: string;
  createdAt: string;
  /** 产出该版本的 workflow_run.id；NULL = IDE / REST / 历史数据 */
  workflowRunId: string | null;
  strategyName: string;
  strategyStyle: string;
  projectId: string;
}

/**
 * `createStrategyVersion` 的入参 —— 对应 `POST /api/v1/strategies/versions`。
 *
 * 用途：Composer UI 自洽 —— 此前 strategy_version 只能由 research agent /
 * strategy IDE / reia-bridge 三条非 UI 路径写入，导致用户在 Quant Workbench
 * 里看到「暂无 version」死锁。现在前端可直接调此函数兜底建一个 v1。
 */
export interface StrategyVersionCreateInput {
  projectId: string;
  /** 已有 strategy.id；与 strategyName 二选一 */
  strategyId?: string;
  /** 自动新建 strategy 时使用 */
  strategyName?: string;
  strategyStyle?: "low_freq" | "high_freq" | "mid_freq";
  versionTag?: string;
  params?: Record<string, unknown>;
  workflowRunId?: string | null;
}

export interface StrategyVersionRecord {
  id: string;
  strategyId: string;
  versionTag: string;
  logicHash: string;
  workflowRunId: string | null;
  createdAt: string;
}

export async function createStrategyVersion(
  input: StrategyVersionCreateInput
): Promise<StrategyVersionRecord> {
  const res = await httpPost<{ ok: boolean; data: StrategyVersionRecord }>(
    "/api/v1/strategies/versions",
    {
      project_id: input.projectId,
      ...(input.strategyId ? { strategy_id: input.strategyId } : {}),
      ...(input.strategyName ? { strategy_name: input.strategyName } : {}),
      ...(input.strategyStyle ? { strategy_style: input.strategyStyle } : {}),
      ...(input.versionTag ? { version_tag: input.versionTag } : {}),
      ...(input.params ? { params: input.params } : {}),
      ...(input.workflowRunId !== undefined ? { workflow_run_id: input.workflowRunId } : {}),
    }
  );
  return res.data;
}

export async function listStrategyVersions(
  filterOrProjectId?: string | { projectId?: string; workflowRunId?: string }
): Promise<StrategyVersionFlatRecord[]> {
  /**
   * 兼容旧 caller 的字符串 projectId 形式（ComposerTab / BacktestStudioTab 都靠这个）。
   * 新 caller 传 { projectId, workflowRunId } 走严格匹配，用于研究产出侧栏。
   */
  const filter =
    typeof filterOrProjectId === "string" || filterOrProjectId === undefined
      ? { projectId: filterOrProjectId }
      : filterOrProjectId;

  const qs: string[] = [];
  if (filter.projectId) qs.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  if (filter.workflowRunId) qs.push(`workflow_run_id=${encodeURIComponent(filter.workflowRunId)}`);
  const url = qs.length
    ? `/api/v1/strategies/versions?${qs.join("&")}`
    : `/api/v1/strategies/versions`;
  const res = await httpGet<{ ok: boolean; data: StrategyVersionFlatRecord[] }>(url);
  return res.data;
}

// ── Strategy Composition ──

export type StrategyKind =
  | "factor_only"
  | "rule_only"
  | "factor_with_rule"
  | "ensemble"
  | "ml_model";
export type WeightMethod = "equal" | "fixed" | "ic_weighted" | "ml_optimized";

export interface StrategyCompositionRecord {
  id: string;
  strategyVersionId: string;
  kind: StrategyKind;
  factorIds: string[];
  ruleIds: string[];
  weightMethod: WeightMethod;
  factorWeights: Record<string, number> | null;
  rebalanceFreq: string;
  universe: string;
  params: Record<string, unknown>;
  createdAt: string;
  /** lineage（migration 0080） */
  name: string;
  description: string;
  createdBy: LineageCreatedBy;
  workflowRunId: string | null;
  agentInstanceId: string | null;
  /** 当 created_by='clone' 时记录上游 composition.id */
  parentCompositionId: string | null;
}

export async function listStrategyCompositions(
  strategyVersionId: string
): Promise<StrategyCompositionRecord[]> {
  const res = await httpGet<{ ok: boolean; data: StrategyCompositionRecord[] }>(
    `/api/v1/strategy-compositions?strategy_version_id=${encodeURIComponent(strategyVersionId)}`
  );
  return res.data;
}

export async function createStrategyComposition(body: {
  strategyVersionId: string;
  kind: StrategyKind;
  factorIds?: string[];
  ruleIds?: string[];
  weightMethod?: WeightMethod;
  factorWeights?: Record<string, number>;
  rebalanceFreq?: string;
  universe?: string;
  params?: Record<string, unknown>;
  /** 命名（migration 0080） */
  name?: string;
  description?: string;
}): Promise<StrategyCompositionRecord> {
  const res = await httpPost<{ ok: boolean; data: StrategyCompositionRecord }>(
    `/api/v1/strategy-compositions`,
    body
  );
  return res.data;
}

/**
 * 从已有 composition 克隆出一份新的（created_by='clone'，parent_composition_id=源）。
 * 后端会复制 factorIds / ruleIds / weightMethod / params 等所有结构性字段。
 */
export async function cloneStrategyComposition(
  id: string,
  body: { name?: string; description?: string } = {}
): Promise<StrategyCompositionRecord> {
  const res = await httpPost<{ ok: boolean; data: StrategyCompositionRecord }>(
    `/api/v1/strategy-compositions/${encodeURIComponent(id)}/clone`,
    body
  );
  return res.data;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export type RuleAppliesTo = "screening" | "risk" | "execution" | "alert";
export type RuleLang = "jsonlogic" | "python" | "dsl";
export type RuleStatus = "draft" | "active" | "archived";

export interface RuleRecord {
  id: string;
  projectId: string;
  name: string;
  description: string;
  appliesTo: RuleAppliesTo;
  lang: RuleLang;
  dsl: unknown;
  status: RuleStatus;
  providerKey: string;
  createdAt: string;
  updatedAt: string;
  /** lineage（migration 0080） */
  createdBy: LineageCreatedBy;
  workflowRunId: string | null;
  agentInstanceId: string | null;
}

export async function listRules(filter?: {
  projectId?: string;
  appliesTo?: RuleAppliesTo;
  status?: RuleStatus;
}): Promise<RuleRecord[]> {
  const qs: string[] = [];
  if (filter?.projectId) qs.push(`project_id=${encodeURIComponent(filter.projectId)}`);
  if (filter?.appliesTo) qs.push(`applies_to=${encodeURIComponent(filter.appliesTo)}`);
  if (filter?.status) qs.push(`status=${encodeURIComponent(filter.status)}`);
  const url = `/api/v1/rules${qs.length ? `?${qs.join("&")}` : ""}`;
  const res = await httpGet<{ ok: boolean; data: RuleRecord[] }>(url);
  return res.data;
}

export async function registerRule(body: {
  projectId: string;
  name: string;
  description?: string;
  appliesTo?: RuleAppliesTo;
  lang?: RuleLang;
  dsl: unknown;
  status?: RuleStatus;
}): Promise<RuleRecord> {
  const res = await httpPost<{ ok: boolean; data: RuleRecord }>(`/api/v1/rules`, body);
  return res.data;
}

// ─── Quant Lineage ─────────────────────────────────────────────────────────
//
// 与 /src/routes/quant.routes.ts 对齐：
//   - GET  /api/v1/quant/lineage?kind=&id=   — 单节点 + 上下游
//   - POST /api/v1/quant/lineage/batch       — 批量（不含 children）
//   - GET  /api/v1/quant/agents?ids=         — agent_instance 列表解析
//   - GET  /api/v1/quant/workflows?ids=      — workflow_run 列表解析
//
// 前端 <LineageBadge> / <LineageTrail> 默认走单节点接口；列表场景（FactorTab 列表）
// 用 batch + agents/workflows 一次拉好整批 metadata，避免 N+1。

export type LineageKind = "factor" | "rule" | "composition" | "discovery_job" | "backtest_run";

export interface LineageAgentSummary {
  instanceId: string;
  definitionId: string;
  role: string;
  name: string;
}

export interface LineageWorkflowSummary {
  id: string;
  goal: string;
  mode: string;
  status: string;
  startedAt: string;
}

export interface LineageNode {
  kind: LineageKind;
  id: string;
  label: string;
  createdBy: LineageCreatedBy;
  agent: LineageAgentSummary | null;
  workflow: LineageWorkflowSummary | null;
  parent: LineageNode | null;
  children: LineageNode[];
  meta: Record<string, unknown>;
}

export async function getLineage(kind: LineageKind, id: string): Promise<LineageNode | null> {
  const url = `/api/v1/quant/lineage?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`;
  const res = await httpGet<{ ok: boolean; data?: LineageNode; error?: string }>(url);
  if (!res.ok) {
    if (res.error === "not_found") return null;
    throw new Error(res.error ?? "lineage_fetch_failed");
  }
  return res.data ?? null;
}

export async function getLineageBatch(kind: LineageKind, ids: string[]): Promise<LineageNode[]> {
  if (!ids.length) return [];
  const res = await httpPost<{ ok: boolean; data: LineageNode[] }>(`/api/v1/quant/lineage/batch`, {
    kind,
    ids,
  });
  return res.data ?? [];
}

export async function getLineageAgents(ids: string[]): Promise<LineageAgentSummary[]> {
  if (!ids.length) return [];
  const q = ids.map((s) => encodeURIComponent(s)).join(",");
  const res = await httpGet<{ ok: boolean; data: LineageAgentSummary[] }>(
    `/api/v1/quant/agents?ids=${q}`
  );
  return res.data ?? [];
}

export async function getLineageWorkflows(ids: string[]): Promise<LineageWorkflowSummary[]> {
  if (!ids.length) return [];
  const q = ids.map((s) => encodeURIComponent(s)).join(",");
  const res = await httpGet<{ ok: boolean; data: LineageWorkflowSummary[] }>(
    `/api/v1/quant/workflows?ids=${q}`
  );
  return res.data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory V2 Inspector — P3
//
// 设计原则：
//   - 列表 / 详情 / link / oplog 分别走 4 个端点，**列表 payload 不含 body**
//     （减重；点击详情才单独拉 body）。
//   - 类型用 frontend 本地 interface（不复用 backend Experience types，避免
//     drizzle Date<->string 类型耦合）。所有时间字段都是 ISO string。
//   - getMemoryMetrics 返一个 snapshot 字典（key 是点分式 metric 名，value 是 number）。
// ─────────────────────────────────────────────────────────────────────────────

export type MemoryExperienceKind =
  | "episodic"
  | "semantic"
  | "procedural"
  | "reflective"
  | "identity";

export type MemoryExperienceScope = "project" | "agent" | "global";

export type MemoryExperienceVisibility = "project_shared" | "agent_private" | "role_shared";

export type MemoryArchivalMode = "exclude_archived" | "only_archived" | "all";

export type MemoryOrderBy = "valid_from_desc" | "quality_desc" | "created_desc";

export type MemoryLinkRelation =
  | "evidence_of"
  | "derive_from"
  | "supersedes"
  | "contradicts"
  | "related_to";

/** /memory/experiences 列表项：剥掉 body，含 embeddingState 透出 */
export interface MemoryExperienceListItem {
  id: string;
  kind: MemoryExperienceKind;
  subKind: string;
  scope: MemoryExperienceScope;
  scopeId: string;
  definitionId: string | null;
  visibility: MemoryExperienceVisibility;
  summary: string;
  tags: string[];
  qualityScore: number;
  useCount: number;
  successCount: number;
  failCount: number;
  decayAt: string | null;
  validFrom: string;
  validTo: string | null;
  sourceRunId: string | null;
  sourceStepId: string | null;
  pinned: boolean;
  embeddingState: string | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryExperienceListResponse {
  items: MemoryExperienceListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** /memory/experiences/:id 详情：完整 contentJson + metadataJson */
export interface MemoryExperienceDetail extends MemoryExperienceListItem {
  contentJson: {
    summary: string;
    body?: string;
    [key: string]: unknown;
  };
  metadataJson: Record<string, unknown>;
}

export interface MemoryExperienceLinkRow {
  id: string;
  fromId: string;
  toId: string;
  relation: MemoryLinkRelation;
  weight: number;
  createdAt: string;
  /** "outgoing" = seed → other；"incoming" = other → seed */
  direction: "outgoing" | "incoming";
  otherId: string;
  other: {
    id: string;
    kind: MemoryExperienceKind;
    subKind: string;
    summary: string;
    qualityScore: number;
    validTo: string | null;
  } | null;
}

export interface MemoryExperienceLinksResponse {
  seed: {
    id: string;
    kind: MemoryExperienceKind;
    subKind: string;
    summary: string;
  };
  links: MemoryExperienceLinkRow[];
}

export interface MemoryOpLogRow {
  id: string;
  experienceId: string;
  op: string;
  actor: string;
  reason: string | null;
  ts: string;
  contextJson: Record<string, unknown> | null;
}

export interface MemoryMetricsSnapshot {
  snapshot: Record<string, number>;
  ts: string;
}

export interface ListMemoryExperiencesParams {
  projectId: string;
  kinds?: MemoryExperienceKind[];
  subKind?: string;
  definitionId?: string;
  pinnedOnly?: boolean;
  archivalMode?: MemoryArchivalMode;
  orderBy?: MemoryOrderBy;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listMemoryExperiences(
  params: ListMemoryExperiencesParams
): Promise<MemoryExperienceListResponse> {
  const query = new URLSearchParams();
  query.set("projectId", params.projectId);
  for (const k of params.kinds ?? []) query.append("kind", k);
  if (params.subKind) query.set("subKind", params.subKind);
  if (params.definitionId) query.set("definitionId", params.definitionId);
  if (params.pinnedOnly) query.set("pinnedOnly", "1");
  if (params.archivalMode) query.set("archivalMode", params.archivalMode);
  if (params.orderBy) query.set("orderBy", params.orderBy);
  if (params.q && params.q.trim()) query.set("q", params.q.trim());
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.offset != null) query.set("offset", String(params.offset));
  const res = await httpGet<{
    ok: boolean;
    data: MemoryExperienceListResponse;
  }>(`/api/v1/monitor/memory/experiences?${query.toString()}`);
  return res.data;
}

export async function getMemoryExperienceDetail(id: string): Promise<MemoryExperienceDetail> {
  const res = await httpGet<{ ok: boolean; data: MemoryExperienceDetail }>(
    `/api/v1/monitor/memory/experiences/${encodeURIComponent(id)}`
  );
  return res.data;
}

export async function getMemoryExperienceLinks(
  id: string,
  relations?: MemoryLinkRelation[]
): Promise<MemoryExperienceLinksResponse> {
  const query = new URLSearchParams();
  if (relations && relations.length > 0) {
    query.set("relations", relations.join(","));
  }
  const qs = query.toString();
  const res = await httpGet<{
    ok: boolean;
    data: MemoryExperienceLinksResponse;
  }>(`/api/v1/monitor/memory/experiences/${encodeURIComponent(id)}/links${qs ? `?${qs}` : ""}`);
  return res.data;
}

export async function getMemoryExperienceOpLog(
  id: string,
  limit?: number
): Promise<MemoryOpLogRow[]> {
  const query = new URLSearchParams();
  if (limit != null) query.set("limit", String(limit));
  const qs = query.toString();
  const res = await httpGet<{ ok: boolean; data: { items: MemoryOpLogRow[] } }>(
    `/api/v1/monitor/memory/experiences/${encodeURIComponent(id)}/oplog${qs ? `?${qs}` : ""}`
  );
  return res.data.items;
}

export async function getMemoryMetrics(): Promise<MemoryMetricsSnapshot> {
  const res = await httpGet<{ ok: boolean; data: MemoryMetricsSnapshot }>(
    `/api/v1/monitor/memory/metrics`
  );
  return res.data;
}

// ───────────────────────── Self-Evolving Agent P5 — Skill Promotions ─────────────────────────
//
// MemoryTab Skill Promotions sub-tab 用。

export type SkillPromotionState = "pending_review" | "active" | "archived" | "stale";

export interface SkillPromotionListItem {
  id: string;
  name: string;
  description: string;
  state: SkillPromotionState;
  category: string;
  definitionId: string | null;
  /** P6：来源（'user_authored' | 'agent_created' | 'open_skill_market' | 'evolved'） */
  source: string | null;
  /** P6：演化谱系上的父 skill（SkillEvolver 产物时非空） */
  parentSkillId: string | null;
  promotionRunId: string | null;
  promotionScore: number | null;
  promotionReviewAt: string | null;
  lastPromotedAt: string | null;
  useCount: number;
  successCount: number;
  failCount: number;
  pnlAttributionJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPromotionRunSummary {
  id: string;
  mode: "dry_run" | "live";
  status: "running" | "completed" | "failed";
  triggeredBy: string;
  totalScanned: number;
  totalQualified: number;
  totalPromoted: number;
  totalSkippedDuplicate: number;
  totalSkippedInsufficient: number;
  elapsedMs: number;
  startedAt: string;
  endedAt: string | null;
  errorMessage: string | null;
}

export interface SkillPromotionReviewResult {
  skillId: string;
  prevState: string;
  nextState: string;
  signature: string | null;
  reflectiveExperienceId?: string;
}

export async function listSkillPromotions(params: {
  projectId: string;
  state?: SkillPromotionState | "all";
  limit?: number;
}): Promise<{ items: SkillPromotionListItem[]; total: number }> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.state) q.set("state", params.state);
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{
    ok: boolean;
    data: { items: SkillPromotionListItem[]; total: number };
  }>(`/api/v1/monitor/memory/skill-promotions?${q.toString()}`);
  return res.data;
}

export async function listSkillPromotionRuns(params: {
  projectId: string;
  limit?: number;
}): Promise<SkillPromotionRunSummary[]> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{
    ok: boolean;
    data: { items: SkillPromotionRunSummary[] };
  }>(`/api/v1/monitor/memory/skill-promotions/runs?${q.toString()}`);
  return res.data.items;
}

export async function approveSkillPromotion(
  skillId: string,
  body: { description?: string; actor?: string } = {}
): Promise<SkillPromotionReviewResult> {
  const res = await httpPost<{ ok: boolean; data: SkillPromotionReviewResult }>(
    `/api/v1/monitor/memory/skill-promotions/${encodeURIComponent(skillId)}/approve`,
    body
  );
  return res.data;
}

export async function rejectSkillPromotion(
  skillId: string,
  body: { reason?: string; actor?: string } = {}
): Promise<SkillPromotionReviewResult> {
  const res = await httpPost<{ ok: boolean; data: SkillPromotionReviewResult }>(
    `/api/v1/monitor/memory/skill-promotions/${encodeURIComponent(skillId)}/reject`,
    body
  );
  return res.data;
}

// ───────────────────────── Self-Evolving Agent P6 — Skill Evolutions ─────────────────────────
//
// 三个端点：
//   GET   /memory/skill-evolutions/runs        — 最近 N 次 SkillEvolver 跑批
//   GET   /memory/skill-evolutions/diff        — 拉 evolved child + parent bodyMd（供前端 diff）
//   POST  /memory/skill-evolutions/request     — 手动触发：写一条 reflective(skill_revision_request)

export interface SkillEvolutionRunSummary {
  id: string;
  baseSkillId: string;
  status: "running" | "completed" | "failed";
  triggeredBy: string;
  iterations: number;
  candidatesEvaluated: number;
  baselineScore: number | null;
  bestScore: number | null;
  winningSkillId: string | null;
  startedAt: string;
  endedAt: string | null;
  errorMessage: string | null;
}

export interface SkillEvolutionDiff {
  child: {
    id: string;
    name: string;
    bodyMd: string;
    description: string;
    parentSkillId: string | null;
    source: string | null;
    state: SkillPromotionState;
  };
  parent: {
    id: string;
    name: string;
    bodyMd: string;
    description: string;
    state: SkillPromotionState;
  } | null;
}

export interface SkillRevisionRequestResult {
  status: "created" | "deduped";
  experienceId: string;
}

export async function listSkillEvolutionRuns(params: {
  projectId: string;
  limit?: number;
}): Promise<SkillEvolutionRunSummary[]> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{
    ok: boolean;
    data: { items: SkillEvolutionRunSummary[] };
  }>(`/api/v1/monitor/memory/skill-evolutions/runs?${q.toString()}`);
  return res.data.items;
}

export async function getSkillEvolutionDiff(skillId: string): Promise<SkillEvolutionDiff> {
  const res = await httpGet<{ ok: boolean; data: SkillEvolutionDiff }>(
    `/api/v1/monitor/memory/skill-evolutions/diff?skillId=${encodeURIComponent(skillId)}`
  );
  return res.data;
}

export async function requestSkillRevision(body: {
  projectId: string;
  baseSkillId: string;
  reason?: string;
  requestedBy?: string;
  iterations?: number;
  candidatesPerIteration?: number;
}): Promise<SkillRevisionRequestResult> {
  const res = await httpPost<{ ok: boolean; data: SkillRevisionRequestResult }>(
    `/api/v1/monitor/memory/skill-evolutions/request`,
    body
  );
  return res.data;
}

// ───────────────────────── Self-Evolving Agent P7 — Tool Gaps ─────────────────────────

export type ToolGapDetectionKind =
  | "unknown_tool"
  | "repeated_fail"
  | "reflective_mention"
  | "explicit_report";

export type ToolGapStatus = "open" | "proposed" | "installed" | "wont_fix" | "rejected";

export interface ToolGapListItem {
  id: string;
  projectId: string;
  workflowRunId: string | null;
  definitionId: string | null;
  detectionKind: ToolGapDetectionKind;
  gapSignature: string;
  requestedToolName: string | null;
  requestedToolKind: string | null;
  excerpt: string | null;
  sourceToolCallId: string | null;
  sourceExperienceId: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: ToolGapStatus;
  statusAt: string | null;
  statusBy: string | null;
  statusReason: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ToolGapRunSummary {
  id: string;
  projectId: string;
  status: "running" | "completed" | "failed";
  triggeredBy: string;
  fromTs: string | null;
  toTs: string | null;
  unknownToolCount: number;
  repeatedFailCount: number;
  reflectiveMentionCount: number;
  totalSignals: number;
  gapsCreated: number;
  gapsIncremented: number;
  gapsSkipped: number;
  actionsJson: Array<{
    signature: string;
    detectionKind: ToolGapDetectionKind;
    action: "created" | "incremented" | "skipped";
    skipReason?: string;
    gapId?: string;
  }>;
  elapsedMs: number;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
}

export async function listToolGaps(params: {
  projectId: string;
  status?: ToolGapStatus | "all";
  kind?: ToolGapDetectionKind;
  limit?: number;
}): Promise<ToolGapListItem[]> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.status) q.set("status", params.status);
  if (params.kind) q.set("kind", params.kind);
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{ ok: boolean; data: { items: ToolGapListItem[]; total: number } }>(
    `/api/v1/monitor/memory/tool-gaps?${q.toString()}`
  );
  return res.data.items;
}

export async function listToolGapRuns(params: {
  projectId: string;
  limit?: number;
}): Promise<ToolGapRunSummary[]> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{ ok: boolean; data: { items: ToolGapRunSummary[] } }>(
    `/api/v1/monitor/memory/tool-gaps/runs?${q.toString()}`
  );
  return res.data.items;
}

export async function markToolGapWontFix(
  gapId: string,
  body: { reason?: string; actor?: string } = {}
): Promise<{ id: string; prevStatus: string; nextStatus: string }> {
  const res = await httpPost<{
    ok: boolean;
    data: { id: string; prevStatus: string; nextStatus: string };
  }>(`/api/v1/monitor/memory/tool-gaps/${gapId}/wont-fix`, body);
  return res.data;
}

export async function reopenToolGap(
  gapId: string,
  body: { reason?: string; actor?: string } = {}
): Promise<{ id: string; prevStatus: string; nextStatus: string }> {
  const res = await httpPost<{
    ok: boolean;
    data: { id: string; prevStatus: string; nextStatus: string };
  }>(`/api/v1/monitor/memory/tool-gaps/${gapId}/reopen`, body);
  return res.data;
}

export async function reportToolGap(body: {
  projectId: string;
  toolName?: string;
  serverName?: string;
  signature?: string;
  toolKind?: string;
  reason?: string;
  workflowRunId?: string;
  definitionId?: string;
}): Promise<{ action: "created" | "incremented" | "skipped"; gapId?: string; signature: string }> {
  const res = await httpPost<{
    ok: boolean;
    data: { action: "created" | "incremented" | "skipped"; gapId?: string; signature: string };
  }>(`/api/v1/monitor/memory/tool-gaps/report`, body);
  return res.data;
}

// ===========================================================================
// Self-Evolving Agent P8 — AutoInstaller propose 模式（docs §6.6）
// 前端 MemoryTab > Tool Gaps sub-tab "Proposals" section 消费。
// ===========================================================================

export type ProposalKind = "install_mcp_catalog" | "install_mcp_external" | "no_candidate";
export type ProposalState = "pending_review" | "approved" | "rejected" | "no_candidate";
export type ProposalSafetyLevel = "low" | "medium" | "high";

export interface AutoInstallProposalItem {
  id: string;
  projectId: string;
  gapLogId: string;
  proposalKind: ProposalKind;
  safetyLevel: ProposalSafetyLevel;
  matchScore: number;
  targetKind: "mcp_catalog" | "mcp_catalog_item" | null;
  targetId: string | null;
  targetSlug: string | null;
  payloadJson: Record<string, unknown>;
  candidatesJson: Array<{
    targetKind: "mcp_catalog" | "mcp_catalog_item";
    targetId: string;
    targetSlug: string;
    name: string;
    score: number;
    ruleHits: string[];
    safetyLevel: ProposalSafetyLevel;
  }>;
  state: ProposalState;
  stateAt: string | null;
  stateBy: string | null;
  stateReason: string | null;
  proposerRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoInstallerRunItem {
  id: string;
  projectId: string;
  status: "running" | "completed" | "failed";
  triggeredBy: string;
  gapsScanned: number;
  proposalsCreated: number;
  proposalsSkippedExisting: number;
  proposalsNoCandidate: number;
  actionsJson: Array<{
    gapId: string;
    gapSignature: string;
    action: "proposed" | "skipped_existing" | "no_candidate";
    proposalId?: string;
    candidate?: { slug: string; score: number; targetKind: string };
    reason?: string;
  }>;
  elapsedMs: number;
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
}

export async function listAutoInstallProposals(params: {
  projectId: string;
  state?: ProposalState | "all";
  limit?: number;
}): Promise<AutoInstallProposalItem[]> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.state) q.set("state", params.state);
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{
    ok: boolean;
    data: { items: AutoInstallProposalItem[]; total: number };
  }>(`/api/v1/monitor/memory/auto-installer/proposals?${q.toString()}`);
  return res.data.items;
}

export async function listAutoInstallerRuns(params: {
  projectId: string;
  limit?: number;
}): Promise<AutoInstallerRunItem[]> {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.limit != null) q.set("limit", String(params.limit));
  const res = await httpGet<{ ok: boolean; data: { items: AutoInstallerRunItem[] } }>(
    `/api/v1/monitor/memory/auto-installer/runs?${q.toString()}`
  );
  return res.data.items;
}

export async function approveAutoInstallProposal(
  proposalId: string,
  body: { reason?: string; actor?: string } = {}
): Promise<{
  proposalId: string;
  gapLogId: string;
  fromState: string;
  toState: string;
  gapStatusChanged: boolean;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      proposalId: string;
      gapLogId: string;
      fromState: string;
      toState: string;
      gapStatusChanged: boolean;
    };
  }>(`/api/v1/monitor/memory/auto-installer/proposals/${proposalId}/approve`, body);
  return res.data;
}

export async function rejectAutoInstallProposal(
  proposalId: string,
  body: { reason?: string; actor?: string } = {}
): Promise<{
  proposalId: string;
  gapLogId: string;
  fromState: string;
  toState: string;
  gapStatusChanged: boolean;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      proposalId: string;
      gapLogId: string;
      fromState: string;
      toState: string;
      gapStatusChanged: boolean;
    };
  }>(`/api/v1/monitor/memory/auto-installer/proposals/${proposalId}/reject`, body);
  return res.data;
}
