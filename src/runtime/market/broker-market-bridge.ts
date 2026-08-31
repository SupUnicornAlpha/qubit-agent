import type { MarketCode } from "./resolve-ticker-market";

/**
 * Pluggable broker market-data bridges (WebSocket → MarketStreamGateway).
 *
 * Trading stays on `python_connectors/broker_http_server.py` + `broker_gateway/*`.
 * Quote / book / trade push uses a separate WS bridge so providers can be added
 * without coupling OpenD trade context to the stream path.
 */

export const BROKER_MARKET_BRIDGE_SOURCE_IDS = [
  "futu_bridge",
  "ib_bridge",
  "alpaca_bridge",
  "qmt_bridge",
  "supermind_bridge",
] as const;

export type BrokerMarketBridgeSourceId = (typeof BROKER_MARKET_BRIDGE_SOURCE_IDS)[number];

export type BrokerMarketBridgeId = "futu" | "ib" | "alpaca" | "qmt" | "supermind";

export interface BrokerMarketBridgeDescriptor {
  id: BrokerMarketBridgeId;
  /** Control-plane / MarketEvent source id. */
  sourceId: BrokerMarketBridgeSourceId;
  name: string;
  vendor: string;
  markets: MarketCode[];
  /** Env keys checked in order; first non-empty wins. */
  envKeys: string[];
  /** upstreamFamily for quality / mirror metadata. */
  upstreamFamily: "futu" | "ib" | "alpaca" | "qmt" | "supermind";
}

const BUILTIN: BrokerMarketBridgeDescriptor[] = [
  {
    id: "futu",
    sourceId: "futu_bridge",
    name: "Futu OpenQuote Bridge",
    vendor: "富途 OpenD",
    markets: ["CN", "HK", "US"],
    envKeys: ["QUBIT_FUTU_MARKET_WS_URL", "QUBIT_BROKER_MARKET_WS_URL_FUTU"],
    upstreamFamily: "futu",
  },
  {
    id: "ib",
    sourceId: "ib_bridge",
    name: "Interactive Brokers Market Bridge",
    vendor: "IB Gateway / TWS",
    markets: ["US", "HK", "FUTURES", "OPTION"],
    envKeys: ["QUBIT_IB_MARKET_WS_URL", "QUBIT_BROKER_MARKET_WS_URL_IB"],
    upstreamFamily: "ib",
  },
  {
    id: "alpaca",
    sourceId: "alpaca_bridge",
    name: "Alpaca Market Data Bridge",
    vendor: "Alpaca",
    markets: ["US", "OPTION"],
    envKeys: ["QUBIT_ALPACA_MARKET_WS_URL", "QUBIT_BROKER_MARKET_WS_URL_ALPACA"],
    upstreamFamily: "alpaca",
  },
  {
    id: "qmt",
    sourceId: "qmt_bridge",
    name: "QMT / xtquant Market Bridge",
    vendor: "迅投 QMT（由券商开通）",
    markets: ["CN"],
    envKeys: ["QUBIT_QMT_MARKET_WS_URL", "QUBIT_BROKER_MARKET_WS_URL_QMT"],
    upstreamFamily: "qmt",
  },
  {
    id: "supermind",
    sourceId: "supermind_bridge",
    name: "Tonghuashun SuperMind Quote Bridge",
    vendor: "同花顺 SuperMind",
    markets: ["CN"],
    envKeys: [
      "QUBIT_SUPERMIND_MARKET_WS_URL",
      "QUBIT_THS_MARKET_WS_URL",
      "QUBIT_BROKER_MARKET_WS_URL_SUPERMIND",
    ],
    upstreamFamily: "supermind",
  },
];

const registry = new Map<BrokerMarketBridgeId, BrokerMarketBridgeDescriptor>(
  BUILTIN.map((d) => [d.id, d])
);

export function isBrokerMarketBridgeSourceId(id: string): id is BrokerMarketBridgeSourceId {
  return (BROKER_MARKET_BRIDGE_SOURCE_IDS as readonly string[]).includes(id);
}

export function isBrokerMarketBridgeId(id: string): id is BrokerMarketBridgeId {
  return registry.has(id as BrokerMarketBridgeId);
}

/** Register or replace a bridge descriptor (tests / future plugins). */
export function registerBrokerMarketBridge(descriptor: BrokerMarketBridgeDescriptor): void {
  registry.set(descriptor.id, descriptor);
}

export function listBrokerMarketBridges(): BrokerMarketBridgeDescriptor[] {
  return [...registry.values()];
}

export function getBrokerMarketBridge(
  id: BrokerMarketBridgeId
): BrokerMarketBridgeDescriptor | undefined {
  return registry.get(id);
}

export function resolveBridgeWsUrl(id: BrokerMarketBridgeId): string | undefined {
  const desc = registry.get(id);
  if (!desc) return undefined;
  for (const key of desc.envKeys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function isBrokerBridgeConfigured(id: BrokerMarketBridgeId): boolean {
  return Boolean(resolveBridgeWsUrl(id));
}

export function bridgeIdForSourceId(sourceId: string): BrokerMarketBridgeId | undefined {
  for (const desc of registry.values()) {
    if (desc.sourceId === sourceId) return desc.id;
  }
  return undefined;
}

export interface SelectedBrokerMarketBridge {
  id: BrokerMarketBridgeId;
  sourceId: BrokerMarketBridgeSourceId;
  url: string;
  upstreamFamily: BrokerMarketBridgeDescriptor["upstreamFamily"];
}

export type BrokerBridgeHealthHint = {
  credentialsReady: boolean;
  healthStatus: "healthy" | "unknown" | "degraded" | "down";
};

/** Populated from market-data control plane so stream auto can prefer healthy brokers. */
const bridgeHealthHints = new Map<BrokerMarketBridgeSourceId, BrokerBridgeHealthHint>();

export function setBrokerBridgeHealthHints(
  hints: ReadonlyArray<{
    sourceId: string;
    credentialsReady: boolean;
    healthStatus: BrokerBridgeHealthHint["healthStatus"];
  }>
): void {
  bridgeHealthHints.clear();
  for (const hint of hints) {
    if (!isBrokerMarketBridgeSourceId(hint.sourceId)) continue;
    bridgeHealthHints.set(hint.sourceId, {
      credentialsReady: hint.credentialsReady,
      healthStatus: hint.healthStatus,
    });
  }
}

export function getBrokerBridgeHealthHint(
  sourceId: BrokerMarketBridgeSourceId
): BrokerBridgeHealthHint | undefined {
  return bridgeHealthHints.get(sourceId);
}

function bridgeHealthRank(sourceId: BrokerMarketBridgeSourceId): number {
  const hint = bridgeHealthHints.get(sourceId);
  // No control-plane hint yet: treat as unknown so a configured bridge can still
  // be selected; down bridges are filtered out by isBridgeAutoEligible.
  if (!hint) return 3;
  if (!hint.credentialsReady) return 0;
  switch (hint.healthStatus) {
    case "healthy":
      return 4;
    case "unknown":
      return 3;
    case "degraded":
      return 2;
    case "down":
      return 0;
    default:
      return 0;
  }
}

function isBridgeAutoEligible(sourceId: BrokerMarketBridgeSourceId): boolean {
  const hint = bridgeHealthHints.get(sourceId);
  if (!hint) return true;
  if (!hint.credentialsReady) return false;
  return hint.healthStatus !== "down";
}

/**
 * Pick a configured bridge for the resolved market.
 * Preference: `QUBIT_MARKET_STREAM_PROVIDER` → market-matched bridges ranked by
 * control-plane health (healthy first), then stable vendor order.
 */
export function selectBrokerMarketBridge(input: {
  market: MarketCode | string;
  preferred?: string | null;
}): SelectedBrokerMarketBridge | null {
  const preferred = (input.preferred ?? process.env.QUBIT_MARKET_STREAM_PROVIDER ?? "")
    .trim()
    .toLowerCase();

  if (preferred && isBrokerMarketBridgeId(preferred)) {
    const url = resolveBridgeWsUrl(preferred);
    const desc = registry.get(preferred);
    if (url && desc) {
      const hint = bridgeHealthHints.get(desc.sourceId);
      // Explicit env override still wins when health is unknown/degraded; skip when
      // credentials are missing or the control plane has marked the bridge down.
      if (hint && (hint.credentialsReady === false || hint.healthStatus === "down")) {
        /* fall through to market auto / polling */
      } else {
        return {
          id: desc.id,
          sourceId: desc.sourceId,
          url,
          upstreamFamily: desc.upstreamFamily,
        };
      }
    }
  }

  const market = String(input.market || "").toUpperCase();
  const candidates = [...registry.values()].filter((d) => d.markets.some((m) => m === market));
  const order: BrokerMarketBridgeId[] =
    market === "US" || market === "OPTION"
      ? ["ib", "alpaca", "futu", "supermind", "qmt"]
      : market === "CN"
        ? ["qmt", "futu", "supermind", "ib", "alpaca"]
        : ["futu", "ib", "alpaca", "supermind", "qmt"];

  const scored: Array<{
    desc: BrokerMarketBridgeDescriptor;
    url: string;
    rank: number;
    orderIdx: number;
  }> = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i]!;
    const desc = candidates.find((c) => c.id === id);
    if (!desc) continue;
    const url = resolveBridgeWsUrl(desc.id);
    if (!url) continue;
    if (!isBridgeAutoEligible(desc.sourceId)) continue;
    scored.push({
      desc,
      url,
      rank: bridgeHealthRank(desc.sourceId),
      orderIdx: i,
    });
  }
  scored.sort((a, b) => b.rank - a.rank || a.orderIdx - b.orderIdx);
  const best = scored[0];
  if (!best) return null;
  return {
    id: best.desc.id,
    sourceId: best.desc.sourceId,
    url: best.url,
    upstreamFamily: best.desc.upstreamFamily,
  };
}

export function brokerBridgeStatusSnapshot(): Array<{
  id: BrokerMarketBridgeId;
  sourceId: BrokerMarketBridgeSourceId;
  name: string;
  vendor: string;
  markets: MarketCode[];
  configured: boolean;
  envKeys: string[];
}> {
  return listBrokerMarketBridges().map((d) => ({
    id: d.id,
    sourceId: d.sourceId,
    name: d.name,
    vendor: d.vendor,
    markets: d.markets,
    configured: isBrokerBridgeConfigured(d.id),
    envKeys: d.envKeys,
  }));
}
