import type { OptionChain, OptionContract } from "../api/types";

export type OptionStrategyKind =
  | "single"
  | "long_strangle"
  | "short_strangle"
  | "bull_call_spread"
  | "bear_put_spread"
  | "straddle"
  | "covered_call"
  | "collar"
  | "calendar"
  | "diagonal"
  | "butterfly"
  | "condor"
  | "iron_butterfly"
  | "iron_condor"
  | "custom";

export interface OptionStrategyConfig {
  kind: OptionStrategyKind;
  centerStrike: number | null;
  wingSteps: number;
  singleRight: "call" | "put";
  singleSide: "buy" | "sell";
}

export interface OptionStrategyLeg {
  action: "buy" | "sell";
  contract: OptionContract;
  price: number | null;
}

export interface OptionStrategyEstimate {
  legs: OptionStrategyLeg[];
  centerStrike: number | null;
  netDebit: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number };
  breakEvens: number[];
  scenarioPnl: Array<{ label: string; price: number; pnl: number | null }>;
}

export const OPTION_STRATEGY_OPTIONS: Array<{ value: OptionStrategyKind; label: string; description: string }> = [
  { value: "single", label: "单腿策略", description: "按所选 Call / Put 建立单一多头或空头腿" },
  { value: "bull_call_spread", label: "垂直策略", description: "默认牛市 Call 垂直价差，可在 Agent 中传 direction 调整" },
  { value: "covered_call", label: "股票担保", description: "持有正股并卖出 Call 的备兑策略" },
  { value: "collar", label: "领式策略", description: "正股 + 保护性 Put + 卖出 Call" },
  { value: "straddle", label: "跨式策略", description: "同一行权价买入 Call 与 Put" },
  { value: "long_strangle", label: "宽跨式策略", description: "买入价外 Call + Put，受益于大幅波动" },
  { value: "calendar", label: "日历策略", description: "近月卖出、远月买入同一行权价期权" },
  { value: "diagonal", label: "对角策略", description: "跨到期日且跨行权价的价差策略" },
  { value: "butterfly", label: "蝶式策略", description: "有限风险、有限收益的三档行权价结构" },
  { value: "condor", label: "鹰式策略", description: "有限风险、有限收益的四档行权价结构" },
  { value: "iron_butterfly", label: "铁蝶式策略", description: "Call/Put 组合的有限风险收权利金结构" },
  { value: "iron_condor", label: "铁鹰式策略", description: "两组价差组成的有限风险收权利金结构" },
  { value: "custom", label: "自定义策略", description: "由 Agent 工具接收明确的 legs 参数进行计算" },
];

const contractPrice = (contract: OptionContract, action: OptionStrategyLeg["action"]): number | null => {
  const preferred = action === "buy" ? contract.ask : contract.bid;
  if (preferred != null && Number.isFinite(preferred) && preferred >= 0) return preferred;
  if (contract.lastPrice != null && Number.isFinite(contract.lastPrice) && contract.lastPrice >= 0) return contract.lastPrice;
  const opposite = action === "buy" ? contract.bid : contract.ask;
  return opposite != null && Number.isFinite(opposite) && opposite >= 0 ? opposite : null;
};

const uniqueStrikes = (chain: OptionChain) => [...new Set([...chain.calls, ...chain.puts].map(({ strike }) => strike))]
  .filter((strike) => Number.isFinite(strike))
  .sort((left, right) => left - right);

export function nearestOptionStrike(chain: OptionChain, spot: number | null): number | null {
  const strikes = uniqueStrikes(chain);
  if (strikes.length === 0) return null;
  const anchor = spot != null && Number.isFinite(spot) ? spot : strikes[Math.floor(strikes.length / 2)];
  return strikes.reduce((best, strike) => Math.abs(strike - anchor) < Math.abs(best - anchor) ? strike : best, strikes[0]);
}

export function optionStrategyStrikes(chain: OptionChain): number[] {
  return uniqueStrikes(chain);
}

export function deriveOptionStrategy(
  chain: OptionChain,
  spot: number | null,
  config: OptionStrategyConfig,
): OptionStrategyEstimate {
  const strikes = uniqueStrikes(chain);
  const centerStrike = strikes.includes(config.centerStrike ?? Number.NaN)
    ? config.centerStrike
    : nearestOptionStrike(chain, spot);
  const centerIndex = centerStrike == null ? -1 : strikes.indexOf(centerStrike);
  const wingSteps = Math.max(1, Math.min(Math.round(config.wingSteps), Math.max(1, strikes.length - 1)));
  const lowerStrike = centerIndex < 0 ? null : strikes[Math.max(0, centerIndex - wingSteps)];
  const upperStrike = centerIndex < 0 ? null : strikes[Math.min(strikes.length - 1, centerIndex + wingSteps)];
  const find = (right: OptionContract["right"], strike: number | null) =>
    strike == null ? undefined : (right === "call" ? chain.calls : chain.puts).find((contract) => contract.strike === strike);
  const rawLegs: Array<{ action: OptionStrategyLeg["action"]; contract?: OptionContract }> = [];

  switch (config.kind) {
    case "single":
      rawLegs.push({ action: config.singleSide, contract: find(config.singleRight, centerStrike) });
      break;
    case "long_strangle":
      rawLegs.push({ action: "buy", contract: find("put", lowerStrike) }, { action: "buy", contract: find("call", upperStrike) });
      break;
    case "short_strangle":
      rawLegs.push({ action: "sell", contract: find("put", lowerStrike) }, { action: "sell", contract: find("call", upperStrike) });
      break;
    case "bull_call_spread":
      rawLegs.push({ action: "buy", contract: find("call", centerStrike) }, { action: "sell", contract: find("call", upperStrike) });
      break;
    case "bear_put_spread":
      rawLegs.push({ action: "buy", contract: find("put", centerStrike) }, { action: "sell", contract: find("put", lowerStrike) });
      break;
    case "straddle":
      rawLegs.push({ action: "buy", contract: find("put", centerStrike) }, { action: "buy", contract: find("call", centerStrike) });
      break;
    default:
      break;
  }

  const legs = rawLegs.flatMap(({ action, contract }) => contract ? [{ action, contract, price: contractPrice(contract, action) }] : []);
  const priced = legs.length === rawLegs.length && legs.every(({ price }) => price != null);
  const netDebit = priced
    ? legs.reduce((total, leg) => total + (leg.action === "buy" ? 1 : -1) * (leg.price as number) * 100, 0)
    : null;
  const greek = (name: "delta" | "gamma" | "theta" | "vega") => legs.reduce((total, leg) =>
    total + (leg.action === "buy" ? 1 : -1) * (leg.contract.greeks?.[name] ?? 0), 0);
  const basePrice = spot != null && Number.isFinite(spot) ? spot : centerStrike ?? 0;
  const expiryPnl = (underlyingPrice: number) => netDebit == null ? null : legs.reduce((total, leg) => {
    const intrinsic = leg.contract.right === "call"
      ? Math.max(0, underlyingPrice - leg.contract.strike)
      : Math.max(0, leg.contract.strike - underlyingPrice);
    return total + (leg.action === "buy" ? 1 : -1) * intrinsic * 100;
  }, -netDebit);
  const scenarioPrices = [Math.max(0, basePrice * 0.9), basePrice, basePrice * 1.1];

  return {
    legs,
    centerStrike,
    netDebit,
    greeks: { delta: greek("delta"), gamma: greek("gamma"), theta: greek("theta"), vega: greek("vega") },
    breakEvens: calculateBreakEvens(legs, netDebit, basePrice),
    scenarioPnl: scenarioPrices.map((price, index) => ({ label: ["-10%", "现价", "+10%"][index], price, pnl: expiryPnl(price) })),
  };
}

function calculateBreakEvens(legs: OptionStrategyLeg[], netDebit: number | null, spot: number): number[] {
  if (netDebit == null || legs.length === 0) return [];
  const strikes = [...new Set(legs.map(({ contract }) => contract.strike))].sort((a, b) => a - b);
  const maxStrike = strikes[strikes.length - 1] ?? spot;
  const points = [0, ...strikes, Math.max(maxStrike * 2, spot * 2, 1)];
  const pnl = (price: number) => legs.reduce((total, leg) => {
    const intrinsic = leg.contract.right === "call" ? Math.max(0, price - leg.contract.strike) : Math.max(0, leg.contract.strike - price);
    return total + (leg.action === "buy" ? 1 : -1) * intrinsic * 100;
  }, -netDebit);
  const roots: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index];
    const right = points[index + 1];
    const leftPnl = pnl(left);
    const rightPnl = pnl(right);
    if (Math.abs(leftPnl) < 0.01) roots.push(left);
    if (leftPnl * rightPnl < 0) roots.push(left + ((0 - leftPnl) / (rightPnl - leftPnl)) * (right - left));
  }
  if (Math.abs(pnl(points[points.length - 1])) < 0.01) roots.push(points[points.length - 1]);
  return roots.filter((root, index) => index === 0 || Math.abs(root - roots[index - 1]) > 0.01);
}
