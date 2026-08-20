import type { StrategyManifestV2 } from "../api/backend";

export type StrategyChartCompatibility = {
  compatible: boolean;
  scope: "symbol" | "portfolio" | "basket" | "unknown";
  reason: string;
  universeLabel: string;
  strategyTimeframe: string;
};

function normalizeMarket(value: string): string {
  const market = value.trim().toUpperCase();
  if (["NASDAQ", "NYSE", "AMEX", "ARCA", "OPRA", "OCC"].includes(market)) return "US";
  if (["HKEX"].includes(market)) return "HK";
  if (["SH", "SZ", "SSE", "SZSE", "XSHG", "XSHE"].includes(market)) return "CN";
  return market || "UNKNOWN";
}

function normalizeTimeframe(value: string): string {
  const timeframe = value.trim().toLowerCase();
  return timeframe === "d" ? "1d" : timeframe === "w" ? "1w" : timeframe;
}

function instrumentKey(market: string, symbol: string): string {
  return `${normalizeMarket(market)}:${symbol.trim().toUpperCase()}`;
}

function metadataMembers(metadata: Record<string, unknown> | undefined): string[] {
  const raw = metadata?.members ?? metadata?.instruments ?? metadata?.constituents;
  return Array.isArray(raw) ? raw.map(String).map((value) => value.trim()).filter(Boolean) : [];
}

function metadataInstrument(metadata: Record<string, unknown> | undefined): string | null {
  const raw = metadata?.backtestInstrument ?? metadata?.chartInstrument;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * 回测只能使用策略声明范围内、且与主订阅周期相同的当前图表 K 线。
 * 股票池 / 板块策略需要声明 `metadata.backtestInstrument`（例如 US:SOXX）作为
 * 单序列回测代理；成员列表只用于说明范围，不能把单个成员 K 线当作篮子回测。
 */
export function assessStrategyChartCompatibility(input: {
  manifest: StrategyManifestV2;
  symbol: string;
  exchange: string;
  timeframe: string;
}): StrategyChartCompatibility {
  const { manifest } = input;
  const chartInstrument = instrumentKey(input.exchange, input.symbol);
  const strategyTimeframe = normalizeTimeframe(manifest.primaryFrequency || "1d");
  const timeframeMatches = strategyTimeframe === normalizeTimeframe(input.timeframe);
  const instruments = manifest.universe.instruments ?? [];
  const staticMembers = instruments.map((item) => instrumentKey(item.market, item.symbol));
  const explicitMembers = metadataMembers(manifest.metadata).map((value) => {
    const [market, symbol] = value.includes(":") ? value.split(":", 2) : [input.exchange, value];
    return instrumentKey(market, symbol);
  });
  const universeLabel = instruments.map((item) => item.instrumentId).join(", ") || "未声明";
  const hasBasket = instruments.some((item) => /^(POOL|SECTOR|INDEX):/i.test(item.instrumentId));
  const hasComposite = hasBasket || instruments.length > 1;
  const memberMatches = [...staticMembers, ...explicitMembers].includes(chartInstrument);
  const basketProxy = metadataInstrument(manifest.metadata);
  const basketProxyMatches = basketProxy
    ? (() => {
        const [market, symbol] = basketProxy.includes(":")
          ? basketProxy.split(":", 2)
          : [input.exchange, basketProxy];
        return instrumentKey(market, symbol) === chartInstrument;
      })()
    : false;

  if (!timeframeMatches) {
    return {
      compatible: false,
      scope: hasBasket ? "basket" : hasComposite ? "portfolio" : "symbol",
      reason: `策略主周期为 ${manifest.primaryFrequency}，当前图表为 ${input.timeframe}；请切换到策略周期后再回测。`,
      universeLabel,
      strategyTimeframe,
    };
  }
  if (hasComposite && basketProxyMatches) {
    return {
      compatible: true,
      scope: hasBasket ? "basket" : "portfolio",
      reason: `当前 K 线是策略声明的单序列回测代理（${basketProxy}）。`,
      universeLabel,
      strategyTimeframe,
    };
  }
  if (!hasComposite && memberMatches) {
    return {
      compatible: true,
      scope: "symbol",
      reason: "当前标的与策略 Universe 匹配。",
      universeLabel,
      strategyTimeframe,
    };
  }
  if (hasComposite) {
    return {
      compatible: false,
      scope: hasBasket ? "basket" : "portfolio",
      reason: memberMatches
        ? "当前标的是策略成员，但单只 K 线不能替代组合回测；请切换到 metadata.backtestInstrument 指定的代理标的。"
        : "策略是组合/板块范围；请切换到 metadata.backtestInstrument 指定的代理标的后再回测。",
      universeLabel,
      strategyTimeframe,
    };
  }
  return {
    compatible: false,
    scope: "symbol",
    reason: `当前图表 ${chartInstrument} 不在策略 Universe（${universeLabel}）中。`,
    universeLabel,
    strategyTimeframe,
  };
}
