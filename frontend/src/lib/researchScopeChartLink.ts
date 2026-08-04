import {
  coerceChartMarketExchange,
  guessChartExchangeFromSymbol,
} from "./chartSpec";
import { parseSymbolList, type ResearchInstrumentUi, type ResearchScopeMode } from "./researchScope";

/** 从研究左栏范围抽出应联动到画布的主标的。 */
export function primarySymbolFromResearchScope(input: {
  mode: ResearchScopeMode;
  ticker: string;
  basketTickers: string;
  sectorPeers: string;
  exploreCandidates?: string;
  instrument: ResearchInstrumentUi;
  optionUnderlying: string;
}): string | null {
  if (input.mode === "single") {
    if (input.instrument === "option") {
      const u = (input.optionUnderlying || input.ticker).trim().toUpperCase();
      return u || null;
    }
    const s = input.ticker.trim().toUpperCase();
    return s || null;
  }
  if (input.mode === "basket") {
    return parseSymbolList(input.basketTickers || input.ticker)[0] ?? null;
  }
  if (input.mode === "sector") {
    return parseSymbolList(input.sectorPeers)[0] ?? parseSymbolList(input.ticker)[0] ?? null;
  }
  return parseSymbolList(input.exploreCandidates ?? "")[0] ?? null;
}

export function chartPatchFromResearchScope(input: {
  mode: ResearchScopeMode;
  ticker: string;
  basketTickers: string;
  sectorPeers: string;
  exploreCandidates?: string;
  instrument: ResearchInstrumentUi;
  optionUnderlying: string;
}): { symbol: string; exchange: string } | null {
  const symbol = primarySymbolFromResearchScope(input);
  if (!symbol) return null;
  return {
    symbol,
    exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(symbol)),
  };
}
