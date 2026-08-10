import type {
  BarData,
  OrderBookData,
  QuoteData,
  TradeData,
} from "../../connectors/data/data.connector";
import { connectorRegistry } from "../../connectors/registry";
import { symbolToBinancePair } from "./crypto-market";
import { computeDateRangeForLimit, timeframeToPeriod } from "./klines-query";
import {
  queryMarketOrderBook,
  queryMarketQuote,
  queryMarketTrades,
} from "./microstructure-query";
import { resolveTickerMarket } from "./resolve-ticker-market";
import { MarketBarAggregator } from "./market-stream-aggregator";
import {
  marketEventMirrorJournal,
  safeMirrorMarketStreamEvent,
} from "./contracts/market-event-mirror";
import { selectBrokerMarketBridge } from "./broker-market-bridge";

export type MarketStreamEventKind =
  | "status"
  | "heartbeat"
  | "quote"
  | "order_book"
  | "trade"
  | "bar"
  | "backfill";

export interface MarketStreamSubscription {
  symbol: string;
  exchange?: string;
  timeframe?: string;
  channels?: Array<"quote" | "order_book" | "trade" | "bar">;
}

export interface MarketStreamEvent {
  kind: MarketStreamEventKind;
  sequence: number;
  symbol: string;
  exchange: string;
  timeframe: string;
  source: string;
  emittedAt: string;
  data: unknown;
}

export interface MarketStreamMetrics {
  activeStreams: number;
  activeListeners: number;
  eventsPublished: number;
  reconnects: number;
  gapsDetected: number;
  backfills: number;
  lastEventAt: string | null;
  lastError: string | null;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
  staleEvents: number;
  /** D1 side-path MarketEvent v2 mirror counts (observability only). */
  mirroredMarketEvents: number;
  mirrorErrors: number;
}

type Listener = (event: MarketStreamEvent) => void;

interface StreamSession {
  add(listener: Listener): void;
  remove(listener: Listener): void;
  dispatch(event: MarketStreamEvent): void;
  listenerCount(): number;
  close(): void;
}

interface SessionHooks {
  publish(kind: MarketStreamEventKind, source: string, data: unknown): void;
  reconnect(): void;
  gap(): void;
  backfill(): void;
  error(error: unknown): void;
}

function normalized(input: MarketStreamSubscription): Required<MarketStreamSubscription> {
  const symbol = typeof input?.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
  return {
    symbol,
    exchange: input?.exchange?.trim().toUpperCase() ?? "",
    timeframe: input?.timeframe?.trim().toLowerCase() || "1m",
    channels:
      input?.channels && input.channels.length > 0
        ? [...new Set(input.channels)]
        : ["quote", "bar"],
  };
}

function subscriptionKey(input: Required<MarketStreamSubscription>): string {
  return [
    input.symbol,
    input.exchange,
    input.timeframe,
    [...input.channels].sort().join(","),
  ].join("|");
}

function normalizedSymbol(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!raw) return "";
  // Bridges commonly use `US.NVDA` or `US:NVDA`; the subscription keeps `NVDA`.
  return raw.split(/[.:/]/).at(-1) ?? raw;
}

/**
 * A bridge can multiplex several contracts over one socket.  Never let a quote
 * for another contract enter the subscription's bar aggregator: it would turn
 * the last candle into a misleading cross-symbol range.
 */
export function bridgePayloadMatchesSubscription(
  input: Required<MarketStreamSubscription>,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object") return true;
  const record = payload as Record<string, unknown>;
  const receivedSymbol = normalizedSymbol(record.symbol ?? record.code ?? record.ticker);
  if (receivedSymbol && receivedSymbol !== normalizedSymbol(input.symbol)) return false;
  const receivedExchange =
    typeof record.exchange === "string" ? record.exchange.trim().toUpperCase() : "";
  return !(receivedExchange && input.exchange && receivedExchange !== input.exchange);
}

function socketText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  return String(data ?? "");
}

abstract class BaseSession implements StreamSession {
  protected readonly listeners = new Set<Listener>();
  protected closed = false;

  constructor(
    protected readonly input: Required<MarketStreamSubscription>,
    protected readonly hooks: SessionHooks
  ) {}

  add(listener: Listener): void {
    this.listeners.add(listener);
  }

  remove(listener: Listener): void {
    this.listeners.delete(listener);
  }

  dispatch(event: MarketStreamEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  protected emit(kind: MarketStreamEventKind, source: string, data: unknown): void {
    this.hooks.publish(kind, source, data);
  }

  abstract close(): void;
}

class BinanceStreamSession extends BaseSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastProviderEventAt = 0;
  private lastQuoteEmittedAt = 0;

  constructor(input: Required<MarketStreamSubscription>, hooks: SessionHooks) {
    super(input, hooks);
    this.connect();
    this.heartbeatTimer = setInterval(() => {
      this.emit("heartbeat", "binance_ws", {
        providerEventAgeMs:
          this.lastProviderEventAt > 0 ? Date.now() - this.lastProviderEventAt : null,
      });
    }, 15_000);
  }

  private connect(): void {
    if (this.closed) return;
    const pair = symbolToBinancePair(this.input.symbol, this.input.exchange).toLowerCase();
    const interval = this.input.timeframe === "1w" ? "1w" : this.input.timeframe;
    const streams: string[] = [];
    if (this.input.channels.includes("bar")) streams.push(`${pair}@kline_${interval}`);
    if (this.input.channels.includes("quote") || this.input.channels.includes("order_book")) {
      streams.push(`${pair}@bookTicker`);
    }
    if (this.input.channels.includes("trade")) streams.push(`${pair}@trade`);
    const base = (
      process.env.QUBIT_BINANCE_WS_URL ??
      "wss://data-stream.binance.vision/stream"
    ).replace(/\/+$/, "");
    this.socket = new WebSocket(`${base}?streams=${streams.join("/")}`);
    this.socket.addEventListener("open", () => {
      const wasReconnect = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.emit("status", "binance_ws", { status: "connected", wasReconnect });
      void emitBackfill(this.input, this.hooks, "binance_crypto");
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(socketText(event.data)));
    this.socket.addEventListener("error", () => {
      this.hooks.error(new Error("binance websocket error"));
    });
    this.socket.addEventListener("close", () => this.scheduleReconnect());
  }

  private handleMessage(raw: string): void {
    let envelope: { stream?: string; data?: Record<string, unknown> };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      return;
    }
    const data = envelope.data ?? {};
    const providerEventAt = Number(data.E ?? Date.now());
    if (
      this.lastProviderEventAt > 0 &&
      providerEventAt - this.lastProviderEventAt > 15_000
    ) {
      this.hooks.gap();
      this.emit("status", "binance_ws", {
        status: "gap_detected",
        gapMs: providerEventAt - this.lastProviderEventAt,
      });
      void emitBackfill(this.input, this.hooks, "binance_crypto");
    }
    this.lastProviderEventAt = providerEventAt;

    if (data.e === "kline" && data.k && typeof data.k === "object") {
      const kline = data.k as Record<string, unknown>;
      const bar: BarData = {
        symbol: this.input.symbol,
        exchange: this.input.exchange || "CRYPTO",
        open: Number(kline.o),
        high: Number(kline.h),
        low: Number(kline.l),
        close: Number(kline.c),
        volume: Number(kline.v),
        turnover: Number(kline.q),
        timestamp: new Date(Number(kline.t)).toISOString(),
      };
      if ([bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) {
        this.emit("bar", "binance_ws", { ...bar, closed: Boolean(kline.x) });
      }
      return;
    }

    if (data.e === "trade") {
      const trade: TradeData = {
        id: `binance:${String(data.s ?? this.input.symbol)}:${String(data.t ?? providerEventAt)}`,
        symbol: this.input.symbol,
        exchange: this.input.exchange || "CRYPTO",
        source: "binance_ws",
        price: Number(data.p),
        volume: Number(data.q),
        side: data.m === true ? "sell" : "buy",
        timestamp: new Date(Number(data.T ?? providerEventAt)).toISOString(),
      };
      this.emit("trade", "binance_ws", trade);
      return;
    }

    if (data.u !== undefined && data.b !== undefined && data.a !== undefined) {
      const now = Date.now();
      if (now - this.lastQuoteEmittedAt < 200) return;
      this.lastQuoteEmittedAt = now;
      const timestamp = new Date(providerEventAt).toISOString();
      const quote: QuoteData = {
        symbol: this.input.symbol,
        exchange: this.input.exchange || "CRYPTO",
        source: "binance_ws",
        lastPrice: (Number(data.b) + Number(data.a)) / 2,
        bidPrice: Number(data.b),
        bidVolume: Number(data.B),
        askPrice: Number(data.a),
        askVolume: Number(data.A),
        timestamp,
        freshnessMs: Math.max(0, Date.now() - providerEventAt),
      };
      this.emit("quote", "binance_ws", quote);
      if (this.input.channels.includes("order_book")) {
        const orderBook: OrderBookData = {
          symbol: quote.symbol,
          exchange: quote.exchange,
          source: quote.source,
          bids: [{ price: quote.bidPrice ?? 0, volume: quote.bidVolume ?? 0 }],
          asks: [{ price: quote.askPrice ?? 0, volume: quote.askVolume ?? 0 }],
          timestamp,
          freshnessMs: quote.freshnessMs,
        };
        this.emit("order_book", "binance_ws", orderBook);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.hooks.reconnect();
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.emit("status", "binance_ws", {
      status: "reconnecting",
      attempt: this.reconnectAttempt,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close();
    this.socket = null;
  }
}

class PollingStreamSession extends BaseSession {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private degraded = false;
  private lastSuccessAt = 0;
  private readonly seenTradeIds = new Set<string>();
  private readonly aggregator: MarketBarAggregator;

  constructor(input: Required<MarketStreamSubscription>, hooks: SessionHooks) {
    super(input, hooks);
    this.aggregator = new MarketBarAggregator(
      input.symbol,
      input.exchange || "UNKNOWN",
      input.timeframe
    );
    void emitBackfill(input, hooks, "market_poll");
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), 2_000);
    this.heartbeatTimer = setInterval(
      () => this.emit("heartbeat", "market_poll", { status: "alive" }),
      15_000
    );
  }

  private async poll(): Promise<void> {
    if (this.closed || this.inFlight) return;
    this.inFlight = true;
    try {
      if (this.input.channels.includes("quote") || this.input.channels.includes("bar")) {
        const quote = await queryMarketQuote(this.input);
        this.emit("quote", quote.source, quote);
        if (this.input.channels.includes("bar")) {
          const aggregated = this.aggregator.update({
            price: quote.lastPrice,
            timestamp: quote.timestamp,
          });
          if (aggregated) {
            this.emit("bar", quote.source, {
              ...aggregated.bar,
              closed: false,
              derivedFrom: "quote",
            });
          }
        }
      }
      if (this.input.channels.includes("order_book")) {
        const book = await queryMarketOrderBook({ ...this.input, depth: 5 });
        this.emit("order_book", book.source, book);
      }
      if (this.input.channels.includes("trade")) {
        const trades = await queryMarketTrades({ ...this.input, limit: 20 });
        for (const trade of trades.slice(-20)) {
          if (this.seenTradeIds.has(trade.id)) continue;
          this.seenTradeIds.add(trade.id);
          this.emit("trade", trade.source, trade);
        }
        while (this.seenTradeIds.size > 500) {
          const oldest = this.seenTradeIds.values().next().value;
          if (typeof oldest !== "string") break;
          this.seenTradeIds.delete(oldest);
        }
      }
      if (this.degraded) {
        this.hooks.reconnect();
        this.hooks.gap();
        this.emit("status", "market_poll", {
          status: "recovered",
          outageMs: this.lastSuccessAt > 0 ? Date.now() - this.lastSuccessAt : null,
        });
        void emitBackfill(this.input, this.hooks, "market_poll");
      }
      this.degraded = false;
      this.lastSuccessAt = Date.now();
    } catch (error) {
      this.degraded = true;
      this.hooks.error(error);
      this.emit("status", "market_poll", {
        status: "degraded",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  close(): void {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }
}

class BridgeStreamSession extends BaseSession {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastProviderEventAt = 0;
  private lastProviderSequence: number | null = null;
  private readonly aggregator: MarketBarAggregator;

  constructor(
    input: Required<MarketStreamSubscription>,
    hooks: SessionHooks,
    private readonly bridgeUrl: string,
    private readonly provider: string
  ) {
    super(input, hooks);
    this.aggregator = new MarketBarAggregator(
      input.symbol,
      input.exchange || "UNKNOWN",
      input.timeframe
    );
    this.connect();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ action: "ping", ts: Date.now() }));
      }
      this.emit("heartbeat", `${this.provider}_bridge`, {
        providerEventAgeMs:
          this.lastProviderEventAt > 0 ? Date.now() - this.lastProviderEventAt : null,
      });
    }, 15_000);
  }

  private connect(): void {
    if (this.closed) return;
    this.socket = new WebSocket(this.bridgeUrl);
    this.socket.addEventListener("open", () => {
      const wasReconnect = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.socket?.send(JSON.stringify({ action: "subscribe", ...this.input }));
      this.emit("status", `${this.provider}_bridge`, { status: "connected", wasReconnect });
      void emitBackfill(this.input, this.hooks, `${this.provider}_bridge`);
    });
    this.socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(socketText(event.data)) as {
          kind?: MarketStreamEventKind;
          data?: unknown;
          sequence?: number;
          timestamp?: string | number;
        };
        const providerEventAt =
          typeof payload.timestamp === "number"
            ? payload.timestamp
            : typeof payload.timestamp === "string"
              ? Date.parse(payload.timestamp)
              : Date.now();
        const sequence = Number(payload.sequence);
        const sequenceGap =
          Number.isFinite(sequence) &&
          this.lastProviderSequence !== null &&
          sequence > this.lastProviderSequence + 1;
        const timeGap =
          this.lastProviderEventAt > 0 &&
          providerEventAt - this.lastProviderEventAt > 30_000;
        if (sequenceGap || timeGap) {
          this.hooks.gap();
          this.emit("status", `${this.provider}_bridge`, {
            status: "gap_detected",
            expectedSequence:
              this.lastProviderSequence === null ? null : this.lastProviderSequence + 1,
            receivedSequence: Number.isFinite(sequence) ? sequence : null,
            gapMs: timeGap ? providerEventAt - this.lastProviderEventAt : null,
          });
          void emitBackfill(this.input, this.hooks, `${this.provider}_bridge`);
        }
        this.lastProviderEventAt = providerEventAt;
        if (Number.isFinite(sequence)) this.lastProviderSequence = sequence;
        if (payload.kind) {
          if (
            (payload.kind === "quote" || payload.kind === "trade" || payload.kind === "bar") &&
            !bridgePayloadMatchesSubscription(this.input, payload.data)
          ) {
            this.hooks.error(
              new Error(
                `${this.provider} bridge ignored a cross-symbol ${payload.kind} payload`,
              ),
            );
            return;
          }
          this.emit(payload.kind, `${this.provider}_bridge`, payload.data);
          if (this.input.channels.includes("bar") && payload.data && typeof payload.data === "object") {
            const record = payload.data as Record<string, unknown>;
            const price =
              payload.kind === "quote" ? Number(record.lastPrice) : Number(record.price);
            if ((payload.kind === "quote" || payload.kind === "trade") && Number.isFinite(price)) {
              const aggregated = this.aggregator.update({
                price,
                volume: payload.kind === "trade" ? Number(record.volume ?? 0) : 0,
                turnover:
                  payload.kind === "trade"
                    ? price * Number(record.volume ?? 0)
                    : 0,
                timestamp: String(record.timestamp ?? new Date().toISOString()),
              });
              if (aggregated) {
                this.emit("bar", `${this.provider}_bridge`, {
                  ...aggregated.bar,
                  closed: false,
                  derivedFrom: payload.kind,
                });
              }
            }
          }
        }
      } catch (error) {
        this.hooks.error(error);
      }
    });
    this.socket.addEventListener("error", () =>
      this.hooks.error(new Error(`${this.provider} market bridge websocket error`))
    );
    this.socket.addEventListener("close", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    this.hooks.reconnect();
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close();
    this.socket = null;
  }
}

async function emitBackfill(
  input: Required<MarketStreamSubscription>,
  hooks: SessionHooks,
  source: string
): Promise<void> {
  if (!input.channels.includes("bar")) return;
  try {
    const connector = connectorRegistry.get("qubit-data");
    if (!connector) throw new Error("qubit-data connector is not registered");
    const { startDate, endDate } = computeDateRangeForLimit(input.timeframe, 120);
    const bars = (await connector.execute("fetch_bars", {
      symbol: input.symbol,
      exchange: input.exchange,
      period: timeframeToPeriod(input.timeframe),
      startDate,
      endDate,
    })) as BarData[];
    hooks.backfill();
    hooks.publish("backfill", source, bars.slice(-120));
  } catch (error) {
    hooks.error(error);
    hooks.publish("status", source, {
      status: "backfill_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

class MarketStreamGateway {
  private readonly sessions = new Map<string, StreamSession>();
  private readonly sequences = new Map<string, number>();
  private readonly globalListeners = new Set<Listener>();
  private readonly latencySamples: number[] = [];
  private readonly metrics: MarketStreamMetrics = {
    activeStreams: 0,
    activeListeners: 0,
    eventsPublished: 0,
    reconnects: 0,
    gapsDetected: 0,
    backfills: 0,
    lastEventAt: null,
    lastError: null,
    averageLatencyMs: null,
    p95LatencyMs: null,
    staleEvents: 0,
    mirroredMarketEvents: 0,
    mirrorErrors: 0,
  };

  /** Fan-in listener for all symbol sessions (sim reactor / observability). */
  subscribeAll(listener: Listener): () => void {
    this.globalListeners.add(listener);
    this.refreshCounts();
    return () => {
      this.globalListeners.delete(listener);
      this.refreshCounts();
    };
  }

  subscribe(inputRaw: MarketStreamSubscription, listener: Listener): () => void {
    const input = normalized(inputRaw);
    if (!input.symbol) throw new Error("market stream symbol is required");
    const key = subscriptionKey(input);
    let session = this.sessions.get(key);
    if (!session) {
      const hooks: SessionHooks = {
        publish: (kind, source, data) => {
          const sequence = (this.sequences.get(key) ?? 0) + 1;
          this.sequences.set(key, sequence);
          const event: MarketStreamEvent = {
            kind,
            sequence,
            symbol: input.symbol,
            exchange: input.exchange,
            timeframe: input.timeframe,
            source,
            emittedAt: new Date().toISOString(),
            data,
          };
          this.metrics.eventsPublished += 1;
          this.metrics.lastEventAt = event.emittedAt;
          this.observeFreshness(kind, data);
          // D1: side-path mirror — never blocks dispatch on failure.
          safeMirrorMarketStreamEvent(event);
          const mirror = marketEventMirrorJournal.metrics();
          this.metrics.mirroredMarketEvents = mirror.mirrored;
          this.metrics.mirrorErrors = mirror.errors;
          try {
            this.sessions.get(key)?.dispatch(event);
          } catch (error) {
            this.metrics.lastError = error instanceof Error ? error.message : String(error);
          }
          for (const global of this.globalListeners) {
            try {
              global(event);
            } catch (error) {
              this.metrics.lastError = error instanceof Error ? error.message : String(error);
            }
          }
        },
        reconnect: () => {
          this.metrics.reconnects += 1;
        },
        gap: () => {
          this.metrics.gapsDetected += 1;
        },
        backfill: () => {
          this.metrics.backfills += 1;
        },
        error: (error) => {
          this.metrics.lastError = error instanceof Error ? error.message : String(error);
        },
      };
      session = this.createSession(input, hooks);
      this.sessions.set(key, session);
    }
    session.add(listener);
    this.refreshCounts();
    return () => {
      const active = this.sessions.get(key);
      if (!active) return;
      active.remove(listener);
      if (active.listenerCount() === 0) {
        active.close();
        this.sessions.delete(key);
        this.sequences.delete(key);
      }
      this.refreshCounts();
    };
  }

  snapshot(): MarketStreamMetrics {
    this.refreshCounts();
    return { ...this.metrics };
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.sequences.clear();
    this.refreshCounts();
  }

  private createSession(
    input: Required<MarketStreamSubscription>,
    hooks: SessionHooks
  ): StreamSession {
    const resolution = resolveTickerMarket(input.symbol, { hintExchange: input.exchange });
    if (resolution.market === "CRYPTO") return new BinanceStreamSession(input, hooks);
    // Lazy: if Futu account exists but WS env not set yet, kick ensure (non-blocking retry on next subscribe).
    if (
      !process.env.QUBIT_FUTU_MARKET_WS_URL?.trim() &&
      (resolution.market === "CN" || resolution.market === "HK" || resolution.market === "US")
    ) {
      void import("./futu-runtime")
        .then((m) => m.ensureFutuRuntime())
        .catch(() => undefined);
    }
    const bridge = selectBrokerMarketBridge({ market: resolution.market });
    if (bridge) {
      return new BridgeStreamSession(input, hooks, bridge.url, bridge.id);
    }
    return new PollingStreamSession(input, hooks);
  }

  private refreshCounts(): void {
    this.metrics.activeStreams = this.sessions.size;
    this.metrics.activeListeners =
      this.globalListeners.size +
      [...this.sessions.values()].reduce((sum, session) => sum + session.listenerCount(), 0);
  }

  private observeFreshness(kind: MarketStreamEventKind, data: unknown): void {
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const record = data as Record<string, unknown>;
    const explicit = Number(record.freshnessMs);
    if (
      !Number.isFinite(explicit) &&
      kind !== "quote" &&
      kind !== "order_book" &&
      kind !== "trade"
    ) {
      return;
    }
    const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    const latency = Number.isFinite(explicit)
      ? Math.max(0, explicit)
      : Number.isFinite(timestamp)
        ? Math.max(0, Date.now() - timestamp)
        : NaN;
    if (!Number.isFinite(latency)) return;
    this.latencySamples.push(latency);
    if (this.latencySamples.length > 256) this.latencySamples.shift();
    const sorted = [...this.latencySamples].sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    this.metrics.averageLatencyMs = total / sorted.length;
    this.metrics.p95LatencyMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null;
    if (latency > 30_000) this.metrics.staleEvents += 1;
  }
}

export const marketStreamGateway = new MarketStreamGateway();
