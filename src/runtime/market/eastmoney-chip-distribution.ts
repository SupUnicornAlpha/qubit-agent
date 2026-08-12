import type {
  ChipDistributionData,
  FetchChipDistributionParams,
} from "../../connectors/data/data.connector";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { symbolToEastMoneySecId } from "./eastmoney-klines";
import { marketDataFetch } from "./market-data-network";

const ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const TENCENT_ENDPOINT = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const DELAY_QUOTE_ENDPOINT = "https://push2delay.eastmoney.com/api/qt/stock/get";
const FACTOR = 150;
const RANGE = 120;

interface ChipKline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  turnoverRate: number;
}

function costByChip(xdata: number[], minPrice: number, accuracy: number, target: number): number {
  let total = 0;
  for (let index = 0; index < xdata.length; index += 1) {
    const value = Number(xdata[index]?.toPrecision(12) ?? 0);
    if (total + value > target) return minPrice + index * accuracy;
    total += value;
  }
  return 0;
}

export function computeChipDistributionPoint(
  index: number,
  records: ChipKline[],
  symbol: string,
  exchange: string
): ChipDistributionData {
  const start = Math.max(0, index - RANGE + 1);
  const window = records.slice(start, Math.max(1, index + 1));
  const maxPrice = Math.max(...window.map((row) => row.high));
  const minPrice = Math.min(...window.map((row) => row.low));
  const accuracy = Math.max(0.01, (maxPrice - minPrice) / (FACTOR - 1));
  const xdata = new Array<number>(FACTOR).fill(0);

  for (const row of window) {
    const average = (row.open + row.close + row.high + row.low) / 4;
    const turnoverRate = Math.min(1, Math.max(0, row.turnoverRate / 100 || 0));
    const highIndex = Math.min(
      FACTOR - 1,
      Math.max(0, Math.floor((row.high - minPrice) / accuracy))
    );
    const lowIndex = Math.min(FACTOR - 1, Math.max(0, Math.ceil((row.low - minPrice) / accuracy)));
    const peakIndex = Math.min(
      FACTOR - 1,
      Math.max(0, Math.floor((average - minPrice) / accuracy))
    );
    const peakFactor = row.high === row.low ? FACTOR - 1 : 2 / (row.high - row.low);

    for (let bucket = 0; bucket < FACTOR; bucket += 1) {
      xdata[bucket] = (xdata[bucket] ?? 0) * (1 - turnoverRate);
    }

    if (row.high === row.low) {
      xdata[peakIndex] = (xdata[peakIndex] ?? 0) + (peakFactor * turnoverRate) / 2;
      continue;
    }
    for (let bucket = lowIndex; bucket <= highIndex; bucket += 1) {
      const currentPrice = minPrice + accuracy * bucket;
      let contribution: number;
      if (currentPrice <= average) {
        contribution =
          Math.abs(average - row.low) < 1e-8
            ? peakFactor * turnoverRate
            : ((currentPrice - row.low) / (average - row.low)) * peakFactor * turnoverRate;
      } else {
        contribution =
          Math.abs(row.high - average) < 1e-8
            ? peakFactor * turnoverRate
            : ((row.high - currentPrice) / (row.high - average)) * peakFactor * turnoverRate;
      }
      xdata[bucket] = (xdata[bucket] ?? 0) + contribution;
    }
  }

  const totalChips = xdata.reduce((sum, value) => sum + Number(value.toPrecision(12)), 0);
  const currentPrice = records[index]?.close ?? 0;
  let profitable = 0;
  for (let bucket = 0; bucket < FACTOR; bucket += 1) {
    if (currentPrice >= minPrice + bucket * accuracy) {
      profitable += Number((xdata[bucket] ?? 0).toPrecision(12));
    }
  }

  const percentile = (percent: number) => {
    const lower = costByChip(xdata, minPrice, accuracy, totalChips * ((1 - percent) / 2));
    const upper = costByChip(xdata, minPrice, accuracy, totalChips * ((1 + percent) / 2));
    return {
      lower: Number(lower.toFixed(2)),
      upper: Number(upper.toFixed(2)),
      concentration: lower + upper === 0 ? 0 : (upper - lower) / (lower + upper),
    };
  };
  const range90 = percentile(0.9);
  const range70 = percentile(0.7);
  return {
    symbol,
    exchange: exchange || "UNKNOWN",
    source: "eastmoney_computed",
    date: records[index]?.date ?? "",
    winnerRate: totalChips === 0 ? 0 : profitable / totalChips,
    averageCost: Number(costByChip(xdata, minPrice, accuracy, totalChips * 0.5).toFixed(2)),
    cost90Low: range90.lower,
    cost90High: range90.upper,
    concentration90: range90.concentration,
    cost70Low: range70.lower,
    cost70High: range70.upper,
    concentration70: range70.concentration,
  };
}

function parseKline(row: string): ChipKline | null {
  const parts = row.split(",");
  const parsed: ChipKline = {
    date: parts[0]?.slice(0, 10) ?? "",
    open: Number(parts[1]),
    close: Number(parts[2]),
    high: Number(parts[3]),
    low: Number(parts[4]),
    turnoverRate: Number(parts[10]),
  };
  return [parsed.open, parsed.close, parsed.high, parsed.low].every(Number.isFinite)
    ? parsed
    : null;
}

function tencentSymbol(secid: string): string {
  const [market, code] = secid.split(".", 2);
  return `${market === "1" ? "sh" : "sz"}${code ?? ""}`;
}

async function fetchTencentChipKlines(
  secid: string,
  settings: BuiltinConnectorInitConfigs
): Promise<ChipKline[]> {
  const symbol = tencentSymbol(secid);
  const quoteQuery = new URLSearchParams({
    secid,
    fields: "f85",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    fltt: "2",
  });
  const [quoteResponse, klineResponse] = await Promise.all([
    marketDataFetch("eastmoney", settings, `${DELAY_QUOTE_ENDPOINT}?${quoteQuery.toString()}`, {
      headers: {
        Accept: "application/json",
        Referer: "https://quote.eastmoney.com/",
        "User-Agent": "Mozilla/5.0 (compatible; QubitAgent/1.0)",
      },
    }),
    marketDataFetch(
      "akshare_tencent",
      settings,
      `${TENCENT_ENDPOINT}?param=${symbol},day,,,210,qfq`,
      {
        headers: {
          Accept: "application/json",
          Referer: "https://gu.qq.com/",
          "User-Agent": "Mozilla/5.0 (compatible; QubitAgent/1.0)",
        },
      }
    ),
  ]);
  const quotePayload = (await quoteResponse.json()) as {
    data?: { f85?: number | string };
  };
  const floatShares = Number(quotePayload.data?.f85);
  if (!Number.isFinite(floatShares) || floatShares <= 0) {
    throw new Error("tencent chip fallback missing circulating shares");
  }
  const klinePayload = (await klineResponse.json()) as {
    code?: number;
    data?: Record<string, { qfqday?: string[][]; day?: string[][] }>;
  };
  if (!quoteResponse.ok || !klineResponse.ok || klinePayload.code !== 0) {
    throw new Error(
      `tencent chip fallback HTTP/code ${quoteResponse.status}/${klineResponse.status}/${klinePayload.code}`
    );
  }
  const payload = klinePayload.data?.[symbol];
  const rows = payload?.qfqday ?? payload?.day ?? [];
  return rows
    .map((parts): ChipKline | null => {
      const volumeLots = Number(parts[5]);
      const result: ChipKline = {
        date: parts[0]?.slice(0, 10) ?? "",
        open: Number(parts[1]),
        close: Number(parts[2]),
        high: Number(parts[3]),
        low: Number(parts[4]),
        turnoverRate: (volumeLots * 100 * 100) / floatShares,
      };
      return [result.open, result.close, result.high, result.low, result.turnoverRate].every(
        Number.isFinite
      )
        ? result
        : null;
    })
    .filter((row): row is ChipKline => row !== null);
}

export async function fetchEastMoneyChipDistribution(
  params: FetchChipDistributionParams,
  settings: BuiltinConnectorInitConfigs = {}
): Promise<ChipDistributionData[]> {
  const secid = symbolToEastMoneySecId(params.symbol, params.exchange ?? "");
  if (!secid) throw new Error("eastmoney chip distribution supports China A-share/BJ only");
  const fqt = params.adjustType === "pre" ? "1" : params.adjustType === "post" ? "2" : "0";
  const query = new URLSearchParams({
    secid,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt: "101",
    fqt,
    end: new Date().toISOString().slice(0, 10).replace(/-/g, ""),
    lmt: "210",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
  });
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await marketDataFetch(
        "eastmoney",
        settings,
        `${ENDPOINT}?${query.toString()}`,
        {
          headers: {
            Accept: "application/json",
            Referer: "https://quote.eastmoney.com/",
            "User-Agent": "Mozilla/5.0 (compatible; QubitAgent/1.0)",
          },
        }
      );
      const payload = (await response.json()) as {
        rc?: number;
        data?: { klines?: string[] };
      };
      if (!response.ok || payload.rc !== 0) {
        throw new Error(`eastmoney chip distribution HTTP/rc ${response.status}/${payload.rc}`);
      }
      const records = (payload.data?.klines ?? [])
        .map(parseKline)
        .filter((row): row is ChipKline => row !== null);
      if (records.length === 0) throw new Error("eastmoney chip distribution returned no bars");
      return records
        .map((_, index) =>
          computeChipDistributionPoint(index, records, params.symbol, params.exchange || "UNKNOWN")
        )
        .slice(-90);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  try {
    const records = await fetchTencentChipKlines(secid, settings);
    if (records.length === 0) throw new Error("tencent chip fallback returned no bars");
    return records
      .map((_, index) =>
        computeChipDistributionPoint(index, records, params.symbol, params.exchange || "UNKNOWN")
      )
      .map((row) => ({ ...row, source: "tencent_computed" }))
      .slice(-90);
  } catch (fallbackError) {
    const primary = lastError instanceof Error ? lastError.message : String(lastError);
    const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
    throw new Error(`chip distribution unavailable: eastmoney=${primary}; tencent=${fallback}`);
  }
}
