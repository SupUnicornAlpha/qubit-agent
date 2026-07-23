import { join } from "node:path";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { PythonConnectorBridgeImpl } from "../../connectors/python-bridge";
import { config } from "../../config";
import { getPythonConnectorsDir, resolvePythonBin } from "../app-paths";
import {
  type BuiltinConnectorInitConfigs,
  loadBuiltinConnectorSettings,
} from "../config/builtin-connector-settings";
import { marketDataProxyForPython } from "./market-data-network";

/**
 * yfinance Python bridge — sister to `akshare-klines.ts`.
 *
 * Why a Python bridge instead of TS-only HTTP (`yahoo_chart`)?
 *   - yahoo_chart already hits Yahoo's v8 chart endpoint directly and is the
 *     default for OHLCV. We keep it.
 *   - For dividends / earnings / `Ticker.info` we'd otherwise have to
 *     re-implement cookie/crumb + multiple endpoints in TS. yfinance does it.
 *
 * Activation: `klinesDataSource = "yfinance"` in builtin connector settings,
 * or any explicit fetch_{dividends,earnings,asset_info} call. `auto` mode does
 * **not** silently switch to yfinance even if installed (decision §10.3 in
 * docs/ENVIRONMENT_MANAGER_DESIGN.md): we want auto's behavior to stay
 * predictable on a fresh machine without yfinance.
 */

let bridge: PythonConnectorBridgeImpl | null = null;
let bridgeInit: Promise<PythonConnectorBridgeImpl> | null = null;

function pythonConnectorsDir(): string {
  return getPythonConnectorsDir();
}

function connectorRunnerPath(): string {
  return join(pythonConnectorsDir(), "connector_runner.py");
}

async function getYfinanceBridge(): Promise<PythonConnectorBridgeImpl> {
  if (bridge) return bridge;
  if (bridgeInit) return bridgeInit;

  bridgeInit = (async () => {
    const instance = new PythonConnectorBridgeImpl({
      scriptPath: connectorRunnerPath(),
      connectorName: "yfinance",
      cwd: pythonConnectorsDir(),
      pythonBin: resolvePythonBin(config.dataDir),
      meta: {
        name: "yfinance-python",
        version: "1.0.0",
        connectorType: "data",
        capabilities: ["fetch_bars", "fetch_dividends", "fetch_earnings", "fetch_asset_info"],
        assetClasses: ["stock", "crypto"],
        latencyProfile: "batch",
        description: "yfinance Python subprocess bridge for OHLCV / dividends / earnings / asset info",
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

/** 探测 yfinance Python 环境是否可用（不抛错）。 */
export async function probeYfinanceAvailable(): Promise<boolean> {
  try {
    const b = await getYfinanceBridge();
    const hc = await b.healthcheck();
    return hc.status === "healthy";
  } catch {
    return false;
  }
}

/** 通过 Python yfinance 拉取 OHLCV（免费、需 `pip install yfinance pandas`）。 */
export async function fetchYfinanceBars(
  params: FetchBarsParams,
  settings: BuiltinConnectorInitConfigs = {},
): Promise<BarData[]> {
  const client = await getYfinanceBridge();
  const bars = (await client.execute("fetch_bars", {
    symbol: params.symbol,
    exchange: params.exchange || "",
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
    proxyUrl: marketDataProxyForPython(settings, "yfinance"),
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

export interface YfinanceDividendItem {
  date: string;
  amount: number;
}

export interface YfinanceEarningsItem {
  period: string;
  source: "annual_income" | "quarterly_income";
  revenue?: number | null;
  netIncome?: number | null;
  operatingIncome?: number | null;
  eps?: number | null;
}

/**
 * yfinance Ticker.info 的字段白名单（与 Python 端 `ASSET_INFO_WHITELIST` 一致）。
 * 故意把 PII 字段（address1/email/phone）排除在外；扩展前请同步 Python 端。
 */
export interface YfinanceAssetInfo {
  symbol: string;
  yahooSymbol: string;
  shortName?: string;
  longName?: string;
  sector?: string;
  industry?: string;
  country?: string;
  currency?: string;
  marketCap?: number;
  sharesOutstanding?: number;
  beta?: number;
  trailingPE?: number;
  dividendYield?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longBusinessSummary?: string;
  exchange?: string;
  quoteType?: string;
}

export interface YfinanceFetchParams {
  symbol: string;
  exchange?: string;
  startDate?: string;
  endDate?: string;
}

export async function fetchYfinanceDividends(
  params: YfinanceFetchParams
): Promise<YfinanceDividendItem[]> {
  const client = await getYfinanceBridge();
  const settings = await loadBuiltinConnectorSettings();
  return (await client.execute("fetch_dividends", {
    symbol: params.symbol,
    exchange: params.exchange ?? "",
    startDate: params.startDate ?? "",
    endDate: params.endDate ?? "",
    proxyUrl: marketDataProxyForPython(settings, "yfinance"),
  })) as YfinanceDividendItem[];
}

export async function fetchYfinanceEarnings(
  params: YfinanceFetchParams
): Promise<YfinanceEarningsItem[]> {
  const client = await getYfinanceBridge();
  const settings = await loadBuiltinConnectorSettings();
  return (await client.execute("fetch_earnings", {
    symbol: params.symbol,
    exchange: params.exchange ?? "",
    proxyUrl: marketDataProxyForPython(settings, "yfinance"),
  })) as YfinanceEarningsItem[];
}

export async function fetchYfinanceAssetInfo(
  params: YfinanceFetchParams
): Promise<YfinanceAssetInfo> {
  const client = await getYfinanceBridge();
  const settings = await loadBuiltinConnectorSettings();
  return (await client.execute("fetch_asset_info", {
    symbol: params.symbol,
    exchange: params.exchange ?? "",
    proxyUrl: marketDataProxyForPython(settings, "yfinance"),
  })) as YfinanceAssetInfo;
}
