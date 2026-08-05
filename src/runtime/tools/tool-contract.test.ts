import { describe, expect, test } from "bun:test";
import { applyToolContract } from "./tool-contract";
import { getToolContract, listRegisteredToolContracts } from "./tool-contract-registry";

describe("ToolContract registry (market P0)", () => {
  test("registers market family contracts", () => {
    const names = listRegisteredToolContracts().map((c) => c.name).sort();
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

  test("unregistered tool has no contract", () => {
    expect(getToolContract("assign_task")).toBeUndefined();
  });
});
