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
  "supermind_bridge",
] as const;

export type BrokerMarketBridgeSourceId = (typeof BROKER_MARKET_BRIDGE_SOURCE_IDS)[number];

export type BrokerMarketBridgeId = "futu" | "ib" | "supermind";

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
  upstreamFamily: "futu" | "ib" | "supermind";
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
    markets: ["US", "HK"],
    envKeys: ["QUBIT_IB_MARKET_WS_URL", "QUBIT_BROKER_MARKET_WS_URL_IB"],
    upstreamFamily: "ib",
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

export function bridgeIdForSourceId(
  sourceId: string
): BrokerMarketBridgeId | undefined {
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

/**
 * Pick a configured bridge for the resolved market.
 * Preference: `QUBIT_MARKET_STREAM_PROVIDER` → market-matched first configured bridge.
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
      return {
        id: desc.id,
        sourceId: desc.sourceId,
        url,
        upstreamFamily: desc.upstreamFamily,
      };
    }
  }

  const market = String(input.market || "").toUpperCase();
  const candidates = [...registry.values()].filter((d) =>
    d.markets.some((m) => m === market)
  );
  // Stable order: futu → supermind → ib for CN/HK; ib first for US via market filter.
  const order: BrokerMarketBridgeId[] =
    market === "US" ? ["ib", "futu", "supermind"] : ["futu", "supermind", "ib"];
  for (const id of order) {
    const desc = candidates.find((c) => c.id === id);
    if (!desc) continue;
    const url = resolveBridgeWsUrl(desc.id);
    if (url) {
      return {
        id: desc.id,
        sourceId: desc.sourceId,
        url,
        upstreamFamily: desc.upstreamFamily,
      };
    }
  }
  return null;
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
