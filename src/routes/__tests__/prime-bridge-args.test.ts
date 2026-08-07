import { describe, expect, test } from "bun:test";
import {
  isBridgedLegacyToolName,
  unwrapBridgeToolArgs,
} from "../../routes/prime-bridge.routes";

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

  test("aliases bookId ticker allocation", () => {
    const out = unwrapBridgeToolArgs({
      arguments: {
        bookId: "fb_1",
        ticker: "ASTS",
        allocation: [{ symbol: "AAPL", weight: 0.5 }],
      },
    });
    expect(out.entryId).toBe("fb_1");
    expect(out.symbol).toBe("ASTS");
    expect(out.ticker).toBe("ASTS");
    expect(out.candidates).toEqual([{ symbol: "AAPL", weight: 0.5 }]);
  });
});

describe("isBridgedLegacyToolName", () => {
  test("allows static builtins and dynamic call_team_*", () => {
    expect(isBridgedLegacyToolName("market.snapshot.get")).toBe(true);
    expect(isBridgedLegacyToolName("assign_task")).toBe(true);
    expect(isBridgedLegacyToolName("call_team_research")).toBe(true);
    expect(isBridgedLegacyToolName("call_team_news_event")).toBe(true);
    expect(isBridgedLegacyToolName("not_a_real_tool")).toBe(false);
  });
});
