import { describe, expect, test } from "bun:test";
import {
  buildRuntimeCapabilityManifest,
  isToolBlockedByRuntimeCapability,
  renderRuntimeCapabilityManifest,
} from "./data-capability-manifest";

describe("runtime data capability manifest", () => {
  test("hides an unconfigured US realtime quote before prompt construction", () => {
    const manifest = buildRuntimeCapabilityManifest({
      tools: ["fetch_quote", "fetch_klines", "market.resolve_symbol"],
      ticker: "AAPL",
    });
    expect(manifest.market).toBe("US");
    expect(manifest.tools).toEqual(["fetch_klines", "market.resolve_symbol"]);
    expect(isToolBlockedByRuntimeCapability(manifest, "fetch_quote")?.status).toBe("unconfigured");
    expect(renderRuntimeCapabilityManifest(manifest)).toContain("US");
  });

  test("keeps configured CN realtime tools available", () => {
    const manifest = buildRuntimeCapabilityManifest({
      tools: ["qubit-data/fetch_quote", "fetch_ticks"],
      ticker: "600519.SH",
    });
    expect(manifest.market).toBe("CN");
    expect(manifest.unavailable).toEqual([]);
    expect(manifest.tools).toHaveLength(2);
  });

  test("does not advertise evidence-grade fundamentals or news without providers", () => {
    const manifest = buildRuntimeCapabilityManifest({
      tools: ["fetch_fundamentals", "fetch_financial_data", "fetch_news", "fetch_klines"],
      ticker: "AAPL",
      providerSettings: { hasFundamentalsProvider: false, hasNewsProvider: false },
    });
    expect(manifest.tools).toEqual(["fetch_klines"]);
    expect(manifest.unavailable.map((item) => item.code).sort()).toEqual([
      "fundamentals_source_unconfigured",
      "fundamentals_source_unconfigured",
      "news_source_unconfigured",
    ]);
  });
});
