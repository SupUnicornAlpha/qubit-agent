import type { BacktestInstrumentSpec, BacktestRequest } from "../provider/types";
import { assessTradingCalendarProvenance } from "./market-calendar-provenance";

export type NormalizedInstrumentSpec = Required<
  Pick<BacktestInstrumentSpec, "assetClass" | "contractMultiplier">
> &
  Omit<BacktestInstrumentSpec, "assetClass" | "contractMultiplier">;

export interface AssetLifecycleCheck {
  symbol: string;
  state: "pass" | "warning" | "fail";
  code: string;
  message: string;
}

export interface AssetLifecycleReport {
  version: "asset-lifecycle-v2";
  status: "passed" | "research_only" | "invalid";
  assetClasses: string[];
  checks: AssetLifecycleCheck[];
  limitations: string[];
}

export interface AssetLifecycleEvent {
  date: string;
  symbol: string;
  kind:
    | "futures_variation_margin"
    | "futures_roll"
    | "futures_margin_call"
    | "futures_forced_liquidation"
    | "delisting_settlement"
    | "expiry_settlement"
    | "perpetual_funding"
    | "option_greeks_snapshot"
    | "order_unfilled_tradability";
  amount: number;
  detail: string;
  optionRisk?: {
    underlyingPrice: number;
    impliedVolatility: number;
    riskFreeRateAnnual: number;
    timeToExpiryYears: number;
    delta: number;
    gamma: number;
    thetaPerDay: number;
    vegaPerPoint: number;
  };
}

export function normalizeInstrument(
  symbol: string,
  instruments?: Record<string, BacktestInstrumentSpec>
): NormalizedInstrumentSpec {
  const raw = instruments?.[symbol];
  return {
    ...(raw ?? { assetClass: "stock" as const }),
    assetClass: raw?.assetClass ?? "stock",
    contractMultiplier: raw?.contractMultiplier ?? 1,
  };
}

export function buildAssetLifecycleReport(input: BacktestRequest): AssetLifecycleReport {
  const checks: AssetLifecycleCheck[] = [];
  const limitations = new Set<string>();
  const assetClasses = new Set<string>();

  for (const symbol of input.symbols) {
    const spec = normalizeInstrument(symbol, input.instruments);
    assetClasses.add(assetClassLabel(spec));

    if (!["stock", "future", "option", "crypto"].includes(spec.assetClass)) {
      checks.push(
        fail(symbol, "invalid_asset_class", `不支持的 assetClass: ${String(spec.assetClass)}`)
      );
    }
    if (spec.contractKind !== undefined && !["spot", "perpetual"].includes(spec.contractKind)) {
      checks.push(
        fail(symbol, "invalid_contract_kind", `不支持的 contractKind: ${String(spec.contractKind)}`)
      );
    }

    if (!Number.isFinite(spec.contractMultiplier) || spec.contractMultiplier <= 0) {
      checks.push(fail(symbol, "invalid_contract_multiplier", "合约乘数必须大于 0"));
    }
    if (spec.lotSize !== undefined && (!Number.isFinite(spec.lotSize) || spec.lotSize <= 0)) {
      checks.push(fail(symbol, "invalid_lot_size", "最小成交数量必须大于 0"));
    }

    if (spec.assetClass === "option") {
      for (const [field, value] of [
        ["expiryDate", spec.expiryDate],
        ["underlyingSymbol", spec.underlyingSymbol],
        ["strike", spec.strike],
        ["optionRight", spec.optionRight],
        ["exerciseStyle", spec.exerciseStyle],
      ] as const) {
        if (value === undefined || value === "") {
          checks.push(fail(symbol, `option_${field}_required`, `期权缺少 ${field}`));
        }
      }
      if (spec.settlementMode !== "cash") {
        checks.push(
          fail(symbol, "physical_option_unsupported", "首版仅支持现金结算期权，不模拟行权交割")
        );
      }
      if (!Number.isFinite(spec.strike) || (spec.strike ?? 0) <= 0) {
        checks.push(fail(symbol, "option_strike_invalid", "期权 strike 必须大于 0"));
      }
      if (spec.expiryDate && !isIsoDate(spec.expiryDate)) {
        checks.push(fail(symbol, "option_expiry_invalid", "期权 expiryDate 必须为 YYYY-MM-DD"));
      }
      if (spec.exerciseStyle === "american") {
        checks.push(fail(symbol, "american_exercise_unsupported", "首版不模拟美式期权提前行权"));
      }
      if (spec.pricingModel !== undefined && spec.pricingModel !== "black_scholes") {
        checks.push(
          fail(symbol, "option_pricing_model_unsupported", "仅支持 black_scholes 风险审计模型")
        );
      }
      limitations.add("option_expiry_uses_snapshot_settlement_price_or_close");
      const optionBars = input.dataset.barsBySymbol[symbol] ?? [];
      const underlyingBars = spec.underlyingSymbol
        ? (input.dataset.barsBySymbol[spec.underlyingSymbol] ?? [])
        : [];
      if (underlyingBars.length === 0) {
        checks.push(
          warning(
            symbol,
            "option_greeks_underlying_snapshot_missing",
            "缺少同快照标的价格，无法审计 Greeks"
          )
        );
        limitations.add("option_greeks_underlying_snapshot_missing");
      }
      if (
        !optionBars.some(
          (bar) => Number.isFinite(bar.impliedVolatility) && (bar.impliedVolatility ?? 0) > 0
        )
      ) {
        checks.push(
          warning(symbol, "option_iv_history_missing", "缺少逐期隐含波动率，无法审计 Greeks")
        );
        limitations.add("option_iv_history_missing");
      }
      if (!optionBars.some((bar) => Number.isFinite(bar.riskFreeRateAnnual))) {
        checks.push(
          warning(symbol, "option_rate_history_missing", "缺少逐期无风险利率，无法审计 Greeks")
        );
        limitations.add("option_rate_history_missing");
      }
    }

    if (spec.assetClass === "future") {
      if (!spec.expiryDate) {
        checks.push(fail(symbol, "future_expiry_required", "期货缺少 expiryDate"));
      }
      if (spec.settlementMode !== "cash") {
        checks.push(
          fail(symbol, "physical_future_unsupported", "首版仅支持现金结算，不模拟实物交割")
        );
      }
      if (spec.expiryDate && !isIsoDate(spec.expiryDate)) {
        checks.push(fail(symbol, "future_expiry_invalid", "期货 expiryDate 必须为 YYYY-MM-DD"));
      }
      if (!validMarginRate(spec.initialMarginRate)) {
        checks.push(
          fail(symbol, "future_initial_margin_required", "期货 initialMarginRate 必须在 (0, 1]")
        );
      }
      if (!validMarginRate(spec.maintenanceMarginRate)) {
        checks.push(
          fail(
            symbol,
            "future_maintenance_margin_required",
            "期货 maintenanceMarginRate 必须在 (0, 1]"
          )
        );
      }
      if (
        validMarginRate(spec.initialMarginRate) &&
        validMarginRate(spec.maintenanceMarginRate) &&
        (spec.maintenanceMarginRate ?? 0) > (spec.initialMarginRate ?? 0)
      ) {
        checks.push(
          fail(symbol, "future_margin_rate_inconsistent", "维持保证金率不得高于初始保证金率")
        );
      }
      if (
        spec.targetLeverage !== undefined &&
        (!Number.isFinite(spec.targetLeverage) ||
          spec.targetLeverage <= 0 ||
          (validMarginRate(spec.initialMarginRate) &&
            spec.targetLeverage > 1 / (spec.initialMarginRate ?? 1)))
      ) {
        checks.push(
          fail(
            symbol,
            "future_target_leverage_invalid",
            "targetLeverage 必须为正且不超过初始保证金允许上限"
          )
        );
      }
      if (spec.futureRoll) {
        const successor = spec.futureRoll.successorSymbol.trim();
        if (!isIsoDate(spec.futureRoll.rollDate)) {
          checks.push(
            fail(symbol, "future_roll_date_invalid", "期货 futureRoll.rollDate 必须为 YYYY-MM-DD")
          );
        }
        if (!successor) {
          checks.push(
            fail(symbol, "future_roll_successor_required", "期货 futureRoll 缺少 successorSymbol")
          );
        } else if (!input.instruments?.[successor]) {
          checks.push(
            fail(
              symbol,
              "future_roll_successor_missing",
              "期货 futureRoll successorSymbol 必须在 instruments 中定义"
            )
          );
        } else if (input.instruments[successor].assetClass !== "future") {
          checks.push(
            fail(
              symbol,
              "future_roll_successor_invalid",
              "期货 futureRoll successorSymbol 必须是期货合约"
            )
          );
        } else if (!input.symbols.includes(successor)) {
          checks.push(
            fail(
              symbol,
              "future_roll_successor_not_in_universe",
              "期货 futureRoll successorSymbol 必须包含在回测 symbols 中"
            )
          );
        }
        if (hasFutureRollCycle(symbol, input.instruments)) {
          checks.push(fail(symbol, "future_roll_cycle", "期货 futureRoll 不得形成循环合约链"));
        }
        if (spec.expiryDate && spec.futureRoll.rollDate >= spec.expiryDate) {
          checks.push(fail(symbol, "future_roll_after_expiry", "期货换月日必须早于 expiryDate"));
        }
        limitations.add("futures_roll_close_open_uses_snapshot_open_prices");
      } else {
        limitations.add("futures_have_daily_variation_margin_but_no_contract_roll_model");
      }
    }

    if (spec.assetClass === "crypto" && spec.contractKind === "perpetual") {
      limitations.add("perpetual_funding_is_applied_only_when_snapshot_bars_supply_rates");
      limitations.add("perpetuals_are_fully_collateralized_without_liquidation");
    }

    if (!checks.some((check) => check.symbol === symbol && check.state === "fail")) {
      checks.push({
        symbol,
        state: input.instruments?.[symbol] ? "pass" : "warning",
        code: input.instruments?.[symbol] ? "contract_valid" : "implicit_stock_contract",
        message: input.instruments?.[symbol]
          ? "合约字段通过首版生命周期校验"
          : "未提供合约定义，按普通股票兼容处理",
      });
      if (!input.instruments?.[symbol]) limitations.add("implicit_stock_contract_metadata");
    }
  }

  const hasTradabilityEvidence = input.symbols.some((symbol) =>
    (input.dataset.barsBySymbol[symbol] ?? []).some(
      (bar) =>
        bar.tradable !== undefined ||
        bar.suspended !== undefined ||
        bar.priceLimitUp !== undefined ||
        bar.priceLimitDown !== undefined
    )
  );
  if (!hasTradabilityEvidence) {
    checks.push(
      warning(
        "*",
        "tradability_flags_missing",
        "快照未提供停牌、可交易状态或涨跌停字段；成交约束按默认可交易假设处理"
      )
    );
    limitations.add("tradability_flags_missing");
  }

  for (const calendarCheck of assessTradingCalendarProvenance(input.dataset.tradingCalendar)) {
    checks.push({ symbol: "*", ...calendarCheck });
    if (calendarCheck.state === "warning") limitations.add(calendarCheck.code);
  }

  const invalid = checks.some((check) => check.state === "fail");
  const researchOnly = limitations.size > 0 || checks.some((check) => check.state === "warning");
  return {
    version: "asset-lifecycle-v2",
    status: invalid ? "invalid" : researchOnly ? "research_only" : "passed",
    assetClasses: Array.from(assetClasses).sort(),
    checks,
    limitations: Array.from(limitations).sort(),
  };
}

function validMarginRate(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 1;
}

function hasFutureRollCycle(
  symbol: string,
  instruments: Record<string, BacktestInstrumentSpec> | undefined
): boolean {
  const visited = new Set<string>();
  let current = symbol;
  while (true) {
    if (visited.has(current)) return true;
    visited.add(current);
    const successor = instruments?.[current]?.futureRoll?.successorSymbol.trim();
    if (!successor) return false;
    current = successor;
  }
}

export function assetClassLabel(spec: NormalizedInstrumentSpec): string {
  if (spec.assetClass === "crypto") return `crypto_${spec.contractKind ?? "spot"}`;
  return spec.assetClass;
}

export function isExpired(spec: NormalizedInstrumentSpec, date: string): boolean {
  return Boolean(spec.expiryDate && date >= spec.expiryDate);
}

export function exposureToQuantity(
  exposure: number,
  price: number,
  spec: NormalizedInstrumentSpec
): number {
  if (!(price > 0)) return 0;
  const raw = exposure / (price * spec.contractMultiplier);
  if (!spec.lotSize) return raw;
  return Math.floor(raw / spec.lotSize) * spec.lotSize;
}

export function contractNotional(
  qty: number,
  price: number,
  spec: NormalizedInstrumentSpec
): number {
  return qty * price * spec.contractMultiplier;
}

export function fundingCashFlow(
  qty: number,
  price: number,
  fundingRateBps: number | undefined,
  spec: NormalizedInstrumentSpec
): number {
  if (
    spec.assetClass !== "crypto" ||
    spec.contractKind !== "perpetual" ||
    !fundingRateBps ||
    qty === 0
  ) {
    return 0;
  }
  // 正资金费：多头支付（负现金流），空头收取（正现金流）。
  return -Math.sign(qty) * Math.abs(contractNotional(qty, price, spec)) * (fundingRateBps / 10_000);
}

function fail(symbol: string, code: string, message: string): AssetLifecycleCheck {
  return { symbol, state: "fail", code, message };
}

function warning(symbol: string, code: string, message: string): AssetLifecycleCheck {
  return { symbol, state: "warning", code, message };
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}
