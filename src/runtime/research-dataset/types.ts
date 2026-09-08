/**
 * Research Dataset Plane — D0 types only (no materialize I/O yet).
 * @see docs/RESEARCH_DATASET_GATE_EVOLUTION.md
 */
export type ResearchDatasetGrade = "research_only" | "strategy_validation";

export type ResearchSampleStats = {
  nSymbols: number;
  nTradingDays: number;
  nBars: number;
  nCrossSectionDays?: number;
  coverage?: number;
};

export type ResearchDatasetBundleSummary = {
  datasetSnapshotId?: string | null;
  preprocessSpecHash?: string | null;
  sampleStats: ResearchSampleStats;
  grade: ResearchDatasetGrade;
  computeProfile?: string;
};

/** Collect panel stats from factor_value-like rows (symbol × date). */
export function collectSampleStatsFromRows(
  rows: ReadonlyArray<{ symbol: string; date?: string; asof?: string }>
): ResearchSampleStats {
  const symbols = new Set<string>();
  const days = new Set<string>();
  for (const row of rows) {
    const sym = String(row.symbol ?? "").trim();
    if (sym) symbols.add(sym);
    const day = String(row.date ?? row.asof ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.add(day);
  }
  return {
    nSymbols: symbols.size,
    nTradingDays: days.size,
    nBars: rows.length,
    nCrossSectionDays: days.size,
  };
}
