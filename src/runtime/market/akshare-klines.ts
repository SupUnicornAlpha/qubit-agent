import { join } from "node:path";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { PythonConnectorBridgeImpl } from "../../connectors/python-bridge";
import { isChinaAShareMarket } from "./eastmoney-klines";

let bridge: PythonConnectorBridgeImpl | null = null;
let bridgeInit: Promise<PythonConnectorBridgeImpl> | null = null;

function pythonConnectorsDir(): string {
  return join(process.cwd(), "python_connectors");
}

function connectorRunnerPath(): string {
  return join(pythonConnectorsDir(), "connector_runner.py");
}

async function getAkshareBridge(): Promise<PythonConnectorBridgeImpl> {
  if (bridge) return bridge;
  if (bridgeInit) return bridgeInit;

  bridgeInit = (async () => {
    const instance = new PythonConnectorBridgeImpl({
      scriptPath: connectorRunnerPath(),
      connectorName: "akshare",
      cwd: pythonConnectorsDir(),
      meta: {
        name: "akshare-python",
        version: "1.0.0",
        connectorType: "data",
        capabilities: ["fetch_bars"],
        assetClasses: ["stock"],
        latencyProfile: "batch",
        description: "AKShare Python subprocess bridge for A-share OHLCV",
      },
    });
    await instance.init({});
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

/** 探测 AKShare Python 环境是否可用（不抛错）。 */
export async function probeAkshareAvailable(): Promise<boolean> {
  try {
    const b = await getAkshareBridge();
    const hc = await b.healthcheck();
    return hc.status === "healthy";
  } catch {
    return false;
  }
}

/**
 * 通过 Python AKShare 拉取 A 股 OHLCV（免费、需 `pip install akshare pandas`）。
 */
export async function fetchAkshareBars(params: FetchBarsParams): Promise<BarData[]> {
  if (!isChinaAShareMarket(params.symbol, params.exchange || "")) {
    throw new Error("akshare: only China A-share / BJ symbols are supported");
  }

  const client = await getAkshareBridge();
  const bars = (await client.execute("fetch_bars", {
    symbol: params.symbol,
    exchange: params.exchange || "",
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
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
