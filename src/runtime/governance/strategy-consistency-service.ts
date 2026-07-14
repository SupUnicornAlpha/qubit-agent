import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import { strategyEvalRun } from "../../db/sqlite/schema";

const CONSISTENCY_METRICS = ["netReturn", "sharpe", "maxDrawdown", "turnover", "signalCount", "orderCount"] as const;

function numericMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1])));
}

export function buildStrategyConsistencyReport(
  rows: Array<typeof strategyEvalRun.$inferSelect>,
  tolerance = 0.25,
) {
  const latest = (kind: "backtest" | "paper" | "live") => rows
    .filter((row) => row.evalKind === kind)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  const stages = { backtest: latest("backtest"), paper: latest("paper"), live: latest("live") };
  const comparisons = ([
    ["backtest", "paper"],
    ["paper", "live"],
  ] as const).flatMap(([baselineKind, observedKind]) => {
    const baseline = stages[baselineKind];
    const observed = stages[observedKind];
    if (!baseline || !observed) return [];
    const baselineMetrics = numericMetrics(baseline.metricsJson);
    const observedMetrics = numericMetrics(observed.metricsJson);
    return CONSISTENCY_METRICS.flatMap((metric) => {
      const expected = baselineMetrics[metric];
      const actual = observedMetrics[metric];
      if (expected == null || actual == null) return [];
      const denominator = Math.max(Math.abs(expected), 0.000001);
      const relativeDeviation = Math.abs(actual - expected) / denominator;
      return [{ baseline: baselineKind, observed: observedKind, metric, expected, actual, relativeDeviation, pass: relativeDeviation <= tolerance }];
    });
  });
  const missingStages = Object.entries(stages).filter(([, row]) => !row).map(([kind]) => kind);
  return {
    tolerance,
    stages: Object.fromEntries(Object.entries(stages).map(([kind, row]) => [kind, row ? { id: row.id, pass: row.pass, qualityScore: row.qualityScore, createdAt: row.createdAt } : null])),
    comparisons,
    missingStages,
    pass: missingStages.length === 0 && comparisons.length > 0 && comparisons.every((item) => item.pass),
  };
}

export async function getStrategyConsistencyReport(input: {
  projectId: string;
  strategyVersionId: string;
  tolerance?: number;
}, client?: DbClient) {
  const db = client ?? await getDb();
  const rows = await db.select().from(strategyEvalRun).where(and(
    eq(strategyEvalRun.projectId, input.projectId),
    eq(strategyEvalRun.strategyVersionId, input.strategyVersionId),
  ));
  return buildStrategyConsistencyReport(rows, Math.max(0, input.tolerance ?? 0.25));
}
