/** Agent Eval 平台纯函数：供 UI 与 smoke 测试复用。 */

export type ScoreValueLike = {
  dataType?: string;
  numeric?: number;
  categorical?: string;
  boolean?: boolean;
  text?: string;
};

export type ScoreRowLike = {
  dataType?: string;
  value?: ScoreValueLike;
};

export function formatAgentEvalScoreValue(row: ScoreRowLike): string {
  const dt = row.value?.dataType ?? row.dataType;
  const v = row.value;
  if (!v) return "—";
  if (dt === "NUMERIC" && v.numeric != null) return v.numeric.toFixed(3);
  if (dt === "BOOLEAN" && v.boolean != null) return v.boolean ? "true" : "false";
  if (dt === "CATEGORICAL" && v.categorical) return v.categorical;
  if (dt === "TEXT" && v.text) return v.text.slice(0, 120);
  return "—";
}

export type DailyRollupRow = {
  day: string;
  name: string;
  avgNumeric: number | null;
};

/** 将日聚合转为 Recharts 宽表：{ day, "aqm.weighted_score": 0.8, ... } */
export function dailyRollupToChartRows(rows: DailyRollupRow[]): Array<Record<string, string | number>> {
  const byDay = new Map<string, Record<string, string | number>>();
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? { day: row.day };
    if (row.avgNumeric != null) bucket[row.name] = row.avgNumeric;
    byDay.set(row.day, bucket);
  }
  return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

export function formatDeltaPct(deltaPct: number | null): string {
  if (deltaPct == null || !Number.isFinite(deltaPct)) return "—";
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct.toFixed(1)}%`;
}
