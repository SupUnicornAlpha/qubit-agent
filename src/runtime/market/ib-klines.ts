/**
 * IB historical OHLCV — Python `connectors.ib` via TWS / IB Gateway.
 *
 * Distinct from the quote WS bridge stub (`market_bridge --provider ib`):
 * history uses ib_insync reqHistoricalData.
 */

import { join } from "node:path";
import { config } from "../../config";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { PythonConnectorBridgeImpl } from "../../connectors/python-bridge";
import { getPythonConnectorsDir, resolvePythonBin } from "../app-paths";
import { resolveIbGatewayConfig } from "./ib-runtime";

let bridge: PythonConnectorBridgeImpl | null = null;
let bridgeInit: Promise<PythonConnectorBridgeImpl> | null = null;

let ibAccountConfigured = false;

export function markIbAccountConfigured(ready: boolean): void {
  ibAccountConfigured = ready;
}

export function isIbAccountConfiguredCached(): boolean {
  return ibAccountConfigured;
}

function connectorRunnerPath(): string {
  return join(getPythonConnectorsDir(), "connector_runner.py");
}

async function getIbBridge(): Promise<PythonConnectorBridgeImpl> {
  if (bridge) return bridge;
  if (bridgeInit) return bridgeInit;

  bridgeInit = (async () => {
    const gw = await resolveIbGatewayConfig();
    markIbAccountConfigured(Boolean(gw) || Boolean(process.env.QUBIT_IB_HOST?.trim()));
    const instance = new PythonConnectorBridgeImpl({
      scriptPath: connectorRunnerPath(),
      connectorName: "ib",
      cwd: getPythonConnectorsDir(),
      pythonBin: resolvePythonBin(config.dataDir),
      meta: {
        name: "ib-history",
        version: "1.0.0",
        connectorType: "data",
        capabilities: ["fetch_bars"],
        assetClasses: ["stock"],
        latencyProfile: "batch",
        description: "IB TWS/Gateway historical K-line via ib_insync",
      },
    });
    await instance.init({
      host: gw?.host ?? process.env.QUBIT_IB_HOST ?? "127.0.0.1",
      port: gw?.port ?? (Number(process.env.QUBIT_IB_PORT) || 7497),
      clientId: gw?.clientId ?? (Number(process.env.QUBIT_IB_CLIENT_ID) || 1),
      historyClientId:
        gw?.historyClientId ??
        (Number(process.env.QUBIT_IB_HISTORY_CLIENT_ID) ||
          (Number(process.env.QUBIT_IB_CLIENT_ID) || 1) + 50),
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

export async function refreshIbAccountCache(): Promise<boolean> {
  try {
    const gw = await resolveIbGatewayConfig();
    const ready = Boolean(gw) || Boolean(process.env.QUBIT_IB_HOST?.trim());
    markIbAccountConfigured(ready);
    return ready;
  } catch {
    markIbAccountConfigured(false);
    return false;
  }
}

export async function probeIbHistoryAvailable(): Promise<boolean> {
  try {
    const configured = await refreshIbAccountCache();
    if (!configured) return false;
    const b = await getIbBridge();
    const hc = await b.healthcheck();
    return hc.status === "healthy";
  } catch {
    return false;
  }
}

export async function fetchIbBars(params: FetchBarsParams): Promise<BarData[]> {
  const gw = await resolveIbGatewayConfig();
  markIbAccountConfigured(Boolean(gw) || Boolean(process.env.QUBIT_IB_HOST?.trim()));
  const client = await getIbBridge();
  const bars = (await client.execute("fetch_bars", {
    symbol: params.symbol,
    exchange: params.exchange || "",
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
    ...(gw
      ? {
          host: gw.host,
          port: gw.port,
          clientId: gw.clientId,
          historyClientId: gw.historyClientId,
        }
      : {}),
  })) as BarData[];

  let sorted = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const startMs = Date.parse(params.startDate);
  const endMs = Date.parse(params.endDate);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    sorted = sorted.filter((b) => b.timestamp >= startIso && b.timestamp <= endIso);
  }
  return sorted;
}
