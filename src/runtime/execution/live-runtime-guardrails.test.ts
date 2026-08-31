import { describe, expect, test } from "bun:test";
import {
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
};

describe("live runtime guardrails", () => {
  test("normalizes an explicit limited-live envelope", () => {
    const parsed = parseLiveRuntimeGuardrails(guardrails);
    expect(parsed).toEqual({ ok: true, guardrails: { ...guardrails, allowedSymbols: ["AAPL"] } });
    expect(assertLiveRuntimeGuardrailsForSymbol(guardrails, "AAPL").maxOrdersPerDay).toBe(3);
  });

  test("fails closed for unlimited, inconsistent, and non-confirmed envelopes", () => {
    expect(parseLiveRuntimeGuardrails({})).toMatchObject({ ok: false });
    expect(
      parseLiveRuntimeGuardrails({ ...guardrails, maxDailyNotionalUsd: 999 })
    ).toMatchObject({ ok: false, error: "live_runtime_guardrails_daily_notional_below_order_notional" });
    expect(() => assertLiveRuntimeGuardrailsForSymbol(guardrails, "NVDA")).toThrow(
      "live_runtime_symbol_not_allowlisted"
    );
  });
});
