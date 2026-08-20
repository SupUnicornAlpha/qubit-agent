/**
 * Futu OpenQuote historical OHLCV — Python `connectors.futu` via OpenD.
 *
 * Distinct from the quote WS bridge (`market_bridge.server --provider futu`):
 * history uses OpenQuoteContext.request_history_kline and only needs OpenD + futu-api.
 */

import { join } from "node:path";
import { config } from "../../config";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { PythonConnectorBridgeImpl } from "../../connectors/python-bridge";
import { getPythonConnectorsDir, resolvePythonBin } from "../app-paths";
import { resolveFutuOpenDConfig } from "./futu-runtime";
import type { OptionChain } from "./options-chain";

let bridge: PythonConnectorBridgeImpl | null = null;
let bridgeInit: Promise<PythonConnectorBridgeImpl> | null = null;

/** Cached: enabled Futu broker_account exists (for control-plane credentialsReady). */
let futuAccountConfigured = false;

export function markFutuAccountConfigured(ready: boolean): void {
  futuAccountConfigured = ready;
}

export function isFutuAccountConfiguredCached(): boolean {
  return futuAccountConfigured;
}

function pythonConnectorsDir(): string {
  return getPythonConnectorsDir();
}

function connectorRunnerPath(): string {
  return join(pythonConnectorsDir(), "connector_runner.py");
}

async function getFutuBridge(): Promise<PythonConnectorBridgeImpl> {
  if (bridge) return bridge;
  if (bridgeInit) return bridgeInit;

  bridgeInit = (async () => {
    const openD = await resolveFutuOpenDConfig();
    markFutuAccountConfigured(Boolean(openD));
    const instance = new PythonConnectorBridgeImpl({
      scriptPath: connectorRunnerPath(),
      connectorName: "futu",
      cwd: pythonConnectorsDir(),
      pythonBin: resolvePythonBin(config.dataDir),
      meta: {
        name: "futu-opend-quote",
        version: "1.0.0",
        connectorType: "data",
        capabilities: ["fetch_bars", "fetch_option_chain"],
        assetClasses: ["stock", "option"],
        latencyProfile: "batch",
        description: "Futu OpenQuote historical K-line and option snapshot chain via OpenD",
      },
    });
    await instance.init({
      opendHost: openD?.opendHost ?? process.env.QUBIT_FUTU_OPEND_HOST ?? "127.0.0.1",
      opendPort: openD?.opendPort ?? (Number(process.env.QUBIT_FUTU_OPEND_PORT) || 11111),
    });
    bridge = instance;
    return instance;
  })();

  try {
    return await bridgeInit;
  } catch (e) {
    bridgeInit = null;
    throw e;
  }
}

/** Refresh account cache from OpenD config (no throw). */
export async function refreshFutuAccountCache(): Promise<boolean> {
  try {
    const openD = await resolveFutuOpenDConfig();
    markFutuAccountConfigured(Boolean(openD));
    return Boolean(openD);
  } catch {
    markFutuAccountConfigured(false);
    return false;
  }
}

/** Probe OpenQuote health via Python bridge (no throw). */
export async function probeFutuHistoryAvailable(): Promise<boolean> {
  try {
    const configured = await refreshFutuAccountCache();
    if (!configured && !process.env.QUBIT_FUTU_OPEND_HOST?.trim()) return false;
    const b = await getFutuBridge();
    const hc = await b.healthcheck();
    return hc.status === "healthy";
  } catch {
    return false;
  }
}

export async function fetchFutuBars(params: FetchBarsParams): Promise<BarData[]> {
  const openD = await resolveFutuOpenDConfig();
  markFutuAccountConfigured(Boolean(openD));
  const client = await getFutuBridge();
  const bars = (await client.execute("fetch_bars", {
    symbol: params.symbol,
    exchange: params.exchange || "",
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
    ...(openD ? { opendHost: openD.opendHost, opendPort: openD.opendPort } : {}),
  })) as BarData[];

  let sorted = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const startMs = Date.parse(params.startDate);
  const endMs = Date.parse(params.endDate);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    // Daily bars often land at 00:00Z; keep inclusive window with day slack.
    sorted = sorted.filter((b) => b.timestamp >= startIso && b.timestamp <= endIso);
  }
  return sorted;
}

/**
 * Broker-backed listed option chain through Futu OpenD.
 *
 * The Python connector first obtains the contract universe, then requests
 * current snapshots for those contract codes.  This is intentionally separate
 * from the WebSocket quote bridge: it can return a coherent chain snapshot and
 * fails explicitly when OpenD / the relevant option entitlement is unavailable.
 */
export async function fetchFutuOptionChain(params: {
  symbol: string;
  exchange?: string;
  expiry?: string;
}): Promise<OptionChain> {
  const openD = await resolveFutuOpenDConfig();
  const envHost = process.env.QUBIT_FUTU_OPEND_HOST?.trim();
  if (!openD && !envHost) {
    throw new Error(
      "futu_opend_unavailable: configure a Futu OpenD broker account or QUBIT_FUTU_OPEND_HOST before requesting a broker option chain"
    );
  }
  markFutuAccountConfigured(Boolean(openD || envHost));
  const client = await getFutuBridge();
  return (await client.execute("fetch_option_chain", {
    symbol: params.symbol,
    exchange: params.exchange ?? "US",
    ...(params.expiry?.trim() ? { expiry: params.expiry } : {}),
    ...(openD ? { opendHost: openD.opendHost, opendPort: openD.opendPort } : {}),
  })) as OptionChain;
}
