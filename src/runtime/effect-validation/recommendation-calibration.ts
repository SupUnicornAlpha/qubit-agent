export type RecommendationCalibrationRow = {
  side: "long" | "short" | "neutral";
  horizonDays: number;
  confidence: number;
  outcome: "win" | "loss" | "flat";
  returnPct: number | null;
  excessReturnPct: number | null;
};

export type RecommendationCalibrationGroup = {
  side: RecommendationCalibrationRow["side"];
  horizonDays: number;
  observations: number;
  wins: number;
  winRate: number;
  brierScore: number;
  averageReturnPct: number | null;
  averageExcessReturnPct: number | null;
  status: "ready" | "insufficient_data";
};

const round = (value: number, digits = 6) => Number(value.toFixed(digits));

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * A descriptive calibration summary, not causal proof or an automatic model
 * update. Flat outcomes are scored as non-wins, matching the decision outcome
 * Brier convention used by the outcome writer.
 */
export function summarizeRecommendationCalibration(
  rows: RecommendationCalibrationRow[],
  minimumObservations = 30
): RecommendationCalibrationGroup[] {
  const groups = new Map<string, RecommendationCalibrationRow[]>();
  for (const row of rows) {
    const key = `${row.side}\u0000${row.horizonDays}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .map((group) => {
      const wins = group.filter((row) => row.outcome === "win").length;
      const returns = group.flatMap((row) =>
        typeof row.returnPct === "number" && Number.isFinite(row.returnPct) ? [row.returnPct] : []
      );
      const excess = group.flatMap((row) =>
        typeof row.excessReturnPct === "number" && Number.isFinite(row.excessReturnPct)
          ? [row.excessReturnPct]
          : []
      );
      const brier =
        group.reduce(
          (sum, row) => sum + (row.confidence - (row.outcome === "win" ? 1 : 0)) ** 2,
          0
        ) / group.length;
      return {
        side: group[0]!.side,
        horizonDays: group[0]!.horizonDays,
        observations: group.length,
        wins,
        winRate: round(wins / group.length),
        brierScore: round(brier),
        averageReturnPct: mean(returns) === null ? null : round(mean(returns)!),
        averageExcessReturnPct: mean(excess) === null ? null : round(mean(excess)!),
        status: group.length >= minimumObservations ? "ready" : "insufficient_data",
      } satisfies RecommendationCalibrationGroup;
    })
    .sort(
      (left, right) => left.side.localeCompare(right.side) || left.horizonDays - right.horizonDays
    );
}
