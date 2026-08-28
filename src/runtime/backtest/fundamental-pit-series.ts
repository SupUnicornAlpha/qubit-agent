/**
 * Materialize point-in-time fundamental revisions into Qlib expression fields.
 *
 * Daily OHLCV bars are conventionally timestamped at the start of the session,
 * while filing availability can be intraday or after the close. To avoid
 * granting information we cannot timestamp against a venue session, an
 * observation becomes usable only on the first subsequent bar whose timestamp
 * is strictly after `availableAt`. This is conservative by design.
 */

export type FundamentalSeriesBar = { timestamp: string };
export type FundamentalSeriesObservation = {
  metric: string;
  fiscalPeriodEnd: string;
  availableAt: string;
  value: number;
  revisionId?: string;
};

export function fundamentalFieldName(metric: string): string {
  const normalized = metric
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `fund_${normalized || "unknown"}`;
}

export function materializeFundamentalPitFields(
  bars: FundamentalSeriesBar[],
  observations: FundamentalSeriesObservation[] | undefined
): Record<string, Array<number | null>> {
  if (!observations?.length || bars.length === 0) return {};
  const fields = new Map<string, Array<number | null>>();
  const latest = new Map<string, number>();
  const metricByField = new Map<string, string>();
  const pending = observations
    .filter(
      (observation) =>
        observation.metric.trim().length > 0 &&
        Number.isFinite(observation.value) &&
        Number.isFinite(Date.parse(observation.availableAt))
    )
    .slice()
    .sort(
      (left, right) =>
        left.availableAt.localeCompare(right.availableAt) ||
        left.fiscalPeriodEnd.localeCompare(right.fiscalPeriodEnd) ||
        left.metric.localeCompare(right.metric) ||
        (left.revisionId ?? "").localeCompare(right.revisionId ?? "")
    );
  for (const observation of pending) {
    const field = fundamentalFieldName(observation.metric);
    const metric = observation.metric.trim();
    const prior = metricByField.get(field);
    if (prior && prior !== metric) {
      throw new Error(`fundamental_metric_field_collision:${prior}:${metric}:${field}`);
    }
    metricByField.set(field, metric);
  }
  const fieldNames = new Set(
    pending.map((observation) => fundamentalFieldName(observation.metric))
  );
  for (const field of fieldNames) fields.set(field, new Array(bars.length).fill(null));

  let cursor = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const timestamp = bars[index]!.timestamp;
    while (cursor < pending.length && pending[cursor]!.availableAt < timestamp) {
      const observation = pending[cursor]!;
      latest.set(fundamentalFieldName(observation.metric), observation.value);
      cursor += 1;
    }
    for (const [field, values] of fields) values[index] = latest.get(field) ?? null;
  }
  return Object.fromEntries(fields);
}
