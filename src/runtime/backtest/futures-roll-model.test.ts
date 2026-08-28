import { describe, expect, test } from "bun:test";
import {
  resolveFutureRollSymbol,
  rollSuccessorQuantity,
  shouldRollFuture,
} from "./futures-roll-model";

describe("futures roll model", () => {
  const instruments = {
    ESH6: {
      assetClass: "future" as const,
      futureRoll: { rollDate: "2026-03-15", successorSymbol: "ESM6" },
    },
    ESM6: {
      assetClass: "future" as const,
      futureRoll: { rollDate: "2026-06-14", successorSymbol: "ESU6" },
    },
    ESU6: { assetClass: "future" as const },
  };

  test("resolves only an explicit roll chain that is effective on the given date", () => {
    expect(resolveFutureRollSymbol("ESH6", "2026-03-14", instruments)).toBe("ESH6");
    expect(resolveFutureRollSymbol("ESH6", "2026-03-15", instruments)).toBe("ESM6");
    expect(resolveFutureRollSymbol("ESH6", "2026-06-14", instruments)).toBe("ESU6");
  });

  test("rolls only on the exact frozen roll date", () => {
    expect(shouldRollFuture(instruments.ESH6, "2026-03-14")).toBe(false);
    expect(shouldRollFuture(instruments.ESH6, "2026-03-15")).toBe(true);
  });

  test("preserves contract exposure but never rounds a successor lot upward", () => {
    expect(
      rollSuccessorQuantity({
        oldQuantity: 1,
        oldMultiplier: 50,
        successorMultiplier: 50,
        successorLotSize: 1,
      })
    ).toBe(1);
    expect(
      rollSuccessorQuantity({
        oldQuantity: -1,
        oldMultiplier: 50,
        successorMultiplier: 100,
        successorLotSize: 1,
      })
    ).toBe(0);
  });
});
