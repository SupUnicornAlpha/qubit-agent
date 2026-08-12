/**
 * Strategy Contract V2 — paper session (Prime 06 SC2).
 *
 * Fixed paper capital sizing (Q-SC1): percent targets are valued against the
 * session's paperCapital, not live account equity — reproducible and auditable.
 */
import { randomUUID } from "node:crypto";
import type { StrategyManifestV2 } from "./contract-service";

export type PaperSessionStatus = "ready" | "running" | "stopped" | "error";

export type StrategyPaperSession = {
  id: string;
  codeHash: string;
  strategyCode: string;
  manifest: StrategyManifestV2;
  /** Fixed paper notional (USD units) for target_percent → qty. */
  paperCapital: number;
  strategyVersionId: string | null;
  workflowRunId: string | null;
  projectId: string | null;
  primarySymbol: string;
  market: string;
  timeframe: string;
  status: PaperSessionStatus;
  intentCount: number;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  params: Record<string, unknown>;
};

const SESSIONS = new Map<string, StrategyPaperSession>();

function nowIso(): string {
  return new Date().toISOString();
}

export function createPaperSession(input: {
  strategyCode: string;
  manifest: StrategyManifestV2;
  paperCapital?: number;
  strategyVersionId?: string | null;
  workflowRunId?: string | null;
  projectId?: string | null;
  primarySymbol: string;
  market?: string;
  timeframe?: string;
  params?: Record<string, unknown>;
}): StrategyPaperSession {
  const createdAt = nowIso();
  const capital = Number(input.paperCapital ?? 100_000);
  const session: StrategyPaperSession = {
    id: randomUUID(),
    codeHash: input.manifest.codeHash,
    strategyCode: input.strategyCode,
    manifest: input.manifest,
    paperCapital: Number.isFinite(capital) && capital > 0 ? capital : 100_000,
    strategyVersionId: input.strategyVersionId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    projectId: input.projectId ?? null,
    primarySymbol: input.primarySymbol,
    market: (input.market ?? "US").trim() || "US",
    timeframe: input.timeframe?.trim() || String(input.manifest.primaryFrequency ?? "1d"),
    status: "ready",
    intentCount: 0,
    lastRunAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
    params: input.params ?? {},
  };
  SESSIONS.set(session.id, session);
  return session;
}

export function getPaperSession(id: string): StrategyPaperSession | null {
  return SESSIONS.get(id) ?? null;
}

export function updatePaperSession(
  id: string,
  patch: Partial<
    Pick<
      StrategyPaperSession,
      "status" | "intentCount" | "lastRunAt" | "lastError" | "strategyVersionId" | "workflowRunId"
    >
  >
): StrategyPaperSession | null {
  const cur = SESSIONS.get(id);
  if (!cur) return null;
  const next: StrategyPaperSession = {
    ...cur,
    ...patch,
    updatedAt: nowIso(),
  };
  SESSIONS.set(id, next);
  return next;
}

export function listPaperSessions(limit = 50): StrategyPaperSession[] {
  return [...SESSIONS.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

/** Convert SimBroker trade ledger → order.create_intent payloads (fixed capital already applied in Sim). */
export function tradesToPaperOrderDrafts(
  trades: Array<Record<string, unknown>>,
  opts?: { maxOrders?: number }
): Array<{
  side: "buy" | "sell";
  qty: number;
  price: number;
  symbol: string;
  signalBarTime: string;
  reason: string;
}> {
  const max = opts?.maxOrders ?? 40;
  const out: Array<{
    side: "buy" | "sell";
    qty: number;
    price: number;
    symbol: string;
    signalBarTime: string;
    reason: string;
  }> = [];
  for (const t of trades) {
    if (out.length >= max) break;
    const sideRaw = String(t.side ?? "").toLowerCase();
    const side = sideRaw === "buy" || sideRaw === "sell" ? sideRaw : null;
    const qty = Number(t.qty);
    const price = Number(t.price);
    const symbol = String(t.symbol ?? "").trim();
    if (!side || !symbol || !(qty > 0) || !(price > 0)) continue;
    out.push({
      side,
      qty,
      price,
      symbol,
      signalBarTime: String(t.time ?? ""),
      reason: String(t.reason ?? ""),
    });
  }
  return out;
}

/** Test helper — clear in-memory sessions. */
export function __resetPaperSessionsForTests(): void {
  SESSIONS.clear();
}
