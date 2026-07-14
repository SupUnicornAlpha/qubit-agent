import { GOLDEN_MARKET_DATASET } from "../../market/golden-market-dataset";
import { validatePointInTimeBars } from "../../market/point-in-time-contract";

export function checkGoldenMarketDataReadiness() {
  const cases = GOLDEN_MARKET_DATASET.map((fixture) => {
    const result = validatePointInTimeBars(fixture.bars, fixture.provenance);
    const expectedErrorMatched = !fixture.expectedError
      || result.errors.some((error) => error.startsWith(fixture.expectedError!));
    return {
      id: fixture.id,
      market: fixture.market,
      passed: result.valid === fixture.expectedValid && expectedErrorMatched,
      expectedValid: fixture.expectedValid,
      actualValid: result.valid,
      errors: result.errors,
    };
  });
  return {
    ok: cases.every((fixture) => fixture.passed),
    total: cases.length,
    passed: cases.filter((fixture) => fixture.passed).length,
    cases,
  };
}

export function assertGoldenMarketDataReadiness(): void {
  const result = checkGoldenMarketDataReadiness();
  if (!result.ok) throw new Error("golden_market_data_readiness_failed:" + JSON.stringify(result.cases));
}
