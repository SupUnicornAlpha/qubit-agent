import { describe, expect, test } from "bun:test";
import { normalizeInstrument } from "./asset-lifecycle-model";
import {
  closeFuturesContracts,
  futuresMarginRequirements,
  futuresPositionEquity,
  openFuturesContracts,
  settleFuturesPosition,
} from "./futures-margin-model";

const spec = normalizeInstrument("ES", {
  ES: {
    assetClass: "future",
    contractMultiplier: 50,
    lotSize: 1,
    expiryDate: "2026-03-20",
    settlementMode: "cash",
    initialMarginRate: 0.1,
    maintenanceMarginRate: 0.08,
  },
});

describe("futures margin model", () => {
  test("posts initial margin instead of consuming full notional", () => {
    const requirements = futuresMarginRequirements(2, 5_000, spec);
    expect(requirements).toEqual({ initial: 50_000, maintenance: 40_000 });
    const opened = openFuturesContracts(undefined, 2, 5_000, spec);
    expect(opened.cashDelta).toBe(-50_000);
    expect(futuresPositionEquity(opened.position, 5_000, spec)).toBe(50_000);
  });

  test("variation margin realizes daily PnL and closing releases margin", () => {
    const opened = openFuturesContracts(undefined, 2, 5_000, spec);
    const settled = settleFuturesPosition(opened.position, 5_020, spec);
    expect(settled.variationPnl).toBe(2_000);
    const closed = closeFuturesContracts(settled.position, 2, 5_020, spec);
    expect(closed.position).toBeNull();
    expect(closed.cashDelta).toBe(52_000);
  });
});
