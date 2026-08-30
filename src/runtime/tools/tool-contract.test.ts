import { describe, expect, test } from "bun:test";
import { applyToolContract } from "./tool-contract";
import { getToolContract, listRegisteredToolContracts } from "./tool-contract-registry";

describe("ToolContract registry (market P0)", () => {
  test("registers market family contracts", () => {
    const names = listRegisteredToolContracts()
      .map((c) => c.name)
      .sort();
    expect(names).toContain("fetch_quote");
    expect(names).toContain("market.resolve_symbol");
    expect(names).toContain("fetch_klines");
    expect(names).toContain("market.snapshot.get");
  });

  test("fetch_quote normalizes symbols[] from DB-failing payload", () => {
    const contract = getToolContract("fetch_quote");
    expect(contract).toBeDefined();
    const canonical = applyToolContract(contract!, {
      symbols: ["603986.SH", "002384.SZ"],
    });
    expect(canonical.symbols).toEqual(["603986.SH", "002384.SZ"]);
    expect(canonical.symbol).toBe("603986.SH");
  });

  test("market.snapshot.get accepts snapshotId without symbols", () => {
    const contract = getToolContract("market.snapshot.get");
    expect(contract).toBeDefined();
    const canonical = applyToolContract(contract!, {
      snapshotId: "mkt_snapshot_abc",
    });
    expect(canonical.snapshotId).toBe("mkt_snapshot_abc");
  });

  test("empty params → missing_symbol", () => {
    const contract = getToolContract("market.resolve_symbol");
    expect(() => applyToolContract(contract!, {})).toThrow(/missing_symbol/);
  });

  test("factor.mine.llm rejects undersized expression batches before execution", () => {
    const contract = getToolContract("factor.mine.llm")!;
    expect(() =>
      applyToolContract(contract, {
        expressions: ["close/Ref(close,20)-1"],
        symbols: ["AAPL", "MSFT", "NVDA"],
        start_date: "2024-01-01",
        end_date: "2025-01-01",
      })
    ).toThrow(/factor_expression_batch_too_small/);
  });

  test("order.create_intent normalizes common aliases and rejects non-positive qty", () => {
    const contract = getToolContract("order.create_intent")!;
    expect(
      applyToolContract(contract, {
        ticker: "AAPL",
        direction: "long",
        quantity: 10,
      })
    ).toMatchObject({ symbol: "AAPL", side: "long", qty: 10, dispatch_mode: "paper" });
    expect(() => applyToolContract(contract, { ticker: "AAPL", side: "buy", quantity: 0 })).toThrow(
      /invalid_qty/
    );
  });

  test("unregistered tool has no contract", () => {
    expect(getToolContract("assign_task")).toBeUndefined();
  });

  test("strategy.compose normalizes camelCase factor ids", () => {
    const contract = getToolContract("strategy.compose")!;
    expect(
      applyToolContract(contract, {
        strategyVersionId: "sv-1",
        factorIds: ["f1", "f2"],
      })
    ).toMatchObject({
      strategy_version_id: "sv-1",
      factor_ids: ["f1", "f2"],
    });
  });

  test("research.framework.assess normalizes camelCase thesis id", () => {
    const contract = getToolContract("research.framework.assess")!;
    expect(applyToolContract(contract, { thesisId: "thesis_abc", candidates: [] })).toMatchObject({
      thesis_id: "thesis_abc",
      candidates: [],
    });
    expect(contract.requiredAfterNormalize).toEqual(["thesis_id", "candidates"]);
  });

  test("backtest.run normalizes composition and snapshot aliases", () => {
    const contract = getToolContract("backtest.run")!;
    expect(
      applyToolContract(contract, {
        strategyVersionId: "sv-1",
        compositionId: "cmp-1",
        snapshotId: "snap-1",
        symbols: ["AAPL"],
      })
    ).toMatchObject({
      strategy_version_id: "sv-1",
      composition_id: "cmp-1",
      dataset_snapshot_id: "snap-1",
      symbols: ["AAPL"],
    });
  });

  test("factor.promote_backtest requires dataset snapshot id", () => {
    const contract = getToolContract("factor.promote_backtest")!;
    expect(() =>
      applyToolContract(contract, {
        factorIds: ["f1"],
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        symbols: ["AAPL"],
      })
    ).toThrow(/missing_dataset_snapshot_id/);
    expect(
      applyToolContract(contract, {
        factorIds: ["f1"],
        snapshotId: "snap-1",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
        symbols: ["AAPL"],
      })
    ).toMatchObject({
      factor_ids: ["f1"],
      dataset_snapshot_id: "snap-1",
    });
  });

  test("factor correlation diagnostics requires frozen evidence and normalizes aliases", () => {
    const contract = getToolContract("factor.correlation.diagnose")!;
    expect(() => applyToolContract(contract, { factorIds: ["factor-a", "factor-b"] })).toThrow(
      /dataset_snapshot_id/
    );
    expect(
      applyToolContract(contract, {
        factorIds: ["factor-a", "factor-b"],
        snapshotId: "snapshot-frozen",
        maxAbsCorrelation: 0.65,
      })
    ).toMatchObject({
      factor_ids: ["factor-a", "factor-b"],
      dataset_snapshot_id: "snapshot-frozen",
      max_abs_correlation: 0.65,
    });
  });
});
