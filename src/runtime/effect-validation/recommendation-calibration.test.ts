import { describe, expect, test } from "bun:test";
import { summarizeRecommendationCalibration } from "./recommendation-calibration";

describe("recommendation calibration", () => {
  test("keeps flat outcomes as non-wins and reports insufficient evidence", () => {
    const result = summarizeRecommendationCalibration(
      [
        {
          side: "long",
          horizonDays: 20,
          confidence: 0.9,
          outcome: "win",
          returnPct: 4,
          excessReturnPct: 2,
        },
        {
          side: "long",
          horizonDays: 20,
          confidence: 0.8,
          outcome: "loss",
          returnPct: -3,
          excessReturnPct: -4,
        },
        {
          side: "long",
          horizonDays: 20,
          confidence: 0.6,
          outcome: "flat",
          returnPct: 0,
          excessReturnPct: 0,
        },
      ],
      4
    );
    expect(result).toEqual([
      expect.objectContaining({
        observations: 3,
        wins: 1,
        winRate: 0.333333,
        status: "insufficient_data",
      }),
    ]);
    expect(result[0]!.brierScore).toBeCloseTo((0.01 + 0.64 + 0.36) / 3, 6);
  });
});
