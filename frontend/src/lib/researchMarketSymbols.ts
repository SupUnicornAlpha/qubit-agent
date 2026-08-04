/**
 * 研究画布行情网格：汇总应展示的多标的列表。
 * 来源：当前 chartSpec + 左栏研究范围 + 工具联动命中的行情标的。
 */
import {
  coerceChartMarketExchange,
  guessChartExchangeFromSymbol,
} from "./chartSpec";
import { parseSymbolList, type ResearchInstrumentUi, type ResearchScopeMode } from "./researchScope";
import type { ResearchCanvasToolHit } from "./researchCanvasToolLink";

export type ResearchMarketSymbol = {
  symbol: string;
  exchange: string;
  /** 列表排序优先：focus / scope / tool */
  source: "focus" | "scope" | "tool";
};

function keyOf(symbol: string, exchange: string): string {
  return `${symbol.toUpperCase()}@@${exchange.toUpperCase()}`;
}

function pushUnique(
  out: ResearchMarketSymbol[],
  seen: Set<string>,
  symbol: string,
  exchange: string,
  source: ResearchMarketSymbol["source"]
): void {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return;
  const ex = coerceChartMarketExchange(exchange || guessChartExchangeFromSymbol(sym));
  const k = keyOf(sym, ex);
  if (seen.has(k)) return;
  seen.add(k);
  out.push({ symbol: sym, exchange: ex, source });
}

/** 从研究范围抽出全部候选标的（篮子/板块/探索候选完整列表）。 */
export function symbolsFromResearchScope(input: {
  mode: ResearchScopeMode;
  ticker: string;
  basketTickers: string;
  sectorPeers: string;
  exploreCandidates?: string;
  instrument: ResearchInstrumentUi;
  optionUnderlying: string;
}): Array<{ symbol: string; exchange: string }> {
  const list: string[] = [];
  if (input.mode === "single") {
    if (input.instrument === "option") {
      const u = (input.optionUnderlying || input.ticker).trim().toUpperCase();
      if (u) list.push(u);
    } else {
      const s = input.ticker.trim().toUpperCase();
      if (s) list.push(s);
    }
  } else if (input.mode === "basket") {
    list.push(...parseSymbolList(input.basketTickers || input.ticker));
  } else if (input.mode === "sector") {
    list.push(...parseSymbolList(input.sectorPeers));
    list.push(...parseSymbolList(input.ticker));
  } else {
    list.push(...parseSymbolList(input.exploreCandidates ?? ""));
  }
  const uniq = [...new Set(list)];
  return uniq.map((symbol) => ({
    symbol,
    exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(symbol)),
  }));
}

export function buildResearchMarketSymbolList(input: {
  focusSymbol?: string | null;
  focusExchange?: string | null;
  scope: {
    mode: ResearchScopeMode;
    ticker: string;
    basketTickers: string;
    sectorPeers: string;
    exploreCandidates?: string;
    instrument: ResearchInstrumentUi;
    optionUnderlying: string;
  };
  toolHits?: ResearchCanvasToolHit[] | null;
  /** 上限，避免网格爆炸；默认 8 */
  limit?: number;
}): ResearchMarketSymbol[] {
  const limit = Math.max(1, input.limit ?? 8);
  const out: ResearchMarketSymbol[] = [];
  const seen = new Set<string>();

  if (input.focusSymbol?.trim()) {
    pushUnique(
      out,
      seen,
      input.focusSymbol,
      input.focusExchange ?? "",
      "focus"
    );
  }

  for (const row of symbolsFromResearchScope(input.scope)) {
    pushUnique(out, seen, row.symbol, row.exchange, "scope");
    if (out.length >= limit) return out;
  }

  for (const hit of input.toolHits ?? []) {
    if (hit.kind !== "market" && hit.kind !== "news") continue;
    if (!hit.symbol) continue;
    pushUnique(out, seen, hit.symbol, hit.exchange ?? "", "tool");
    if (out.length >= limit) return out;
  }

  return out;
}
