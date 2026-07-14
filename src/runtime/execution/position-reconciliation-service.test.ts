import { describe, expect, test } from "bun:test";
import {
  buildPositionRemediationPlan,
  positionReconciliationSeverity,
  reconcilePositions,
} from "./position-reconciliation-service";

describe("reconcilePositions", () => {
  test("matches internal fills with broker positions", () => {
    const rows = reconcilePositions(
      [
        { symbol: "AAPL", side: "buy", qty: 10, price: 100 },
        { symbol: "AAPL", side: "buy", qty: 5, price: 110 },
      ],
      [{ symbol: "AAPL", qty: 15, avgPrice: 103.333333 }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.internalQty).toBe(15);
    expect(rows[0]?.internalAvgPrice).toBeCloseTo(103.333333, 5);
    expect(rows[0]?.matched).toBe(true);
  });

  test("reports missing and extra broker positions", () => {
    const rows = reconcilePositions(
      [{ symbol: "AAPL", side: "buy", qty: 10, price: 100 }],
      [{ symbol: "MSFT", qty: 4, avgPrice: 200 }],
    );
    expect(rows.map((row) => row.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(rows.every((row) => !row.matched)).toBe(true);
    expect(rows.find((row) => row.symbol === "AAPL")?.quantityDelta).toBe(-10);
    expect(rows.find((row) => row.symbol === "MSFT")?.quantityDelta).toBe(4);
  });

  test("partial close keeps entry average and reversal resets it", () => {
    const partial = reconcilePositions(
      [
        { symbol: "AAPL", side: "buy", qty: 10, price: 100 },
        { symbol: "AAPL", side: "sell", qty: 4, price: 120 },
      ],
      [{ symbol: "AAPL", qty: 6, avgPrice: 100 }],
    );
    expect(partial[0]?.internalAvgPrice).toBe(100);
    expect(partial[0]?.matched).toBe(true);

    const reversed = reconcilePositions(
      [
        { symbol: "AAPL", side: "buy", qty: 10, price: 100 },
        { symbol: "AAPL", side: "sell", qty: 15, price: 120 },
      ],
      [{ symbol: "AAPL", qty: -5, avgPrice: 120 }],
    );
    expect(reversed[0]?.internalQty).toBe(-5);
    expect(reversed[0]?.internalAvgPrice).toBe(120);
    expect(reversed[0]?.matched).toBe(true);
  });

  test("grades reconciliation severity", () => {
    expect(
      positionReconciliationSeverity({ mismatched: 1, symbols: 10, absoluteNotionalDelta: 100 }),
    ).toBe("warn");
    expect(
      positionReconciliationSeverity({ mismatched: 3, symbols: 10, absoluteNotionalDelta: 100 }),
    ).toBe("error");
    expect(
      positionReconciliationSeverity({ mismatched: 1, symbols: 2, absoluteNotionalDelta: 100 }),
    ).toBe("critical");
  });

  test("generates approval-only remediation actions", () => {
    const rows = reconcilePositions(
      [{ symbol: "AAA", side: "buy", qty: 10, price: 100 }],
      [{ symbol: "AAA", qty: 12, avgPrice: 100 }],
    );
    const remediation = buildPositionRemediationPlan({
      projectId: "p",
      provider: "futu",
      accountRef: null,
      asof: new Date().toISOString(),
      summary: { symbols: 1, matched: 0, mismatched: 1, matchRate: 0, absoluteNotionalDelta: 200 },
      rows,
    });
    expect(remediation.actions[0]).toMatchObject({
      symbol: "AAA", action: "sell", quantity: 2, requiresApproval: true,
    });
    expect(remediation.autoExecuted).toBe(false);
    expect(remediation.planHash).toHaveLength(64);
  });
});
