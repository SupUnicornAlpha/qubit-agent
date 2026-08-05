import { describe, expect, test } from "bun:test";
import { unwrapBridgeToolArgs } from "../../routes/prime-bridge.routes";

describe("unwrapBridgeToolArgs", () => {
  test("flattens nested arguments with top-level wins", () => {
    const out = unwrapBridgeToolArgs({
      arguments: {
        name: "nested",
        project_id: "proj-1",
        expr: "EMA(close,12)-EMA(close,26)",
      },
      name: "top",
    });
    expect(out.name).toBe("top");
    expect(out.project_id).toBe("proj-1");
    expect(out.projectId).toBe("proj-1");
    expect(out.expr).toBe("EMA(close,12)-EMA(close,26)");
    expect(out.arguments).toBeUndefined();
  });

  test("aliases strategyName and targets", () => {
    const out = unwrapBridgeToolArgs({
      arguments: {
        strategyName: "macd_long",
        targets: ["000001.SZ", "AAPL"],
        snapshot_id: "snap-1",
      },
    });
    expect(out.name).toBe("macd_long");
    expect(out.symbols).toEqual(["000001.SZ", "AAPL"]);
    expect(out.snapshotId).toBe("snap-1");
  });
});
