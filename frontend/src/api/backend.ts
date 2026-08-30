import {
  backendFetchUrl,
  backendWebSocketUrl,
  httpDelete,
  httpGet,
  httpPatch,
  httpPost,
  httpPut,
} from "./client";
import type {
  AgentDefinitionBundle,
  AgentDefinitionDraftRecord,
  AgentMemoryStatsResponse,
  AgentPackResponse,
  AgentPromptPreviewResponse,
  AgentRuntimeMetricRecord,
  AgentSkillRecord,
  AgentSkillState,
  AgentSummary,
  AgentsConfigResponse,
  AlertEventRecord,
  AnalystTeamGraphPayload,
  BrokerAccountRecord,
  BrokerOrderEventRecord,
  BrokerProvider,
  BuiltinConnectorConfig,
  ChatMessage,
  ChatSession,
  CommunicationChannelRecord,
  CommunicationMessageLogRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
  ExecutionConfirmTicketRecord,
  ExecutionReportRecord,
  ExecutionSafetyCheckResult,
  ExecutionSafetyConfig,
  GeneGenerationRecord,
  GeneTrendPoint,
  IndicatorStrategyScriptRecord,
  IntegrationAdapterDescriptor,
  IntegrationKind,
  IntentDeviationRecord,
  IntentOrderRecord,
  KlineBar,
  KlinesErrorPayload,
  KlinesResponseMeta,
  MarketNewsBriefPayload,
  McpCatalogInstallRecord,
  McpCatalogItemRecord,
  McpCatalogPageResult,
  McpCatalogRecord,
  McpProjectInstallRecord,
  McpRegistrySourceRecord,
  McpServerConfigRecord,
  McpToolBindingRecord,
  ModelConfig,
  OpenSkillMarketEntryDto,
  OptionChain,
  RecommendationRecord,
  RecommendationSide,
  RecommendationStats,
  RecommendationStatus,
  RiskConfig,
  RiskVetoLogRecord,
  ScheduledJobRecord,
  ScheduledJobRunRecord,
  ScreenerCandidateRecord,
  ScreenerRunRecord,
  SessionA2AMessageItem,
  SessionAgentBoardItem,
  SessionOverview,
  SkillMarketInstallRecord,
  SkillMarketPageResult,
  SkillMarketStatusDto,
  StepStreamEvent,
  StrategyGenomeRecord,
  SubAgentTaskRecord,
  ToolCatalogEntry,
  WindSessionStatus,
  WorkflowArtifactsDto,
  WorkflowCompensationTaskRecord,
  WorkflowDetail,
  WorkflowObservability,
  WorkflowQualitySnapshotRecord,
  WorkflowTimeline,
} from "./types";

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
    workflowRunId?: string;
    symbol?: string;
    side?: RecommendationSide;
    status?: RecommendationStatus;
    limit?: number;
  } = {}
): Promise<RecommendationRecord[]> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("project_id", params.projectId);
  if (params.workflowRunId) query.set("workflow_run_id", params.workflowRunId);
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

export type KlinesBatchEntry = {
  bars: KlineBar[];
  meta: KlinesResponseMeta;
  error?: KlinesErrorPayload;
};

/** 批量 K 线（自选 sparkline）；服务端并发受限并复用缓存。 */
export async function getKlinesBatch(params: {
  requests: Array<{ symbol: string; exchange?: string; timeframe?: string; limit?: number }>;
}): Promise<Record<string, KlinesBatchEntry>> {
  const response = await httpPost<{ ok: boolean; data: Record<string, KlinesBatchEntry> }>(
    "/api/v1/market/klines/batch",
    params
  );
  return response.data ?? {};
}

/** 券商优先期权链；source=futu 禁止公开源降级，research 为明确研究级模式。 */
export async function getOptionChain(params: {
  symbol: string;
  exchange?: string;
  expiry?: string;
  source?: "auto" | "futu" | "alpaca" | "research";
}): Promise<OptionChain> {
  const q = new URLSearchParams({ symbol: params.symbol });
  if (params.exchange) q.set("exchange", params.exchange);
  if (params.expiry) q.set("expiry", params.expiry);
  if (params.source) q.set("source", params.source);
  const response = await httpGet<{ ok: boolean; data: OptionChain }>(
    `/api/v1/market/options/chain?${q.toString()}`
  );
  return response.data;
}

/** 本机只读期权策略分析模块；服务端使用当前链快照构造多腿策略。 */
export async function getOptionStrategyAnalysis(params: {
  symbol: string;
  strategy: string;
  exchange?: string;
  expiry?: string;
  farExpiry?: string;
  source?: "auto" | "futu" | "alpaca" | "research";
  centerStrike?: number;
  widthSteps?: number;
  quantity?: number;
  singleRight?: "call" | "put";
  singleSide?: "buy" | "sell";
  direction?: "bullish" | "bearish";
}): Promise<import("./types").OptionStrategyAnalysis> {
  const query = new URLSearchParams({ symbol: params.symbol, strategy: params.strategy });
  if (params.exchange) query.set("exchange", params.exchange);
  if (params.expiry) query.set("expiry", params.expiry);
  if (params.farExpiry) query.set("farExpiry", params.farExpiry);
  if (params.source) query.set("source", params.source);
  if (params.centerStrike != null) query.set("centerStrike", String(params.centerStrike));
  if (params.widthSteps != null) query.set("widthSteps", String(params.widthSteps));
  if (params.quantity != null) query.set("quantity", String(params.quantity));
  if (params.singleRight) query.set("singleRight", params.singleRight);
  if (params.singleSide) query.set("singleSide", params.singleSide);
  if (params.direction) query.set("direction", params.direction);
  const response = await httpGet<{ ok: boolean; data: import("./types").OptionStrategyAnalysis }>(
    `/api/v1/market/options/strategy-analyze?${query.toString()}`
  );
  return response.data;
}

export async function getMarketQuote(params: {
  symbol: string;
  exchange?: string;
}): Promise<import("./types").MarketQuote> {
  const query = new URLSearchParams({ symbol: params.symbol });
  if (params.exchange) query.set("exchange", params.exchange);
  const response = await httpGet<{
    ok: boolean;
    data: import("./types").MarketQuote;
  }>(`/api/v1/market/quote?${query.toString()}`);
  return response.data;
}

/**
 * 用一条 WebSocket 批量订阅自选报价。后端会优先使用券商/交易所推流，
 * 无可用推流时才由网关按 2 秒节奏轮询；调用方可根据 `event.source` 明示来源。
 */
export function subscribeMarketQuoteStream(params: {
  subscriptions: Array<{
    symbol: string;
    exchange?: string;
    timeframe?: string;
    channels?: Array<"quote" | "order_book" | "trade" | "bar">;
  }>;
  onEvent: (event: import("./types").MarketStreamEvent) => void;
  onConnectionChange?: (
    status: "connecting" | "connected" | "reconnecting" | "stale" | "closed"
  ) => void;
}): () => void {
  const subscriptions = params.subscriptions
    .filter((subscription) => subscription.symbol.trim())
    .slice(0, 30)
    .map((subscription) => ({
      symbol: subscription.symbol.trim(),
      ...(subscription.exchange?.trim() ? { exchange: subscription.exchange.trim() } : {}),
      timeframe: subscription.timeframe ?? "1m",
      channels:
        subscription.channels && subscription.channels.length > 0
          ? [...new Set(subscription.channels)]
          : ["quote"],
    }));
  if (subscriptions.length === 0) return () => undefined;

  let disposed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let staleTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  let lastMessageAt = Date.now();

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return;
    reconnectAttempt += 1;
    params.onConnectionChange?.("reconnecting");
    const delayMs = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const connect = () => {
    if (disposed) return;
    params.onConnectionChange?.("connecting");
    socket = new WebSocket(backendWebSocketUrl("market"));
    socket.addEventListener("open", () => {
      reconnectAttempt = 0;
      lastMessageAt = Date.now();
      params.onConnectionChange?.("connected");
      socket?.send(JSON.stringify({ action: "subscribe_market_batch", subscriptions }));
    });
    socket.addEventListener("message", (message) => {
      lastMessageAt = Date.now();
      try {
        const envelope = JSON.parse(String(message.data)) as {
          topic?: string;
          payload?: import("./types").MarketStreamEvent;
        };
        if (envelope.topic === "market" && envelope.payload?.kind) params.onEvent(envelope.payload);
      } catch {
        // A malformed single packet must not tear down the whole quote subscription.
      }
    });
    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => socket?.close());
  };

  connect();
  staleTimer = setInterval(() => {
    if (Date.now() - lastMessageAt > 45_000) {
      params.onConnectionChange?.("stale");
      socket?.close();
    } else if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ action: "ping" }));
    }
  }, 15_000);

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (staleTimer) clearInterval(staleTimer);
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ action: "unsubscribe_market" }));
    socket?.close();
    params.onConnectionChange?.("closed");
  };
}

export async function getMarketWatchlist(options?: {
  /** false = 跳过券商持仓拉取，IDE 首屏更快 */
  includePositions?: boolean;
}): Promise<import("./types").MarketWatchlistSnapshot> {
  const query = options?.includePositions === false ? "?includePositions=0" : "";
  const response = await httpGet<{ ok: boolean; data: import("./types").MarketWatchlistSnapshot }>(
    `/api/v1/market/watchlist${query}`
  );
  return response.data;
}

export async function addMarketWatchlistItem(input: {
  symbol: string;
  exchange?: string;
  label?: string;
}): Promise<import("./types").MarketWatchlistSnapshot> {
  const response = await httpPost<{ ok: boolean; data: import("./types").MarketWatchlistSnapshot }>(
    "/api/v1/market/watchlist",
    input
  );
  return response.data;
}

export async function removeMarketWatchlistItem(
  symbol: string,
  exchange?: string
): Promise<import("./types").MarketWatchlistSnapshot> {
  const query = exchange ? `?exchange=${encodeURIComponent(exchange)}` : "";
  const response = await httpDelete<{
    ok: boolean;
    data: import("./types").MarketWatchlistSnapshot;
  }>(`/api/v1/market/watchlist/${encodeURIComponent(symbol)}${query}`);
  return response.data;
}

export async function getMarketOrderBook(params: {
  symbol: string;
  exchange?: string;
  depth?: number;
}): Promise<import("./types").MarketOrderBook> {
  const query = new URLSearchParams({ symbol: params.symbol });
  if (params.exchange) query.set("exchange", params.exchange);
  if (params.depth != null) query.set("depth", String(params.depth));
  const response = await httpGet<{
    ok: boolean;
    data: import("./types").MarketOrderBook;
  }>(`/api/v1/market/order-book?${query.toString()}`);
  return response.data;
}

export async function getMarketTrades(params: {
  symbol: string;
  exchange?: string;
  limit?: number;
}): Promise<import("./types").MarketTrade[]> {
  const query = new URLSearchParams({ symbol: params.symbol });
  if (params.exchange) query.set("exchange", params.exchange);
  if (params.limit != null) query.set("limit", String(params.limit));
  const response = await httpGet<{
    ok: boolean;
    data: import("./types").MarketTrade[];
  }>(`/api/v1/market/trades?${query.toString()}`);
  return response.data;
}

export async function getChipDistribution(params: {
  symbol: string;
  exchange?: string;
  adjust?: "none" | "pre" | "post";
}): Promise<import("./types").ChipDistributionPoint[]> {
  const query = new URLSearchParams({ symbol: params.symbol });
  if (params.exchange) query.set("exchange", params.exchange);
  if (params.adjust) query.set("adjust", params.adjust);
  const response = await httpGet<{
    ok: boolean;
    data: import("./types").ChipDistributionPoint[];
  }>(`/api/v1/market/chip-distribution?${query.toString()}`);
  return response.data;
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

/** FS-first 课题 Workspace（与 DB /workspaces 并列） */
export type FsWorkspaceManifest = {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
  defaultFocus?: { symbol: string; exchange?: string };
  providers: {
    memory: { kind: string };
    decision: { kind: string };
    market?: { kind: string };
  };
};

export type FsWorkspaceTreeNode = {
  id: string;
  name: string;
  kind: string;
  relPath?: string;
  children?: FsWorkspaceTreeNode[];
};

export async function listFsWorkspaces(): Promise<
  Array<{ rootPath: string; manifest: FsWorkspaceManifest }>
> {
  const res = await httpGet<{
    data: Array<{ rootPath: string; manifest: FsWorkspaceManifest }>;
  }>("/api/v1/fs-workspaces");
  return res.data ?? [];
}

export async function listFsWorkspaceProviderKinds(): Promise<{
  memory: string[];
  decision: string[];
}> {
  const res = await httpGet<{ data: { memory: string[]; decision: string[] } }>(
    "/api/v1/fs-workspaces/provider-kinds"
  );
  return res.data;
}

export async function createFsWorkspaceApi(input: {
  name: string;
  description?: string;
  slug?: string;
  seedUniverse?: {
    symbols?: Array<{ symbol: string; exchange?: string }>;
    mode?: string;
  };
  defaultFocus?: { symbol: string; exchange?: string };
}): Promise<{ rootPath: string; manifest: FsWorkspaceManifest }> {
  const res = await httpPost<{
    data: { rootPath: string; manifest: FsWorkspaceManifest };
  }>("/api/v1/fs-workspaces", input);
  return res.data;
}

export async function getFsWorkspaceTree(
  id: string,
  opts?: { maxDepth?: number }
): Promise<FsWorkspaceTreeNode> {
  const q = new URLSearchParams();
  if (opts?.maxDepth != null) q.set("maxDepth", String(opts.maxDepth));
  const qs = q.toString();
  const res = await httpGet<{ data: FsWorkspaceTreeNode }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(id)}/tree${qs ? `?${qs}` : ""}`
  );
  return res.data;
}

export async function getFsWorkspaceFile(
  id: string,
  path: string
): Promise<{ path: string; content: string }> {
  const q = new URLSearchParams({ path });
  const res = await httpGet<{ data: { path: string; content: string } }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(id)}/file?${q}`
  );
  return res.data;
}

export async function putFsWorkspaceFile(id: string, path: string, content: string): Promise<void> {
  await httpPut(`/api/v1/fs-workspaces/${encodeURIComponent(id)}/file`, {
    path,
    content,
  });
}

export async function putFsWorkspaceRun(
  workspaceId: string,
  runId: string,
  body: {
    title: string;
    status: string;
    workflowId?: string;
    sessionId?: string;
    modelId?: string;
    focus?: { symbol?: string; exchange?: string };
  }
): Promise<void> {
  await httpPut(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
    body
  );
}

export type FsMemoryEntry = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  tags?: string[];
  source?: "user" | "agent_proposal" | "import" | "experience";
  relPath?: string;
  score?: number;
};

export async function listFsWorkspaceMemory(
  workspaceId: string,
  opts?: { q?: string; pinned?: boolean; limit?: number }
): Promise<FsMemoryEntry[]> {
  const q = new URLSearchParams();
  if (opts?.q) q.set("q", opts.q);
  if (opts?.pinned != null) q.set("pinned", opts.pinned ? "1" : "0");
  if (opts?.limit != null) q.set("limit", String(opts.limit));
  const qs = q.toString();
  const res = await httpGet<{ data: FsMemoryEntry[] }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/memory${qs ? `?${qs}` : ""}`
  );
  return res.data ?? [];
}

export async function getFsWorkspaceMemory(
  workspaceId: string,
  entryId: string
): Promise<FsMemoryEntry | null> {
  try {
    const res = await httpGet<{ data: FsMemoryEntry }>(
      `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(entryId)}`
    );
    return res.data;
  } catch {
    return null;
  }
}

export async function upsertFsWorkspaceMemory(
  workspaceId: string,
  body: {
    id?: string;
    title: string;
    body: string;
    pinned?: boolean;
    tags?: string[];
    source?: "user" | "agent_proposal" | "import";
  }
): Promise<FsMemoryEntry> {
  const res = await httpPost<{ data: FsMemoryEntry }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/memory`,
    body
  );
  return res.data;
}

export async function deleteFsWorkspaceMemory(workspaceId: string, entryId: string): Promise<void> {
  await httpDelete(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/memory/${encodeURIComponent(entryId)}`
  );
}

export async function syncFsWorkspaceDecision(
  workspaceId: string,
  projectId: string
): Promise<{ factorCount: number; strategyCount: number }> {
  const res = await httpPost<{ data: { factorCount: number; strategyCount: number } }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/decision/sync`,
    { projectId }
  );
  return res.data;
}

export type FsDecisionAssetItem = {
  id: string;
  name: string;
  relPath?: string;
};

export async function listFsWorkspaceDecisionStrategies(
  workspaceId: string
): Promise<{ kind: string; items: FsDecisionAssetItem[] }> {
  const res = await httpGet<{ data: { kind: string; items: FsDecisionAssetItem[] } }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/decision/strategies`
  );
  return res.data;
}

export async function listFsWorkspaceDecisionFactors(
  workspaceId: string
): Promise<{ kind: string; items: FsDecisionAssetItem[] }> {
  const res = await httpGet<{ data: { kind: string; items: FsDecisionAssetItem[] } }>(
    `/api/v1/fs-workspaces/${encodeURIComponent(workspaceId)}/decision/factors`
  );
  return res.data;
}

export async function listAgents(): Promise<AgentSummary[]> {
  const res = await httpGet<{ data: AgentSummary[] }>("/api/v1/agents");
  return res.data;
}

export async function createConversationTurn(input: {
  sessionId: string;
  projectId: string;
  message: string;
  workflowRunId?: string;
  workflowMode?: import("./types").WorkflowMode;
  reuseSessionWorkflow?: boolean;
  turnMode?: "new_goal" | "continue_goal";
  loopKind?: import("./types").AgentLoopKind;
  roleReasoner?: import("./types").AgentLoopKind;
  hitlMode?: "off" | "ai" | "always";
  agentMode?: import("./types").AgentControlMode;
  processConfig?: import("./types").WorkflowProcessConfig;
  preserveGoal?: boolean;
  fsWorkspaceId?: string;
  attachments?: import("./types").ChatImageAttachment[];
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
 * 停止当前 Agent 运行（Cursor 式 Stop）：
 * - Bun 协作 interrupt（团队 wave 边界）
 * - 若有 Prime Core 在飞 turn，同步 cancelTurn
 */
export async function interruptWorkflow(workflowId: string): Promise<{
  workflowRunId: string;
  requested: boolean;
  /** 服务端已写入的权威工作流状态；200 后应以此为准而非旧列表轮询结果。 */
  status: string;
  /** 服务端确认停止状态的时间。 */
  acknowledgedAt: string;
  coreCancelled?: boolean;
  turnId?: string;
  coreReason?: string;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      workflowRunId: string;
      requested: boolean;
      status: string;
      acknowledgedAt: string;
      coreCancelled?: boolean;
      turnId?: string;
      coreReason?: string;
    };
  }>(`/api/v1/workflows/${workflowId}/interrupt`, {});
  return res.data;
}

export type WorkflowResumeStatus = {
  workflowId: string;
  status: string;
  resumable: boolean;
  reason: string | null;
  hasBunSnapshot: boolean;
  hasCoreSession: boolean;
  snapshot?: { phase: string; stepIndex: number; createdAt: string };
  suggestedMode: "checkpoint" | "fresh";
  interruptionHint: string | null;
};

export async function getWorkflowResumeStatus(workflowId: string): Promise<WorkflowResumeStatus> {
  const res = await httpGet<{ data: WorkflowResumeStatus }>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/resume-status`
  );
  return res.data;
}

/** Cursor-style resume from checkpoint (or fresh restart). */
export async function resumeWorkflow(
  workflowId: string,
  input?: { mode?: "checkpoint" | "fresh"; note?: string }
): Promise<{
  ok: boolean;
  taskId: string;
  mode: "checkpoint" | "fresh";
  status: WorkflowResumeStatus;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      ok: boolean;
      taskId: string;
      mode: "checkpoint" | "fresh";
      status: WorkflowResumeStatus;
    };
  }>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/resume`, input ?? {});
  return res.data;
}

/**
 * v2：HITL 卡片支持的交互形态。
 * - approve_only：批准 / 拒绝（v1 兼容默认值）
 * - single_choice：单选（inputSchema.options 列出选项）
 * - multi_choice：多选（同上 + 可选 min/maxSelect）
 * - free_form：自由文本（inputSchema.placeholder/maxLength）
 * - form：结构化填空（inputSchema.fields）
 * 选择题可同时带 allowFreeText / fields，做「选题 + 填空」。
 */
export type HitlInputKind =
  | "approve_only"
  | "single_choice"
  | "multi_choice"
  | "free_form"
  | "form";

export interface HitlInputField {
  key: string;
  label: string;
  type?: "text" | "number";
  required?: boolean;
  placeholder?: string;
}

export interface HitlInputSchema {
  /** 面向用户的问题正文（优先于 title 展示） */
  question?: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  /** 选择题是否允许额外补充说明 */
  allowFreeText?: boolean;
  placeholder?: string;
  maxLength?: number;
  minSelect?: number;
  maxSelect?: number;
  /** form / 选择题附带的填空字段 */
  fields?: HitlInputField[];
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
 *   - single_choice：response = { value: string } (+ 可选 text / fields)
 *   - multi_choice：response = { values: string[] } (+ 可选 text / fields)
 *   - free_form：response = { text: string }
 *   - form：response = { fields: Record<string, string> } (+ 可选 text)
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
    status?: "pending" | "running" | "completed" | "partial" | "failed" | "cancelled";
    loopOptionsJson?: Partial<import("./types").LoopOptionsJson>;
  }
): Promise<{ data: Record<string, unknown> }> {
  return httpPatch<{ data: Record<string, unknown> }>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
    input as Record<string, unknown>
  );
}

export async function updateWorkflowGoal(
  workflowId: string,
  input: { action: "pause" | "resume" | "edit" | "clear"; text?: string }
): Promise<{ data: import("../components/team/PlanCard").OrchestratorPlan | null }> {
  return httpPatch<{ data: import("../components/team/PlanCard").OrchestratorPlan | null }>(
    `/api/v1/workflows/${encodeURIComponent(workflowId)}/goal`,
    input
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
  executionKind?: "primary" | "subagent" | "reactor";
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
  executionKind?: "primary" | "subagent" | "reactor";
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

export async function saveModelConfig(
  input: Partial<Omit<ModelConfig, "embedding">> & {
    embedding?: Partial<NonNullable<ModelConfig["embedding"]>> | null;
  }
): Promise<ModelConfig> {
  const res = await httpPost<{ data: ModelConfig }>("/api/v1/agents/model-config", input);
  return res.data;
}

export async function testEmbeddingModelConfig(text?: string): Promise<{
  ok: boolean;
  data?: {
    model: string;
    dimension: number;
    tokensUsed: number;
    latencyMs: number;
    sampleNorm: number;
  };
  error?: string;
}> {
  return httpPost("/api/v1/agents/model-config/embedding/test", {
    ...(text ? { text } : {}),
  });
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

/** 获取 session 唯一 chat workflow（1 session = 1 workflow）。 */
export async function getChatSessionWorkflow(
  sessionId: string,
  projectId: string
): Promise<Record<string, unknown>> {
  const res = await httpGet<{ data: Record<string, unknown> }>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/workflow?projectId=${encodeURIComponent(projectId)}`
  );
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

export type StrategyManifestV2 = {
  apiVersion: number;
  codeHash: string;
  strategyType: string;
  universe: {
    kind: string;
    instruments: Array<{ market: string; symbol: string; instrumentId: string }>;
  };
  handlers: string[];
  warmupBars: number;
  primaryFrequency: string;
  paramsSchema: Array<{
    name: string;
    type: string;
    default: unknown;
    description?: string;
  }>;
  metadata?: Record<string, unknown>;
};

export async function compileStrategyContract(
  code: string,
  opts?: {
    sessionId?: string;
    workflowRunId?: string;
    scriptId?: string;
    name?: string;
    /** default true when session/workflow/script provided */
    persist?: boolean;
  }
): Promise<
  | {
      ok: true;
      manifest: StrategyManifestV2;
      persisted?: boolean;
      scriptId?: string;
      scriptName?: string;
      created?: boolean;
      persistReason?: string;
    }
  | { ok: false; error: string }
> {
  try {
    const payload: Record<string, unknown> = { code };
    if (opts?.sessionId) payload.sessionId = opts.sessionId;
    if (opts?.workflowRunId) payload.workflowRunId = opts.workflowRunId;
    if (opts?.scriptId) payload.scriptId = opts.scriptId;
    if (opts?.name) payload.name = opts.name;
    if (opts?.persist !== undefined) payload.persist = opts.persist;
    const res = await httpPost<{
      ok: boolean;
      data?: {
        ok: true;
        manifest: StrategyManifestV2;
        persisted?: boolean;
        scriptId?: string;
        scriptName?: string;
        created?: boolean;
        persistReason?: string;
      };
      error?: string;
    }>("/api/v1/quant/strategy-contract/compile", payload);
    if (!res.ok || !res.data?.ok) {
      return { ok: false, error: res.error ?? "compile_failed" };
    }
    return res.data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function backtestStrategyContractApi(input: {
  code: string;
  symbol?: string;
  limit?: number;
  timeframe?: string;
  initialCapital?: number;
}): Promise<{
  ok: boolean;
  error?: string;
  data?: {
    manifest: StrategyManifestV2;
    metrics: {
      totalReturnPct: number;
      maxDrawdownPct: number;
      sharpeApprox: number;
      tradeCount: number;
      bars: number;
    };
    primarySymbol: string;
    tradeCount: number;
    intentCount?: number;
    trades?: Array<{
      time?: string;
      side?: "buy" | "sell" | string;
      reason?: string;
    }>;
  };
}> {
  try {
    const res = await httpPost<{
      ok: boolean;
      error?: string;
      data?: {
        manifest: StrategyManifestV2;
        metrics: {
          totalReturnPct: number;
          maxDrawdownPct: number;
          sharpeApprox: number;
          tradeCount: number;
          bars: number;
        };
        primarySymbol: string;
        tradeCount?: number;
        intentCount?: number;
        intents?: unknown[];
      };
    }>("/api/v1/quant/strategy-contract/backtest", input);
    if (!res.ok || !res.data) {
      return { ok: false, error: res.error ?? "backtest_failed" };
    }
    return {
      ok: true,
      data: {
        ...res.data,
        tradeCount: res.data.tradeCount ?? res.data.metrics.tradeCount,
        intentCount: res.data.intentCount ?? res.data.intents?.length,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function paperDeployStrategyContract(input: {
  code: string;
  paperCapital?: number;
  market?: string;
  timeframe?: string;
  projectId?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  data?: {
    sessionId: string;
    codeHash: string;
    paperCapital: number;
    primarySymbol: string;
    klinesSymbol: string;
    manifest: StrategyManifestV2;
  };
}> {
  try {
    const res = await httpPost<{
      ok: boolean;
      error?: string;
      data?: {
        sessionId: string;
        codeHash: string;
        paperCapital: number;
        primarySymbol: string;
        klinesSymbol: string;
        manifest: StrategyManifestV2;
      };
    }>("/api/v1/quant/strategy-contract/paper-deploy", input);
    if (!res.ok || !res.data) {
      return { ok: false, error: res.error ?? "paper_deploy_failed" };
    }
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function paperRunStrategyContract(input: {
  sessionId?: string;
  code?: string;
  dryRun?: boolean;
  limit?: number;
  workflowRunId?: string;
  projectId?: string;
  strategyVersionId?: string;
  name?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  data?: {
    sessionId: string;
    codeHash: string;
    paperCapital: number;
    dryRun: boolean;
    metrics: {
      totalReturnPct: number;
      maxDrawdownPct: number;
      sharpeApprox: number;
      tradeCount: number;
      bars: number;
    };
    tradeCount: number;
    orderDrafts: Array<Record<string, unknown>>;
    submittedCount?: number;
    note?: string;
  };
}> {
  try {
    const res = await httpPost<{
      ok: boolean;
      error?: string;
      data?: {
        sessionId: string;
        codeHash: string;
        paperCapital: number;
        dryRun: boolean;
        metrics: {
          totalReturnPct: number;
          maxDrawdownPct: number;
          sharpeApprox: number;
          tradeCount: number;
          bars: number;
        };
        tradeCount: number;
        orderDrafts: Array<Record<string, unknown>>;
        submittedCount?: number;
        note?: string;
      };
    }>("/api/v1/quant/strategy-contract/paper-run", {
      ...input,
      dryRun: input.dryRun ?? true,
    });
    if (!res.ok || !res.data) {
      return { ok: false, error: res.error ?? "paper_run_failed" };
    }
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
  noDataCount: number;
  dispatchTimeoutCount: number;
  transportErrorCount: number;
  effectiveDataSuccessRate: number;
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
  fallbackCount: number;
  nativeSuccessCount: number;
  failedCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  successRate: number;
  nativeSuccessRate: number;
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
    fallbackCount: number;
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
  status: "running" | "success" | "error" | "timeout" | "sandbox_blocked";
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
  status: "running" | "success" | "timeout" | "failed" | "sandbox_blocked";
  errorCode: string | null;
  latencyMs: number | null;
  retryCount: number;
  fallback: boolean;
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
  fallbackCount: number;
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
    fallbackCount: number;
    nativeSuccessCount: number;
    failedCount: number;
    timeoutCount: number;
    sandboxBlockedCount: number;
    successRate: number;
    nativeSuccessRate: number;
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
  /** true 时返回 `{ groups, unbound }` 结构（按 session 分组） */
  groupBySession?: boolean;
}): Promise<unknown[] | { groups: Array<Record<string, unknown>>; unbound: unknown[] }> {
  const query = new URLSearchParams();
  if (params.projectId) query.set("projectId", params.projectId);
  if (params.sessionId) query.set("sessionId", params.sessionId);
  if (params.status) query.set("status", params.status);
  if (params.mode) query.set("mode", params.mode);
  if (params.groupBySession) query.set("groupBySession", "true");
  const res = await httpGet<{
    data: unknown[] | { groups: Array<Record<string, unknown>>; unbound: unknown[] };
  }>(`/api/v1/monitor/workflows?${query.toString()}`);
  return res.data;
}

/** 将 listMonitorWorkflows 的 flat / grouped 响应统一为 workflow 行数组。 */
export function flattenMonitorWorkflowRows(
  data: unknown[] | { groups: Array<Record<string, unknown>>; unbound: unknown[] }
): unknown[] {
  if (Array.isArray(data)) return data;
  const grouped = data.groups.flatMap((group) =>
    Array.isArray(group.workflows) ? group.workflows : []
  );
  return [...grouped, ...(data.unbound ?? [])];
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

// ─── Agent Eval Platform API (/api/v1/agent-eval) ─────────────────────────────

export type AgentEvalScoreRecord = {
  id: string;
  name: string;
  dataType: string;
  value: {
    dataType: string;
    numeric?: number;
    categorical?: string;
    boolean?: boolean;
    text?: string;
  };
  source: string;
  comment?: string;
  workflowRunId: string;
  createdAt: string;
};

export type AgentEvalObservationTree = {
  workflowRunId: string;
  workflowStatus: string;
  sessionId: string | null;
  scenarioKey: string | null;
  root: {
    id: string;
    type: string;
    name: string;
    children?: Array<{ id: string; type: string; name: string; status?: string }>;
  };
};

export type AgentEvalDatasetItemRecord = {
  id: string;
  datasetId: string;
  caseKey: string;
  inputJson: Record<string, unknown>;
  expectedJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
  sourceWorkflowRunId: string | null;
  createdAt: string;
};

export type SessionEvalScoreRollup = {
  sessionId: string;
  workflowCount: number;
  workflows: Array<{
    workflowRunId: string;
    status: string;
    goal: string;
    scoreCount: number;
  }>;
  scores: Array<{
    name: string;
    count: number;
    avgNumeric: number | null;
    minNumeric: number | null;
    maxNumeric: number | null;
  }>;
};

export async function getWorkflowEvalScores(
  workflowRunId: string
): Promise<AgentEvalScoreRecord[]> {
  const res = await httpGet<{ ok: boolean; data: AgentEvalScoreRecord[] }>(
    `/api/v1/agent-eval/scores?workflowRunId=${encodeURIComponent(workflowRunId)}`
  );
  return res.data;
}

export async function getWorkflowEvalObservations(
  workflowRunId: string
): Promise<AgentEvalObservationTree> {
  const res = await httpGet<{ ok: boolean; data: AgentEvalObservationTree }>(
    `/api/v1/agent-eval/workflows/${encodeURIComponent(workflowRunId)}/observations`
  );
  return res.data;
}

export async function listWorkflowEvalAnnotations(
  workflowRunId: string
): Promise<AgentEvalScoreRecord[]> {
  const res = await httpGet<{ ok: boolean; data: AgentEvalScoreRecord[] }>(
    `/api/v1/agent-eval/workflows/${encodeURIComponent(workflowRunId)}/annotations`
  );
  return res.data;
}

export async function submitWorkflowEvalAnnotation(
  workflowRunId: string,
  input: {
    name?: string;
    dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";
    value: number | string | boolean;
    comment?: string;
    observationId?: string;
    actor?: string;
  }
): Promise<{ written: number; name: string }> {
  const res = await httpPost<{ ok: boolean; data: { written: number; name: string } }>(
    `/api/v1/agent-eval/workflows/${encodeURIComponent(workflowRunId)}/annotations`,
    input
  );
  return res.data;
}

export async function exportWorkflowGolden(
  workflowRunId: string,
  input: { datasetId: string; caseKey?: string; actor?: string }
): Promise<AgentEvalDatasetItemRecord> {
  const res = await httpPost<{ ok: boolean; data: AgentEvalDatasetItemRecord }>(
    `/api/v1/agent-eval/workflows/${encodeURIComponent(workflowRunId)}/export-golden`,
    input
  );
  return res.data;
}

export async function submitWorkflowEvalFeedback(
  workflowRunId: string,
  input: { helpful: boolean; comment?: string; actor?: string }
): Promise<{ written: number }> {
  const res = await httpPost<{ ok: boolean; data: { written: number } }>(
    `/api/v1/agent-eval/workflows/${encodeURIComponent(workflowRunId)}/feedback`,
    input
  );
  return res.data;
}

export async function submitChatMessageFeedback(
  chatMessageId: string,
  input: { helpful: boolean; comment?: string; actor?: string }
): Promise<{ written: number; workflowRunId: string; chatMessageId: string }> {
  const res = await httpPost<{
    ok: boolean;
    data: { written: number; workflowRunId: string; chatMessageId: string };
  }>(`/api/v1/agent-eval/chat-messages/${encodeURIComponent(chatMessageId)}/feedback`, input);
  return res.data;
}

export async function getSessionEvalScores(sessionId: string): Promise<SessionEvalScoreRollup> {
  const res = await httpGet<{ ok: boolean; data: SessionEvalScoreRollup }>(
    `/api/v1/agent-eval/sessions/${encodeURIComponent(sessionId)}/scores`
  );
  return res.data;
}

export type ScoreDailyRollupRow = {
  day: string;
  name: string;
  count: number;
  avgNumeric: number | null;
  minNumeric: number | null;
  maxNumeric: number | null;
};

export type ScoreCompareResult = {
  name: string;
  recentAvg: number | null;
  baselineAvg: number | null;
  deltaPct: number | null;
  recentCount: number;
  baselineCount: number;
};

export type AgentEvalExperimentResult = {
  runId: string;
  baselineRunId: string | null;
  cases: Array<{
    caseKey: string;
    datasetItemId: string;
    workflowRunId: string | null;
    score: number;
    pass: boolean;
    error?: string;
  }>;
  summary: {
    caseCount: number;
    passCount: number;
    passRate: number;
    avgScore: number;
  };
};

export type AgentEvalExperimentDiff = {
  baselineRunId: string;
  challengerRunId: string;
  rows: Array<{
    caseKey: string;
    baselineScore: number | null;
    challengerScore: number | null;
    delta: number | null;
  }>;
  summary: { improved: number; regressed: number; unchanged: number };
};

export async function getAgentEvalScoreDailyAnalytics(input?: {
  names?: string[];
  since?: string;
  until?: string;
}): Promise<ScoreDailyRollupRow[]> {
  const query = new URLSearchParams();
  if (input?.names?.length) query.set("names", input.names.join(","));
  if (input?.since) query.set("since", input.since);
  if (input?.until) query.set("until", input.until);
  const suffix = query.toString();
  const res = await httpGet<{ ok: boolean; data: ScoreDailyRollupRow[] }>(
    `/api/v1/agent-eval/scores/analytics/daily${suffix ? `?${suffix}` : ""}`
  );
  return res.data;
}

export async function compareAgentEvalScores(
  name: string,
  recentDays = 7
): Promise<ScoreCompareResult> {
  const res = await httpGet<{ ok: boolean; data: ScoreCompareResult }>(
    `/api/v1/agent-eval/scores/analytics/compare?name=${encodeURIComponent(name)}&recentDays=${recentDays}`
  );
  return res.data;
}

export async function listAgentEvalDatasetItems(
  datasetId: string
): Promise<AgentEvalDatasetItemRecord[]> {
  const res = await httpGet<{ ok: boolean; data: AgentEvalDatasetItemRecord[] }>(
    `/api/v1/agent-eval/datasets/${encodeURIComponent(datasetId)}/items`
  );
  return res.data;
}

export async function runAgentEvalExperiment(input: {
  datasetId: string;
  experimentLabel: string;
  configFingerprint: string;
  projectId: string;
  baselineRunId?: string;
  mode?: "replay" | "launch";
  waitTimeoutMs?: number;
}): Promise<AgentEvalExperimentResult> {
  const res = await httpPost<{ ok: boolean; data: AgentEvalExperimentResult }>(
    "/api/v1/agent-eval/experiments/run",
    input
  );
  return res.data;
}

export async function diffAgentEvalExperiment(
  baselineRunId: string,
  challengerRunId: string
): Promise<AgentEvalExperimentDiff> {
  const res = await httpGet<{ ok: boolean; data: AgentEvalExperimentDiff }>(
    `/api/v1/agent-eval/experiments/diff?baselineRunId=${encodeURIComponent(baselineRunId)}&challengerRunId=${encodeURIComponent(challengerRunId)}`
  );
  return res.data;
}

// ─── 研究拓扑只读查询 ─────────────────────────────────────────────────────

export async function getResearchWorkflowGraph(
  workflowRunId: string
): Promise<AnalystTeamGraphPayload | null> {
  const res = await httpGet<{ ok: boolean; data?: AnalystTeamGraphPayload; error?: string }>(
    `/api/v1/research-artifacts/workflow/${encodeURIComponent(workflowRunId)}/team-graph`
  );
  if (!(res as { ok?: boolean }).ok) return null;
  return (res as { data?: AnalystTeamGraphPayload }).data ?? null;
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
  provider?: BrokerProvider;
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
    provider?: BrokerProvider;
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
      provider?: BrokerProvider;
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

export async function listBrokerAccounts(
  provider?: BrokerProvider
): Promise<BrokerAccountRecord[]> {
  const suffix = provider ? `?provider=${provider}` : "";
  const res = await httpGet<{ ok: boolean; data: BrokerAccountRecord[] }>(
    `/api/v1/reia/broker/accounts${suffix}`
  );
  return res.data;
}

export async function upsertBrokerAccount(input: {
  provider: BrokerProvider;
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
  provider: BrokerProvider;
  accountRef: string;
}): Promise<{
  provider: BrokerProvider;
  status: "healthy" | "degraded" | "down";
  message: string;
  checkedAt: string;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      provider: BrokerProvider;
      status: "healthy" | "degraded" | "down";
      message: string;
      checkedAt: string;
    };
  }>("/api/v1/reia/broker/health-check", input);
  return res.data;
}

/** Start local Futu trade HTTP + quote WS bridges from configured OpenD account. */
export async function ensureFutuMarketBridges(): Promise<{
  configured: boolean;
  message: string;
  trade: { healthy: boolean; url: string; running: boolean };
  quote: { running: boolean; url: string };
  marketWsUrl: string | null;
}> {
  const res = await httpPost<{
    ok: boolean;
    data: {
      configured: boolean;
      message: string;
      trade: { healthy: boolean; url: string; running: boolean };
      quote: { running: boolean; url: string };
      marketWsUrl: string | null;
    };
  }>("/api/v1/market/stream/bridges/futu/ensure", {});
  return res.data;
}

export async function listBrokerEvents(
  provider?: BrokerProvider,
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

/**
 * Session 级统一 ClientEvent SSE（06 协议）。
 * 对话页优先订此流；研究团队页可继续用 subscribeWorkflowEvents。
 */
export function subscribeSessionEvents(params: {
  sessionId: string;
  onEvent: (event: import("./types").ClientEvent) => void;
  onError?: (err: Event) => void;
}): () => void {
  const url = backendFetchUrl(
    `/api/v1/chat/sessions/${encodeURIComponent(params.sessionId)}/events`
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
            params.onEvent(JSON.parse(parsed.data) as import("./types").ClientEvent);
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

/** Plugins 管理（轨 A） */
export type PluginListTab = "featured" | "installed" | "catalog" | "all";

export interface PluginListItemDto {
  id: string;
  name: string;
  version?: string;
  description: string;
  category: string;
  visibility: string;
  kind: "mcp" | "skill" | "builtin_pack" | "connector";
  ref: Record<string, unknown>;
  safetyLevel: string;
  auth?: { type?: string; scopes?: string[] };
  origin?: { format?: string; sourcePath?: string; note?: string };
  installed: boolean;
  installKey?: string;
  installStatus?: string;
  installedAt?: string;
  warnings?: string[];
  oauthConnected?: boolean;
  oauthStatus?: string;
  oauthExpiresAt?: string | null;
  oauthError?: string | null;
  oauthMcpServerName?: string | null;
}

export async function listPlugins(input?: {
  projectId?: string;
  q?: string;
  tab?: PluginListTab;
  page?: number;
  pageSize?: number;
}): Promise<{ items: PluginListItemDto[]; total: number; page: number; pageSize: number }> {
  const qs = new URLSearchParams();
  if (input?.projectId) qs.set("projectId", input.projectId);
  if (input?.q) qs.set("q", input.q);
  if (input?.tab) qs.set("tab", input.tab);
  if (input?.page) qs.set("page", String(input.page));
  if (input?.pageSize) qs.set("pageSize", String(input.pageSize));
  const suffix = qs.toString();
  const res = await httpGet<{
    data: { items: PluginListItemDto[]; total: number; page: number; pageSize: number };
  }>(`/api/v1/agents/plugins${suffix ? `?${suffix}` : ""}`);
  return res.data;
}

export async function listInstalledPlugins(projectId: string): Promise<PluginListItemDto[]> {
  const res = await httpGet<{ data: PluginListItemDto[] }>(
    `/api/v1/agents/plugins/installed?projectId=${encodeURIComponent(projectId)}`
  );
  return res.data;
}

export async function installPlugin(input: {
  projectId: string;
  targetId: string;
  kind?: "mcp" | "skill" | "builtin_pack" | "connector";
  serverName?: string;
}): Promise<{ item: PluginListItemDto; warnings: string[] }> {
  const res = await httpPost<{ data: PluginListItemDto; warnings?: string[] }>(
    "/api/v1/agents/plugins/install",
    input
  );
  return { item: res.data, warnings: res.warnings ?? [] };
}

export async function uninstallPlugin(input: {
  projectId: string;
  installKey: string;
}): Promise<void> {
  await httpDelete(
    `/api/v1/agents/plugins/installs/${encodeURIComponent(input.installKey)}?projectId=${encodeURIComponent(input.projectId)}`
  );
}

export async function importPluginPackage(input: {
  projectId: string;
  format: "codex_plugin" | "claude_plugin" | "agent_skills";
  rootPath: string;
}): Promise<{
  manifest: PluginListItemDto;
  skillInstallIds: string[];
  mcpServerNames: string[];
  warnings: string[];
}> {
  const res = await httpPost<{
    data: {
      ok: true;
      manifest: PluginListItemDto;
      skillInstallIds: string[];
      mcpServerNames: string[];
      warnings: string[];
    };
  }>("/api/v1/agents/plugins/import", input);
  return res.data;
}

/** Harness 声明式能力包：服务端只接受已签名的 JSON Manifest/Profile。 */
export interface HarnessPackageLockRecordDto {
  packageId: string;
  version: string;
  digest: string;
  keyId: string;
  installedAt: string;
}

export interface HarnessPackageVersionDto {
  packageId: string;
  version: string;
  digest: string;
  keyId: string;
  current: boolean;
}

export interface HarnessPackageProfileDto {
  id: string;
  title: string;
  description: string;
  /** 系统随 Host 发布；package 则来自已验证的外部能力包。 */
  source?: "system" | "package";
  packageId: string;
  packageVersion: string;
  resolverAllowlisted: boolean;
  parameters: Array<{
    id: string;
    type: "string" | "number" | "boolean" | "enum";
    title: string;
    description?: string;
    default?: string | number | boolean;
    values?: string[];
  }>;
}

export interface HarnessProfileActivationDto {
  schemaVersion: 1;
  profileIds: string[];
  parameterOverrides: Record<string, Record<string, string | number | boolean>>;
  revision: number;
  updatedAt: string | null;
}

export interface HarnessProfileHealthDto {
  profileId: string;
  state: "closed" | "open";
  failuresInWindow: number;
  openedAt: string | null;
  retryAt: string | null;
  lastError: string | null;
}

export interface HarnessHealthDto {
  profiles: HarnessProfileHealthDto[];
  recentDegradations: number;
  fallbackPolicy: string;
}

export interface HarnessPackageProfilesDto {
  activeProfileIds: string[];
  activation: HarnessProfileActivationDto;
  available: HarnessPackageProfileDto[];
  rejected: Array<{ packageId: string; reason: string }>;
}

export interface HarnessProfileActivationHistoryDto {
  revision: number;
  changedAt: string;
  source: "api" | "package-uninstall";
  previousProfileIds: string[];
  profileIds: string[];
  changedParameterProfiles: string[];
}

export interface HarnessTrustDto {
  trustedKeyIds: string[];
  revokedKeyIds: string[];
  keyRotationSupported: boolean;
}

export interface HarnessMarketplaceItemDto {
  id: string;
  version: string;
  title: string;
  description: string;
  verification: { ok: boolean; keyId?: string; code?: string; message?: string };
}

export interface HarnessRecentEventDto {
  id: string;
  eventType: string;
  workflowRunId: string;
  profileId: string | null;
  capabilityId: string | null;
  toolCallId: string | null;
  status: string | null;
  createdAt: string;
}

export interface HarnessRecentEventsDto {
  summary: {
    composed: number;
    degraded: number;
    admitted: number;
    rejected: number;
    started: number;
    completed: number;
    artifacts: number;
    completedByStatus: Record<string, number>;
  };
  events: HarnessRecentEventDto[];
}

export async function listHarnessPackages(): Promise<HarnessPackageLockRecordDto[]> {
  const res = await httpGet<{ data: HarnessPackageLockRecordDto[] }>("/api/v1/harness/packages");
  return res.data;
}

export async function listHarnessPackageVersions(
  packageId: string
): Promise<HarnessPackageVersionDto[]> {
  const res = await httpGet<{ data: HarnessPackageVersionDto[] }>(
    `/api/v1/harness/packages/${encodeURIComponent(packageId)}/versions`
  );
  return res.data;
}

export async function rollbackHarnessPackage(
  packageId: string,
  version: string
): Promise<HarnessPackageLockRecordDto> {
  const res = await httpPost<{ data: HarnessPackageLockRecordDto }>(
    `/api/v1/harness/packages/${encodeURIComponent(packageId)}/rollback`,
    { version }
  );
  return res.data;
}

export async function uninstallHarnessPackage(
  packageId: string
): Promise<HarnessPackageLockRecordDto> {
  const res = await httpDelete<{ data: HarnessPackageLockRecordDto }>(
    `/api/v1/harness/packages/${encodeURIComponent(packageId)}`
  );
  return res.data;
}

export async function getHarnessPackageProfiles(): Promise<HarnessPackageProfilesDto> {
  const res = await httpGet<{ data: HarnessPackageProfilesDto }>("/api/v1/harness/profiles");
  return res.data;
}

export async function setActiveHarnessPackageProfiles(input: {
  profileIds: string[];
  parameterOverrides?: Record<string, Record<string, string | number | boolean>>;
}): Promise<HarnessProfileActivationDto> {
  const res = await httpPut<{
    data: { activeProfileIds: string[]; activation: HarnessProfileActivationDto };
  }>("/api/v1/harness/profiles", input);
  return res.data.activation;
}

export async function getHarnessProfileActivationHistory(): Promise<
  HarnessProfileActivationHistoryDto[]
> {
  const res = await httpGet<{ data: HarnessProfileActivationHistoryDto[] }>(
    "/api/v1/harness/profiles/history"
  );
  return res.data;
}

export async function getHarnessTrust(): Promise<HarnessTrustDto> {
  const res = await httpGet<{ data: HarnessTrustDto }>("/api/v1/harness/trust");
  return res.data;
}

export async function listHarnessMarketplace(): Promise<HarnessMarketplaceItemDto[]> {
  const res = await httpGet<{ data: HarnessMarketplaceItemDto[] }>("/api/v1/harness/marketplace");
  return res.data;
}

export async function getHarnessHealth(): Promise<HarnessHealthDto> {
  const res = await httpGet<{ data: HarnessHealthDto }>("/api/v1/harness/health");
  return res.data;
}

export async function exportHarnessPackageProfiles(): Promise<
  HarnessProfileActivationDto & { exportedAt: string }
> {
  const res = await httpGet<{ data: HarnessProfileActivationDto & { exportedAt: string } }>(
    "/api/v1/harness/profiles/export"
  );
  return res.data;
}

export async function importHarnessPackageProfiles(
  activation: Record<string, unknown>
): Promise<HarnessProfileActivationDto> {
  const res = await httpPost<{
    data: { activeProfileIds: string[]; activation: HarnessProfileActivationDto };
  }>("/api/v1/harness/profiles/import", { activation });
  return res.data.activation;
}

export async function getRecentHarnessEvents(limit = 12): Promise<HarnessRecentEventsDto> {
  const res = await httpGet<{ data: HarnessRecentEventsDto }>(
    `/api/v1/harness/events/recent?limit=${encodeURIComponent(String(limit))}`
  );
  return res.data;
}

export async function verifyHarnessPackageManifest(packageData: Record<string, unknown>): Promise<{
  ok: boolean;
  digest?: string;
  keyId?: string;
  code?: string;
  message?: string;
}> {
  const res = await httpPost<{
    data: { ok: boolean; digest?: string; keyId?: string; code?: string; message?: string };
  }>("/api/v1/harness/packages/verify", { package: packageData });
  return res.data;
}

export async function installHarnessPackageManifest(
  packageData: Record<string, unknown>
): Promise<HarnessPackageLockRecordDto> {
  const res = await httpPost<{ data: HarnessPackageLockRecordDto }>(
    "/api/v1/harness/packages/install",
    { package: packageData }
  );
  return res.data;
}

/** P2 OAuth connectors */
export interface ConnectorAuthPublicDto {
  id: string;
  projectId: string;
  pluginId: string;
  provider: string;
  displayName: string;
  status: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  mcpServerName: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  hasClientSecret: boolean;
  connected: boolean;
  updatedAt: string;
}

export async function listConnectorAuthStatus(
  projectId: string
): Promise<ConnectorAuthPublicDto[]> {
  const res = await httpGet<{ data: ConnectorAuthPublicDto[] }>(
    `/api/v1/plugins/oauth/status?projectId=${encodeURIComponent(projectId)}`
  );
  return res.data;
}

export async function upsertOauthConnection(input: {
  projectId: string;
  pluginId: string;
  clientId: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  redirectUri?: string;
  mcpServerName?: string | null;
  displayName?: string;
}): Promise<ConnectorAuthPublicDto> {
  const res = await httpPost<{ data: ConnectorAuthPublicDto }>(
    "/api/v1/plugins/oauth/connections",
    input
  );
  return res.data;
}

export async function beginOauthAuthorize(input: {
  projectId: string;
  pluginId: string;
}): Promise<{ authorizeUrl: string; state: string }> {
  const qs = new URLSearchParams({
    projectId: input.projectId,
    pluginId: input.pluginId,
  });
  const res = await httpGet<{ data: { authorizeUrl: string; state: string } }>(
    `/api/v1/plugins/oauth/authorize?${qs.toString()}`
  );
  return res.data;
}

export async function disconnectOauthConnection(input: {
  projectId: string;
  pluginId: string;
}): Promise<ConnectorAuthPublicDto> {
  const res = await httpDelete<{ data: ConnectorAuthPublicDto }>(
    `/api/v1/plugins/oauth/connections/${encodeURIComponent(input.pluginId)}?projectId=${encodeURIComponent(input.projectId)}`
  );
  return res.data;
}

export async function getOauthPreset(pluginId: string): Promise<{
  pluginId: string;
  provider: string;
  displayName: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  defaultRedirectUri: string;
}> {
  const res = await httpGet<{
    data: {
      pluginId: string;
      provider: string;
      displayName: string;
      authorizeUrl?: string;
      tokenUrl?: string;
      scopes?: string;
      defaultRedirectUri: string;
    };
  }>(`/api/v1/plugins/oauth/presets/${encodeURIComponent(pluginId)}`);
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

export type TradingModuleStatus = {
  enabled: boolean;
  changedAt: string;
  stoppedRuntimeIds?: string[];
};

export async function getTradingModuleStatus(): Promise<TradingModuleStatus> {
  const res = await httpGet<{ ok: boolean; data: TradingModuleStatus }>("/api/v1/trader/module");
  return res.data;
}

export async function setTradingModuleStatus(enabled: boolean): Promise<TradingModuleStatus> {
  const res = await httpPut<{ ok: boolean; data: TradingModuleStatus }>("/api/v1/trader/module", {
    enabled,
  });
  return res.data;
}

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
  executionMode?: "paper" | "live" | "sim";
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
  entryLimitPrice?: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  timeframe?: string;
  executionMode?: "paper" | "live" | "sim";
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
  provider: BrokerProvider;
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
  provider: BrokerProvider;
  accountRef?: string;
}): Promise<PositionReconciliationReport> {
  const query = new URLSearchParams({ projectId: input.projectId, provider: input.provider });
  if (input.accountRef) query.set("accountRef", input.accountRef);
  const res = await httpGet<{ ok: boolean; data: PositionReconciliationReport }>(
    `/api/v1/execution/reconciliation/positions?${query.toString()}`
  );
  return res.data;
}

export async function scanPositionReconciliation(input: {
  projectId: string;
  provider: BrokerProvider;
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
  provider: BrokerProvider;
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
    }
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

/** Execution engine's authoritative order-intent lifecycle, for the Trading screen. */
export type ExecutionIntentSummary = {
  id: string;
  workflowRunId: string;
  side: "buy" | "sell";
  qty: number;
  orderType: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  price: number | null;
  stopPrice: number | null;
  timeInForce: "day" | "gtc" | "ioc" | "fok";
  market: string | null;
  symbol: string | null;
  strategyRuntimeId: string | null;
  activationStatus: "active" | "held" | "waiting_trigger" | "triggered";
  lifecycleStatus: string;
  intentTime: string;
  lifecycleUpdatedAt: string;
};

export async function listExecutionIntents(input: {
  workflowRunId?: string;
  status?: string;
  limit?: number;
}): Promise<ExecutionIntentSummary[]> {
  const q = new URLSearchParams();
  if (input.workflowRunId) q.set("workflowRunId", input.workflowRunId);
  if (input.status) q.set("status", input.status);
  if (input.limit) q.set("limit", String(input.limit));
  const res = await httpGet<{ ok: boolean; data: ExecutionIntentSummary[] }>(
    `/api/v1/execution/intents${q.size ? `?${q.toString()}` : ""}`
  );
  return res.data;
}

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
  executionMode?: "paper" | "live" | "sim";
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
  executionMode: "paper" | "live" | "sim";
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
  executionMode?: "paper" | "live" | "sim";
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

/** Push news into sim trading loop: tick strategy_runtime (+ optional Agent wake). */
export async function ingestSimTradingNews(input: {
  symbols: string[];
  headline: string;
  source?: string;
  wakeAgent?: boolean;
  projectId?: string;
  sessionId?: string;
}): Promise<{ runtimeMatches: number; agentTriggered: boolean }> {
  const res = await httpPost<{
    ok: boolean;
    data: { runtimeMatches: number; agentTriggered: boolean };
    error?: string;
  }>("/api/v1/trading/events/news", input);
  if (!res.ok) throw new Error(res.error ?? "ingest_sim_news_failed");
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

export interface BacktestInstrumentSpecDto {
  assetClass: "stock" | "future" | "option" | "crypto";
  contractKind?: "spot" | "perpetual";
  contractMultiplier?: number;
  lotSize?: number;
  initialMarginRate?: number;
  maintenanceMarginRate?: number;
  targetLeverage?: number;
  expiryDate?: string;
  settlementMode?: "cash" | "physical";
  underlyingSymbol?: string;
  strike?: number;
  optionRight?: "call" | "put";
  exerciseStyle?: "european" | "american";
  pricingModel?: "black_scholes";
  futureRoll?: {
    rollDate: string;
    successorSymbol: string;
  };
}

export interface BacktestRequestDto {
  strategyVersionId?: string;
  dataset: {
    snapshotId: string;
    dataRef: string;
    asOf: string;
    timeframe: string;
    sourceIds: string[];
    tradingCalendar?: {
      version?: string;
      timezone?: string;
      sessionsBySymbol?: Record<string, Record<string, "open" | "closed">>;
      sessionWindowsBySymbol?: Record<
        string,
        Record<string, Array<{ openAt: string; closeAt: string; label?: string }>>
      >;
    };
    corporateActionEvents?: Array<{
      symbol: string;
      effectiveDate: string;
      knownAt: string;
      cashAmount?: number;
      kind:
        | "cash_dividend"
        | "stock_dividend"
        | "split"
        | "merger"
        | "spinoff"
        | "delisting"
        | "symbol_change"
        | "other";
    }>;
    fundamentalObservations?: Array<{
      symbol: string;
      metric: string;
      fiscalPeriodEnd: string;
      availableAt: string;
      value: number;
      revisionId?: string;
    }>;
    qualification: {
      useClass: "research_only" | "strategy_validation";
      universeHistory: "verified" | "not_verified";
      corporateActions: "verified" | "raw_unadjusted" | "not_verified";
      pointInTime: "verified" | "not_verified";
      limitations: string[];
      universeHistoryRef?: { universeId: string; version: string; source: string; asOf: string };
      corporateActionLedgerRef?: { version: string; source: string; asOf: string };
      fundamentalLedgerRef?: { version: string; source: string; asOf: string };
    };
    barsBySymbol: Record<
      string,
      Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        turnover: number;
        settlementPrice?: number;
        fundingRateBps?: number;
        impliedVolatility?: number;
        riskFreeRateAnnual?: number;
        tradable?: boolean;
        suspended?: boolean;
        priceLimitUp?: number;
        priceLimitDown?: number;
      }>
    >;
  };
  signals: BacktestSignalSpec;
  universe: string;
  symbols: string[];
  instruments?: Record<string, BacktestInstrumentSpecDto>;
  startDate: string;
  endDate: string;
  capital: number;
  costs: {
    commissionBps: number;
    slippageBps: number;
    minCommission?: number;
    slippageModel?: "fixed_bps" | "square_root" | "volatility_adjusted";
    impactCoefficient?: number;
    maxVolumeParticipation?: number;
    borrowRateAnnualBps?: number;
    restrictedShortSymbols?: string[];
  };
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  experiment?: {
    parameterSelection: "fixed_before_run" | "full_sample_optimized" | "unknown";
    preRegistrationId?: string;
    candidateTrials?: number;
  };
}

export interface BacktestMetricsDto {
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
  meta: {
    latencyMs: number;
    sampleSize: number;
    barCount: number;
    skippedDays: number;
    datasetQualification?: {
      useClass: "research_only" | "strategy_validation";
      universeHistory: "verified" | "not_verified";
      corporateActions: "verified" | "raw_unadjusted" | "not_verified";
      pointInTime: "verified" | "not_verified";
      limitations: string[];
    };
    antiLeakageReport?: BacktestIntegrityReportDto;
    statisticalValidationReport?: BacktestStatisticalValidationReportDto;
    assetLifecycleReport?: {
      version: "asset-lifecycle-v2";
      status: "passed" | "research_only" | "invalid";
      assetClasses: string[];
      checks: Array<{
        symbol: string;
        state: "pass" | "warning" | "fail";
        code: string;
        message: string;
      }>;
      limitations: string[];
    };
    assetLifecycleEvents?: Array<{
      date: string;
      symbol: string;
      kind:
        | "futures_variation_margin"
        | "futures_roll"
        | "futures_margin_call"
        | "futures_forced_liquidation"
        | "expiry_settlement"
        | "perpetual_funding"
        | "option_greeks_snapshot"
        | "order_unfilled_tradability";
      amount: number;
      detail: string;
      optionRisk?: {
        underlyingPrice: number;
        impliedVolatility: number;
        riskFreeRateAnnual: number;
        timeToExpiryYears: number;
        delta: number;
        gamma: number;
        thetaPerDay: number;
        vegaPerPoint: number;
      };
    }>;
  };
  error?: string;
}

export interface StrategyGateCheckDto {
  key:
    | "sample_size"
    | "net_sharpe"
    | "sortino"
    | "calmar"
    | "max_drawdown"
    | "cvar95"
    | "positive_period_rate"
    | "turnover"
    | "annual_return"
    | "research_integrity"
    | "statistical_confidence";
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
    embargoDays: number;
    purgeStart: string | null;
    purgeEnd: string | null;
    embargoStart: string | null;
    embargoEnd: string | null;
    metrics: BacktestMetricsDto;
    sampleSize: number;
    regime: string;
    regimeSource: "market_benchmark" | "benchmark_equity" | "strategy_equity";
    selection?: {
      mode: "train_only_grid";
      objective: "sharpe" | "calmar" | "annual_return";
      candidateCount: number;
      selected: { topN?: number; rebalance?: "daily" | "weekly" | "monthly"; longShort?: boolean };
      trainMetrics: BacktestMetricsDto;
      falseDiscoveryRate: {
        method: "benjamini_hochberg";
        alpha: number;
        hypothesisCount: number;
        discoveryCount: number;
        hypotheses: Array<{
          id: string;
          pValue: number | null;
          adjustedPValue: number | null;
          pass: boolean;
        }>;
      };
      realityCheck: {
        version: "white-reality-check-v1";
        status: "passed" | "research_only";
        benchmark: "backtest_benchmark" | "cash_zero_return";
        candidateCount: number;
        sampleSize: number;
        simulations: number;
        blockSize: number;
        seed: number;
        bestCandidateId: string | null;
        observedMaxMeanReturn: number | null;
        observedStatistic: number | null;
        pValue: number | null;
        checks: Array<{
          key: "candidate_family" | "minimum_sample" | "data_snooping_adjusted_superiority";
          state: "pass" | "fail" | "unknown";
          evidence: string;
        }>;
      };
      selectedFdrPass: boolean;
      leaderboard: Array<{
        candidate: {
          topN?: number;
          rebalance?: "daily" | "weekly" | "monthly";
          longShort?: boolean;
        };
        score: number;
        metrics: BacktestMetricsDto;
        pValue: number | null;
        adjustedPValue: number | null;
        fdrPass: boolean;
      }>;
    };
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
  performancePass: boolean;
  selectionIntegrityPass: boolean;
  integrityReport: BacktestIntegrityReportDto;
  statisticalValidationReport: BacktestStatisticalValidationReportDto;
  pass: boolean;
}

export interface BacktestIntegrityReportDto {
  version: "anti-leakage-v1" | "anti-leakage-v2";
  status: "passed" | "research_only" | "rejected";
  inputFingerprint: string;
  datasetSnapshotId: string;
  checks: Array<{
    key: string;
    state: "pass" | "fail" | "unknown" | "not_applicable";
    evidence: string;
    requiredForValidation: boolean;
  }>;
  failedChecks: string[];
  unknownChecks: string[];
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
  datasetSnapshotId?: string;
  compositionId?: string;
  signals?: BacktestSignalSpec;
  symbols: string[];
  instruments?: Record<string, BacktestInstrumentSpecDto>;
  universe?: string;
  startDate: string;
  endDate: string;
  capital?: number;
  costs?: {
    commissionBps: number;
    slippageBps: number;
    minCommission?: number;
    slippageModel?: "fixed_bps" | "square_root" | "volatility_adjusted";
    impactCoefficient?: number;
    maxVolumeParticipation?: number;
    borrowRateAnnualBps?: number;
    restrictedShortSymbols?: string[];
  };
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  providerKey?: string;
  experiment?: {
    parameterSelection: "fixed_before_run" | "full_sample_optimized" | "unknown";
    preRegistrationId?: string;
    candidateTrials?: number;
  };
}

export interface BacktestStatisticalValidationReportDto {
  version: "statistical-validation-v1" | "statistical-validation-v2" | "statistical-validation-v3";
  status: "passed" | "research_only";
  sampleSize: number;
  candidateTrials: number | null;
  familyWiseAlpha: number;
  adjustedAlpha: number | null;
  simulations: number;
  blockSize: number;
  seed: number;
  observedSharpe: number;
  sharpeConfidenceInterval: { lower: number; upper: number } | null;
  probabilitySharpePositive: number | null;
  rawSharpePValue?: number | null;
  bonferroniAdjustedPValue?: number | null;
  deflatedSharpe?: {
    probability: number;
    observedAnnualizedSharpe: number;
    benchmarkAnnualizedSharpe: number;
    trialMeanAnnualizedSharpe: number;
    trialStdAnnualizedSharpe: number;
    skewness: number;
    kurtosis: number;
    independentTrialCount: number;
    trialDistributionCount: number;
    assumptions: [
      "candidate_trials_treated_as_independent",
      "psr_moment_approximation_uses_iid_returns",
    ];
  } | null;
  checks: Array<{
    key:
      | "minimum_sample"
      | "trial_count_declared"
      | "sharpe_confidence"
      | "multiple_testing"
      | "deflated_sharpe";
    state: "pass" | "fail" | "unknown";
    evidence: string;
  }>;
}

export interface MarketSnapshotDto {
  snapshotId: string;
  asOf: string;
  dataRef: string;
  barCounts: Record<string, number>;
}

/** 冻结 UI 回测的市场输入，供后续 backtest job 绑定。 */
export async function createMarketSnapshot(body: {
  symbols: string[];
  exchange?: string;
  asOf?: string;
  timeframe?: string;
  limit?: number;
  purpose?: "research" | "backtest";
}): Promise<MarketSnapshotDto> {
  const res = await httpPost<{ ok: boolean; data: MarketSnapshotDto }>(
    "/api/v1/market/snapshots",
    body
  );
  return res.data;
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
  if (filter?.workflowRunId) qs.push(`workflow_run_id=${encodeURIComponent(filter.workflowRunId)}`);
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

export interface SensitivityAnalysisDto {
  backtestJobId: string;
  useClass: "research_only";
  parameterSelection: "full_sample_optimized";
  integrityWarning: string;
  xDimension: {
    key: string;
    label: string;
    values: Array<number | string>;
  };
  yDimension: {
    key: string;
    label: string;
    values: Array<number | string>;
  };
  grid: Array<
    Array<{
      xIndex: number;
      yIndex: number;
      xValue: number | string;
      yValue: number | string;
      sharpe: number;
      maxDrawdown: number;
      annualReturn: number;
      totalReturn: number;
      calmar: number;
      turnover: number;
      compositeScore: number;
    }>
  >;
  optimal: {
    xValue: number | string;
    yValue: number | string;
    metrics: {
      sharpe: number;
      maxDrawdown: number;
      annualReturn: number;
      calmar: number;
    };
  };
  stabilityScore: number;
  parameterCliffDetected: boolean;
  meta: {
    totalEvaluations: number;
    latencyMs: number;
  };
}

export interface MonteCarloSimulationDto {
  backtestJobId: string;
  simulationCount: number;
  initialCapital: number;
  metrics: {
    totalReturnPercentiles: { p5: number; p25: number; median: number; p75: number; p95: number };
    maxDrawdownPercentiles: { p5: number; p25: number; median: number; p75: number; p95: number };
    cagrPercentiles: { p5: number; p25: number; median: number; p75: number; p95: number };
    sharpePercentiles: { p5: number; p25: number; median: number; p75: number; p95: number };
  };
  probabilityOfRuin: number;
  stressScore: number;
  drawdownRiskRating: "low" | "moderate" | "high" | "critical";
  simulatedPathsSummary: Array<{
    date: string;
    p5Worst: number;
    median: number;
    p95Best: number;
  }>;
  meta: {
    sampleDays: number;
    seed: number;
    latencyMs: number;
  };
}

export interface PitAuditReportDto {
  pass: boolean;
  verdict: "point_in_time_clean" | "point_in_time_degraded" | "point_in_time_violated";
  lookAheadRiskScore: number;
  totalBarsAudited: number;
  symbolCount: number;
  anomalyCount: number;
  violations: Array<{
    symbol: string;
    type: string;
    timestamp: string;
    detail: string;
    severity: "critical" | "warning";
  }>;
  coverageRange: {
    start: string;
    end: string;
  };
  asOfBoundary: string;
  recommendations: string[];
}

export async function runWalkForwardEvaluation(
  backtestRunId: string,
  body: {
    folds?: number;
    purgeDays?: number;
    embargoDays?: number;
    selection?: {
      objective?: "sharpe" | "calmar" | "annual_return";
      candidates: Array<{
        topN?: number;
        rebalance?: "daily" | "weekly" | "monthly";
        longShort?: boolean;
      }>;
    };
  } = {}
): Promise<WalkForwardEvaluationDto> {
  const res = await httpPost<{ ok: boolean; data: WalkForwardEvaluationDto }>(
    `/api/v1/backtest-jobs/${encodeURIComponent(backtestRunId)}/walk-forward`,
    body
  );
  return res.data;
}

export async function runSensitivityAnalysis(
  jobId: string,
  body: {
    xParam?: { key: string; values: Array<number | string> };
    yParam?: { key: string; values: Array<number | string> };
  } = {}
): Promise<SensitivityAnalysisDto> {
  const res = await httpPost<{ ok: boolean; data: SensitivityAnalysisDto }>(
    `/api/v1/backtest-jobs/${encodeURIComponent(jobId)}/sensitivity`,
    body
  );
  return res.data;
}

export async function runMonteCarloSimulation(
  jobId: string,
  body: {
    simulations?: number;
    blockSize?: number;
    ruinThresholdRatio?: number;
    seed?: number;
  } = {}
): Promise<MonteCarloSimulationDto> {
  const res = await httpPost<{ ok: boolean; data: MonteCarloSimulationDto }>(
    `/api/v1/backtest-jobs/${encodeURIComponent(jobId)}/monte-carlo`,
    body
  );
  return res.data;
}

export async function runPitAudit(jobId: string): Promise<PitAuditReportDto> {
  const res = await httpPost<{ ok: boolean; data: PitAuditReportDto }>(
    `/api/v1/backtest-jobs/${encodeURIComponent(jobId)}/pit-audit`,
    {}
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
