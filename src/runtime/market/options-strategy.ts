import type { OptionChain, OptionContract } from "./options-chain";

/** Read-only, deterministic option strategy analysis. It never creates an order or position. */
export type OptionStrategyName =
  | "single"
  | "vertical"
  | "covered_call"
  | "collar"
  | "straddle"
  | "strangle"
  | "calendar"
  | "diagonal"
  | "butterfly"
  | "condor"
  | "iron_butterfly"
  | "iron_condor"
  | "custom";

export const OPTION_STRATEGY_NAMES: OptionStrategyName[] = [
  "single", "vertical", "covered_call", "collar", "straddle", "strangle",
  "calendar", "diagonal", "butterfly", "condor", "iron_butterfly", "iron_condor", "custom",
];

export function isOptionStrategyName(value: unknown): value is OptionStrategyName {
  return typeof value === "string" && OPTION_STRATEGY_NAMES.includes(value as OptionStrategyName);
}

export type StrategyLegInput = {
  action: "buy" | "sell";
  right?: "call" | "put";
  strike?: number;
  expiry?: string;
  quantity?: number;
  /** Existing position cost, per underlying share. Omit to use current executable quote. */
  entryPrice?: number;
  /** Only for custom / covered stock strategies. Positive means long shares. */
  underlyingShares?: number;
};

export type OptionStrategyInput = {
  strategy: OptionStrategyName;
  centerStrike?: number;
  widthSteps?: number;
  singleRight?: "call" | "put";
  singleSide?: "buy" | "sell";
  direction?: "bullish" | "bearish";
  quantity?: number;
  /** Explicit legs make the calculator usable for any listed or existing multi-leg position. */
  legs?: StrategyLegInput[];
};

export type ResolvedStrategyLeg = {
  kind: "option" | "underlying";
  action: "buy" | "sell";
  quantity: number;
  contractSymbol?: string;
  right?: "call" | "put";
  strike?: number;
  expiration?: string | null;
  entryPrice: number | null;
  markPrice: number | null;
  greeks?: OptionContract["greeks"];
};

type StrategyResult = {
  strategy: OptionStrategyName;
  legs: ResolvedStrategyLeg[];
  contractMultiplier: number;
  netPremium: number | null;
  markToMarketPnl: number | null;
  expiryBreakEvens: number[];
  expiryScenarios: Array<{ label: string; underlyingPrice: number; pnl: number | null }>;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  risk: { maxProfit: number | null; maxLoss: number | null; profitProbability: null };
  warnings: string[];
};

const MULTIPLIER = 100;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const actionSign = (action: "buy" | "sell") => action === "buy" ? 1 : -1;

const allStrikes = (chains: OptionChain[]) => [...new Set(chains.flatMap((chain) => [...chain.calls, ...chain.puts].map((row) => row.strike)))]
  .filter(Number.isFinite)
  .sort((left, right) => left - right);

function nearestStrike(chains: OptionChain[], spot: number | null, requested?: number): number | null {
  const strikes = allStrikes(chains);
  if (!strikes.length) return null;
  const anchor = finite(requested) ?? finite(spot) ?? strikes[Math.floor(strikes.length / 2)]!;
  return strikes.reduce((best, strike) => Math.abs(strike - anchor) < Math.abs(best - anchor) ? strike : best, strikes[0]!);
}

function selectContract(chain: OptionChain, right: "call" | "put", strike: number | null): OptionContract | undefined {
  if (strike == null) return undefined;
  return (right === "call" ? chain.calls : chain.puts).find((row) => row.strike === strike);
}

function executablePrice(contract: OptionContract, action: "buy" | "sell"): number | null {
  const preferred = action === "buy" ? contract.ask : contract.bid;
  return finite(preferred) ?? finite(contract.lastPrice) ?? finite(action === "buy" ? contract.bid : contract.ask);
}

function markPrice(contract: OptionContract): number | null {
  const bid = finite(contract.bid);
  const ask = finite(contract.ask);
  return bid != null && ask != null ? (bid + ask) / 2 : finite(contract.lastPrice) ?? bid ?? ask;
}

export function analyzeOptionStrategy(input: OptionStrategyInput, chains: OptionChain[], spot: number | null): StrategyResult {
  const warnings: string[] = [];
  const current = chains[0];
  if (!current) throw new Error("option strategy analysis requires at least one option chain");
  const far = chains[1] ?? current;
  if ((input.strategy === "calendar" || input.strategy === "diagonal") && chains.length < 2) {
    warnings.push("日历策略和对角策略需要第二个到期日的期权链。");
  }
  const strikes = allStrikes(chains);
  const center = nearestStrike(chains, spot, input.centerStrike);
  const centerIndex = center == null ? -1 : strikes.indexOf(center);
  const width = Math.max(1, Math.min(Math.round(finite(input.widthSteps) ?? 1), Math.max(1, strikes.length - 1)));
  const strike = (offset: number) => centerIndex < 0 ? null : strikes[Math.max(0, Math.min(strikes.length - 1, centerIndex + offset))] ?? null;
  const quantity = Math.max(1, Math.min(Math.round(finite(input.quantity) ?? 1), 100));
  const templates: StrategyLegInput[] = input.legs?.length ? input.legs : defaultLegs(input, center, strike, quantity);
  if (input.strategy === "custom" && templates.length === 0) {
    warnings.push("自定义策略需要传入 legs；可由 Agent 通过 market.options.strategy_analyze 的 legs 参数构造。");
  }
  const resolved = templates.flatMap((leg) => {
    const qty = Math.max(1, Math.min(Math.round(finite(leg.quantity) ?? quantity), 100));
    if (leg.underlyingShares != null) {
      const shares = finite(leg.underlyingShares);
      return shares == null || shares === 0 ? [] : [{
        kind: "underlying" as const,
        action: shares > 0 ? "buy" as const : "sell" as const,
        quantity: Math.abs(shares),
        entryPrice: finite(leg.entryPrice) ?? finite(spot),
        markPrice: finite(spot),
      }];
    }
    const right = leg.right;
    if (!right) return [];
    const chain = leg.expiry === "far" || (leg.expiry && far.expirations.some((expiry) => expiry.startsWith(leg.expiry))) ? far : current;
    const contract = selectContract(chain, right, leg.strike ?? center);
    if (!contract) {
      warnings.push(`未找到 ${right.toUpperCase()} ${leg.strike ?? center ?? "—"} 的合约`);
      return [];
    }
    const action = leg.action;
    return [{
      kind: "option" as const,
      action,
      quantity: qty,
      contractSymbol: contract.contractSymbol,
      right: contract.right,
      strike: contract.strike,
      expiration: contract.expiration,
      entryPrice: finite(leg.entryPrice) ?? executablePrice(contract, action),
      markPrice: markPrice(contract),
      ...(contract.greeks ? { greeks: contract.greeks } : {}),
    }];
  });
  if (resolved.length !== templates.length) warnings.push("策略腿不完整，部分盈亏指标不可用。");
  const fullyPriced = templates.length > 0 && resolved.length === templates.length && resolved.every((leg) => leg.entryPrice != null);
  const netPremium = fullyPriced ? resolved.reduce((sum, leg) => sum + initialCash(leg), 0) : null;
  const markToMarketPnl = resolved.length === templates.length && resolved.every((leg) => leg.entryPrice != null && leg.markPrice != null)
    ? resolved.reduce((sum, leg) => sum + actionSign(leg.action) * ((leg.markPrice as number) - (leg.entryPrice as number)) * leg.quantity * (leg.kind === "option" ? MULTIPLIER : 1), 0)
    : null;
  const normalizedSpot = finite(spot) ?? center ?? 0;
  const expiryPnl = (underlyingPrice: number) => fullyPriced ? resolved.reduce((sum, leg) => sum + expiryLegValue(leg, underlyingPrice), 0) - (netPremium as number) : null;
  const breakEvens = calculateBreakEvens(resolved, netPremium, normalizedSpot);
  const scenarioPrices = [Math.max(0, normalizedSpot * 0.9), normalizedSpot, normalizedSpot * 1.1];
  const scenarioValues = scenarioPrices.map((price, index) => ({ label: ["-10%", "现价", "+10%"][index]!, underlyingPrice: price, pnl: expiryPnl(price) }));
  const risk = calculateRisk(resolved, netPremium, normalizedSpot, expiryPnl);
  const greek = (name: "delta" | "gamma" | "theta" | "vega") => resolved.reduce((sum, leg) => {
    if (leg.kind === "underlying") return name === "delta" ? sum + actionSign(leg.action) * leg.quantity : sum;
    return sum + actionSign(leg.action) * leg.quantity * (leg.greeks?.[name] ?? 0);
  }, 0);
  return {
    strategy: input.strategy,
    legs: resolved,
    contractMultiplier: MULTIPLIER,
    netPremium,
    markToMarketPnl,
    expiryBreakEvens: breakEvens,
    expiryScenarios: scenarioValues,
    greeks: { delta: greek("delta"), gamma: greek("gamma"), theta: greek("theta"), vega: greek("vega") },
    risk: { ...risk, profitProbability: null },
    warnings,
  };
}

function defaultLegs(input: OptionStrategyInput, center: number | null, strike: (offset: number) => number | null, quantity: number): StrategyLegInput[] {
  const bullish = input.direction !== "bearish";
  const option = (action: "buy" | "sell", right: "call" | "put", offset = 0, expiry?: string): StrategyLegInput => ({ action, right, strike: strike(offset) ?? center ?? undefined, quantity, ...(expiry ? { expiry } : {}) });
  switch (input.strategy) {
    case "single": return [option(input.singleSide ?? "buy", input.singleRight ?? "call")];
    case "vertical": return bullish ? [option("buy", "call"), option("sell", "call", 1)] : [option("buy", "put"), option("sell", "put", -1)];
    case "covered_call": return [{ action: "buy", underlyingShares: quantity * MULTIPLIER }, option("sell", "call", 1)];
    case "collar": return [{ action: "buy", underlyingShares: quantity * MULTIPLIER }, option("buy", "put", -1), option("sell", "call", 1)];
    case "straddle": return [option("buy", "put"), option("buy", "call")];
    case "strangle": return [option("buy", "put", -1), option("buy", "call", 1)];
    case "calendar": return [option("sell", input.singleRight ?? "call"), option("buy", input.singleRight ?? "call", 0, "far")];
    case "diagonal": return [option("sell", input.singleRight ?? "call"), option("buy", input.singleRight ?? "call", bullish ? -1 : 1, "far")];
    case "butterfly": return [option("buy", "call", -1), option("sell", "call"), option("sell", "call"), option("buy", "call", 1)];
    case "condor": return [option("buy", "call", -2), option("sell", "call", -1), option("sell", "call", 1), option("buy", "call", 2)];
    case "iron_butterfly": return [option("buy", "put", -1), option("sell", "put"), option("sell", "call"), option("buy", "call", 1)];
    case "iron_condor": return [option("buy", "put", -2), option("sell", "put", -1), option("sell", "call", 1), option("buy", "call", 2)];
    case "custom": return [];
  }
}

function initialCash(leg: ResolvedStrategyLeg): number {
  return actionSign(leg.action) * (leg.entryPrice as number) * leg.quantity * (leg.kind === "option" ? MULTIPLIER : 1);
}

function expiryLegValue(leg: ResolvedStrategyLeg, underlyingPrice: number): number {
  if (leg.kind === "underlying") return actionSign(leg.action) * underlyingPrice * leg.quantity;
  const intrinsic = leg.right === "call" ? Math.max(0, underlyingPrice - (leg.strike ?? 0)) : Math.max(0, (leg.strike ?? 0) - underlyingPrice);
  return actionSign(leg.action) * intrinsic * leg.quantity * MULTIPLIER;
}

function calculateBreakEvens(legs: ResolvedStrategyLeg[], netPremium: number | null, spot: number): number[] {
  if (netPremium == null || !legs.length) return [];
  const strikes = legs.flatMap((leg) => leg.strike == null ? [] : [leg.strike]).sort((a, b) => a - b);
  const end = Math.max((strikes.at(-1) ?? spot) * 2, spot * 2, 1);
  const points = [0, ...strikes, end];
  const pnl = (price: number) => legs.reduce((sum, leg) => sum + expiryLegValue(leg, price), 0) - netPremium;
  const roots: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]!;
    const right = points[index + 1]!;
    const leftPnl = pnl(left);
    const rightPnl = pnl(right);
    if (Math.abs(leftPnl) < 0.01) roots.push(left);
    if (leftPnl * rightPnl < 0) roots.push(left + (-leftPnl / (rightPnl - leftPnl)) * (right - left));
  }
  return roots.filter((value, index) => index === 0 || Math.abs(value - roots[index - 1]!) > 0.01);
}

function calculateRisk(legs: ResolvedStrategyLeg[], netPremium: number | null, spot: number, expiryPnl: (price: number) => number | null) {
  if (netPremium == null) return { maxProfit: null, maxLoss: null };
  const maxStrike = Math.max(spot, ...legs.flatMap((leg) => leg.strike == null ? [] : [leg.strike]));
  const points = [0, ...legs.flatMap((leg) => leg.strike == null ? [] : [leg.strike]), maxStrike * 2];
  const values = points.flatMap((price) => {
    const value = expiryPnl(price);
    return value == null ? [] : [value];
  });
  const hasUnlimitedUp = legs.some((leg) => leg.kind === "option" && leg.action === "sell" && leg.right === "call") && !legs.some((leg) => leg.kind === "underlying" && leg.action === "buy");
  const hasUnlimitedDown = legs.some((leg) => leg.kind === "underlying" && leg.action === "buy");
  return {
    maxProfit: hasUnlimitedUp ? null : Math.max(...values),
    maxLoss: hasUnlimitedUp || hasUnlimitedDown ? null : Math.min(...values),
  };
}
