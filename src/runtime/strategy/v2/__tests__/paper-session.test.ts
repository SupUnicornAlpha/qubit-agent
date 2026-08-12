import { describe, expect, test } from "bun:test";
import type { StrategyManifestV2 } from "../contract-service";
import {
  __resetPaperSessionsForTests,
  createPaperSession,
  tradesToPaperOrderDrafts,
} from "../paper-session-service";

const MANIFEST: StrategyManifestV2 = {
  apiVersion: 2,
  codeHash: "a".repeat(64),
  strategyType: "cta",
  universe: {
    kind: "static",
    instruments: [{ market: "US", symbol: "TEST", instrumentId: "US:TEST" }],
  },
  subscriptions: [],
  schedules: [],
  benchmark: null,
  handlers: ["handle_data"],
  warmupBars: 3,
  primaryFrequency: "1d",
  paramsSchema: [],
  metadata: {},
};

describe("paper-session-service", () => {
  test("createPaperSession stores fixed paper capital", () => {
    __resetPaperSessionsForTests();
    const s = createPaperSession({
      strategyCode: "print(1)",
      manifest: MANIFEST,
      paperCapital: 50_000,
      primarySymbol: "US:TEST",
    });
    expect(s.paperCapital).toBe(50_000);
    expect(s.codeHash).toBe(MANIFEST.codeHash);
    expect(s.status).toBe("ready");
  });

  test("tradesToPaperOrderDrafts maps sim trades", () => {
    const drafts = tradesToPaperOrderDrafts([
      { side: "buy", qty: 10, price: 100, symbol: "US:TEST", time: "2024-01-02", reason: "in" },
      { side: "sell", qty: 10, price: 105, symbol: "US:TEST", time: "2024-01-10", reason: "out" },
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.side).toBe("buy");
    expect(drafts[1]?.qty).toBe(10);
  });
});
