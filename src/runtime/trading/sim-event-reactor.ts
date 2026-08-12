/**
 * Sim / realtime event reactor — drive strategy_runtime (and optional Agent) from
 * market stream bars or news without waiting for the 30s poll.
 *
 * Fast path (no LLM, low TTFT): closed bar → processStrategyRuntimesForSymbol → order intent (sim).
 * Agent path (optional, higher TTFT): news_event / QUBIT_SIM_BAR_WAKE_AGENT → thin A2A wake.
 */

import { triggerAutonomousA2A } from "../a2a/autonomous-trigger";
import { type MarketStreamEvent, marketStreamGateway } from "../market/market-stream-gateway";
import { processStrategyRuntimesForSymbol } from "../strategy/strategy-runtime-worker";

let unsubscribe: (() => void) | null = null;
let newsHooked = false;

function barClosed(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.closed === true || d.isClosed === true) return true;
  // Aggregator / bridge may omit closed; treat terminal bar payloads as actionable.
  return typeof d.close === "number" || typeof d.c === "number";
}

function barWakeAgentEnabled(): boolean {
  const v = process.env.QUBIT_SIM_BAR_WAKE_AGENT;
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

async function onMarketEvent(event: MarketStreamEvent): Promise<void> {
  if (event.kind !== "bar") return;
  if (!barClosed(event.data)) return;
  const symbol = event.symbol?.trim();
  if (!symbol) return;
  try {
    const { matched } = await processStrategyRuntimesForSymbol(symbol);
    if (matched > 0) {
      console.info(
        `[sim-event-reactor] bar→runtime symbol=${symbol} matched=${matched} source=${event.source}`
      );
    }
    // Optional Agent wake — default OFF so TTFT stays on the deterministic path.
    if (barWakeAgentEnabled()) {
      await triggerAutonomousA2A({
        kind: "market_alert",
        source: event.source ?? "sim-event-reactor",
        severity: "info",
        message: `bar_close ${symbol}`,
        payload: {
          symbols: [symbol],
          preferredDispatchMode: "sim",
          ttftHint: "prefer_order_create_intent_sim",
          bar: typeof event.data === "object" ? event.data : {},
        },
      });
    }
  } catch (e) {
    console.warn(
      `[sim-event-reactor] bar tick failed symbol=${symbol}:`,
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Push a news/event into the trading loop:
 * 1) Fast: tick strategy runtimes for mentioned symbols (deterministic)
 * 2) Optional Agent wake: autonomous A2A (higher TTFT; keep payload small)
 */
export async function ingestTradingNewsEvent(input: {
  symbols: string[];
  headline: string;
  source?: string;
  wakeAgent?: boolean;
  projectId?: string;
  sessionId?: string;
}): Promise<{ runtimeMatches: number; agentTriggered: boolean }> {
  let runtimeMatches = 0;
  for (const sym of input.symbols) {
    const r = await processStrategyRuntimesForSymbol(sym);
    runtimeMatches += r.matched;
  }

  let agentTriggered = false;
  if (input.wakeAgent !== false && input.symbols.length > 0) {
    try {
      await triggerAutonomousA2A({
        kind: "news_event",
        source: input.source ?? "sim-event-reactor",
        severity: "warn",
        message: input.headline.slice(0, 240),
        payload: {
          symbols: input.symbols,
          headline: input.headline,
          preferredDispatchMode: "sim",
          ttftHint: "prefer_order_create_intent_sim",
        },
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
      agentTriggered = true;
    } catch (e) {
      console.warn("[sim-event-reactor] agent wake failed:", e instanceof Error ? e.message : e);
    }
  }

  return { runtimeMatches, agentTriggered };
}

export function startSimEventReactor(): void {
  if (unsubscribe) return;
  unsubscribe = marketStreamGateway.subscribeAll((event) => {
    void onMarketEvent(event);
  });
  newsHooked = true;
  console.info("[sim-event-reactor] listening to marketStreamGateway bars");
}

export function stopSimEventReactor(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  newsHooked = false;
}

export function isSimEventReactorRunning(): boolean {
  return unsubscribe != null && newsHooked;
}
