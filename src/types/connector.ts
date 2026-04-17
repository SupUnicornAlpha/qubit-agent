import type { AssetClass, ConnectorType, LatencyProfile } from "./entities";

// ─── Connector Meta ──────────────────────────────────────────────────────────

export interface ConnectorMeta {
  name: string;
  version: string;
  connectorType: ConnectorType;
  capabilities: string[];
  assetClasses: AssetClass[];
  latencyProfile: LatencyProfile;
  description?: string;
}

// ─── Connector Health ─────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  latencyMs: number;
  message?: string;
  checkedAt: string;
}

// ─── Connector Config ─────────────────────────────────────────────────────────

export type ConnectorConfig = Record<string, unknown>;

// ─── Core Connector Interface ─────────────────────────────────────────────────

export interface Connector {
  readonly meta: ConnectorMeta;
  init(config: ConnectorConfig): Promise<void>;
  healthcheck(): Promise<HealthCheckResult>;
  execute<TOutput>(operation: string, payload: unknown): Promise<TOutput>;
  shutdown(): Promise<void>;
}

// ─── Standard Business Objects ────────────────────────────────────────────────

export interface QuoteBar {
  symbol: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  timestamp: string;
  period: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
}

export interface QuoteTick {
  symbol: string;
  exchange: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  bidVolume: number;
  askVolume: number;
  volume: number;
  timestamp: string;
}

export interface ConnectorOrderIntent {
  id: string;
  symbol: string;
  exchange: string;
  side: "buy" | "sell";
  qty: number;
  orderType: "market" | "limit" | "stop" | "stop_limit";
  price?: number;
  timeInForce: "day" | "gtc" | "ioc" | "fok";
  riskSignature?: string;
}

export interface ConnectorOrder {
  brokerOrderId: string;
  orderIntentId: string;
  status: "submitted" | "partially_filled" | "filled" | "cancelled" | "rejected";
  submittedAt: string;
}

export interface ConnectorFill {
  brokerOrderId: string;
  fillQty: number;
  fillPrice: number;
  fee: number;
  filledAt: string;
}

export interface ConnectorPosition {
  accountId: string;
  symbol: string;
  exchange: string;
  qty: number;
  avgPrice: number;
  mtmPnl: number;
  snapshotTime: string;
}

export interface RiskCheckRequest {
  orderIntentId: string;
  strategyVersionId: string;
  instrumentId: string;
  side: "buy" | "sell";
  qty: number;
  price: number | null;
  currentPositions: ConnectorPosition[];
  metadata?: Record<string, unknown>;
}

export interface RiskCheckResponse {
  orderIntentId: string;
  decision: "allow" | "block" | "review";
  reason: string;
  signature: string;
  evaluatedAt: string;
}

// ─── Memory Connector Interface (extends Connector) ───────────────────────────

export interface MemoryMetadata {
  layer: "session" | "midterm" | "longterm";
  asofTime: string;
  projectId?: string;
  strategyId?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface MemoryFilters {
  layer?: "session" | "midterm" | "longterm";
  projectId?: string;
  strategyId?: string;
  fromTime?: string;
  toTime?: string;
  tags?: string[];
  minScore?: number;
}

export interface MemoryRecord {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  score?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryConnector extends Connector {
  add(content: string, metadata: MemoryMetadata): Promise<MemoryRecord>;
  search(query: string, filters: MemoryFilters, topK: number): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<void>;
  list(filters: MemoryFilters): Promise<MemoryRecord[]>;
}

// ─── Python Connector Bridge (JSON-RPC over stdio) ───────────────────────────

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
