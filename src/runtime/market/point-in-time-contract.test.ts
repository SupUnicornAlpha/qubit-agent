import { describe, expect, test } from "bun:test";
import { GOLDEN_MARKET_DATASET } from "./golden-market-dataset";
import { validatePointInTimeBars } from "./point-in-time-contract";
import { checkGoldenMarketDataReadiness } from "../agent-readiness/quality/market-data-readiness";

describe("point-in-time market data contract", () => {
  test("readiness preflight accepts the full golden suite", () => {
    const readiness = checkGoldenMarketDataReadiness();
    expect(readiness.ok).toBe(true);
    expect(readiness.passed).toBe(readiness.total);
  });
  for (const fixture of GOLDEN_MARKET_DATASET) {
    test(fixture.id, () => {
      const result = validatePointInTimeBars(fixture.bars, fixture.provenance);
      expect(result.valid).toBe(fixture.expectedValid);
      if (fixture.expectedError) {
        expect(result.errors.some((error) => error.startsWith(fixture.expectedError!))).toBe(true);
      }
      expect(result.lineage.provider).toBe("golden");
      expect(result.lineage.dataAsof).toBe(fixture.provenance.dataAsof);
    });
  }
});
