import { describe, expect, test } from "bun:test";
import {
  assertLiveRuntimeAccountRiskLimits,
  assertLiveRuntimeGuardrailsForSymbol,
  parseLiveRuntimeGuardrails,
} from "./live-runtime-guardrails";

const guardrails = {
  schemaVersion: 1,
  allowedSymbols: ["aapl"],
  maxOrderNotionalUsd: 1_000,
  maxDailyNotionalUsd: 5_000,
  maxOrdersPerDay: 3,
  maxDailyLossUsd: 250,
  requireHumanConfirmation: true,
} as const;

describe("live runtime guardrails", () => {
  test("normalizes an explicit limited-live envelope", () => {
    const parsed = parseLiveRuntimeGuardrails(guardrails);
    expect(parsed).toEqual({ ok: true, guardrails: { ...guardrails, allowedSymbols: ["AAPL"] } });
    expect(assertLiveRuntimeGuardrailsForSymbol(guardrails, "AAPL").maxOrdersPerDay).toBe(3);
  });

  test("fails closed for unlimited, inconsistent, and non-confirmed envelopes", () => {
    expect(parseLiveRuntimeGuardrails({})).toMatchObject({ ok: false });
    expect(parseLiveRuntimeGuardrails({ ...guardrails, maxDailyNotionalUsd: 999 })).toMatchObject({
      ok: false,
      error: "live_runtime_guardrails_daily_notional_below_order_notional",
    });
    expect(() => assertLiveRuntimeGuardrailsForSymbol(guardrails, "NVDA")).toThrow(
      "live_runtime_symbol_not_allowlisted"
    );
  });

  test("requires v2 account limits before a real-money runtime can start", () => {
    expect(() => assertLiveRuntimeAccountRiskLimits(guardrails)).toThrow(
      "live_runtime_account_risk_limits_missing"
    );
    const v2 = {
      ...guardrails,
      schemaVersion: 2 as const,
      accountRisk: {
        currency: "USD" as const,
        minAvailableCashUsd: 1_000,
        maxGrossNotionalUsd: 10_000,
        maxSymbolNotionalUsd: 5_000,
        maxOpenPositions: 4,
      },
    };
    expect(assertLiveRuntimeAccountRiskLimits(v2)).toEqual(v2.accountRisk);
  });
});
