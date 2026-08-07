import { describe, expect, test } from "bun:test";
import {
  coerceConfidence01,
  coerceRecommendationSide,
  coerceThesisDirection,
  extractForecastBookKey,
  extractSnapshotId,
  inferSymbolsFromText,
  normalizePortfolioCandidates,
  resolveInstrumentScope,
  resolveThesisDirection,
} from "./research-arg-normalize";

describe("research-arg-normalize", () => {
  test("coerceConfidence01 accepts labels and percentages", () => {
    expect(coerceConfidence01("low")).toBe(0.3);
    expect(coerceConfidence01("high")).toBe(0.75);
    expect(coerceConfidence01(62)).toBe(0.62);
    expect(coerceConfidence01(0.62)).toBe(0.62);
  });

  test("coerceThesisDirection maps free text", () => {
    expect(coerceThesisDirection("long")).toBe("long");
    expect(coerceThesisDirection("震荡反弹/日内高抛低吸")).toBe("neutral");
    expect(coerceThesisDirection("看多")).toBe("long");
  });

  test("extractSnapshotId from evidence refs", () => {
    expect(
      extractSnapshotId({
        evidence: [{ ref: "mkt_snapshot_abc123", source: "market.snapshot.get" }],
      })
    ).toBe("mkt_snapshot_abc123");
  });

  test("extractForecastBookKey accepts bookId", () => {
    expect(extractForecastBookKey({ bookId: "fb_abc" })).toEqual({
      thesisId: "",
      entryId: "fb_abc",
    });
  });

  test("normalizePortfolioCandidates accepts allocation weights", () => {
    const rows = normalizePortfolioCandidates({
      allocation: [
        { symbol: "603986.SH", weight: 0.4 },
        { symbol: "688525.SH", weight: 0.2, side: "long" },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.symbol).toBe("603986.SH");
    expect(rows?.[0]?.proposedWeight).toBe(0.4);
    expect(rows?.[0]?.price).toBe(0);
  });

  test("coerceRecommendationSide from action", () => {
    expect(coerceRecommendationSide("t_swing")).toBe("neutral");
    expect(coerceRecommendationSide("buy")).toBe("long");
  });

  test("inferSymbolsFromText finds A-share and US tickers", () => {
    expect(inferSymbolsFromText("关注 600519.SH 与 AAPL")).toEqual(
      expect.arrayContaining(["600519.SH", "AAPL"])
    );
  });

  test("resolveInstrumentScope and resolveThesisDirection from narrative", () => {
    expect(
      resolveInstrumentScope({ narrative: "偏多持有 002415.SZ" })
    ).toContain("002415.SZ");
    expect(resolveThesisDirection({ narrative: "看空回调" })).toBe("short");
    expect(resolveThesisDirection({ narrative: "观望为主" })).toBe("neutral");
  });
});
