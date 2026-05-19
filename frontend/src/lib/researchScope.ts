import type { ResearchScopeInput } from "../api/types";

export type ResearchScopeMode = "single" | "basket" | "sector";
export type ResearchInstrumentUi = "equity_long" | "equity_short" | "option";

export function parseSymbolList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，;\s\n]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 24)
    ),
  ];
}

export function buildResearchScopePayload(input: {
  mode: ResearchScopeMode;
  ticker: string;
  basketTickers: string;
  sectorName: string;
  sectorPeers: string;
  instrument: ResearchInstrumentUi;
  optionUnderlying: string;
  optionContract: string;
  optionExpiry: string;
  optionStrike: string;
  optionRight: "call" | "put" | "";
}): ResearchScopeInput | null {
  const instrument = input.instrument === "option" ? "option" : "equity";
  const positionSide = input.instrument === "equity_short" ? "short" : "long";

  if (input.mode === "basket") {
    const symbols = parseSymbolList(input.basketTickers || input.ticker);
    if (symbols.length === 0) return null;
    return { kind: "basket", symbols, instrument, positionSide };
  }

  if (input.mode === "sector") {
    const sector = input.sectorName.trim();
    const peers = parseSymbolList(input.sectorPeers);
    const symbols = peers.length > 0 ? peers : parseSymbolList(input.ticker);
    if (!sector && symbols.length === 0) return null;
    return {
      kind: "sector",
      sector: sector || "未命名板块",
      symbols: symbols.length > 0 ? symbols : undefined,
      peers: symbols,
      instrument,
      positionSide,
    };
  }

  const sym = input.ticker.trim().toUpperCase();
  if (!sym) return null;

  if (instrument === "option") {
    const underlying = (input.optionUnderlying.trim() || sym).toUpperCase();
    const strike = input.optionStrike.trim() ? Number(input.optionStrike) : undefined;
    return {
      kind: "single",
      symbols: [input.optionContract.trim().toUpperCase() || underlying],
      ticker: input.optionContract.trim().toUpperCase() || underlying,
      instrument: "option",
      positionSide: "long",
      option: {
        underlying,
        contractSymbol: input.optionContract.trim() || undefined,
        expiry: input.optionExpiry.trim() || undefined,
        strike: Number.isFinite(strike) ? strike : undefined,
        right: input.optionRight === "put" ? "put" : input.optionRight === "call" ? "call" : undefined,
      },
    };
  }

  return {
    kind: "single",
    symbols: [sym],
    ticker: sym,
    instrument,
    positionSide,
  };
}

export function scopeModeLabel(mode: ResearchScopeMode): string {
  if (mode === "basket") return "多标的篮子";
  if (mode === "sector") return "板块";
  return "单标的";
}

export function instrumentLabel(i: ResearchInstrumentUi): string {
  if (i === "equity_short") return "股票做空";
  if (i === "option") return "期权";
  return "股票多头";
}
