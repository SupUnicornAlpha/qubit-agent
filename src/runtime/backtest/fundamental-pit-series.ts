/**
 * Materialize point-in-time fundamental revisions into Qlib expression fields.
 *
 * Daily OHLCV bars are conventionally timestamped at the start of the session,
 * while filing availability can be intraday or after the close. To avoid
 * granting information we cannot timestamp against a venue session, an
 * observation becomes usable only on the first subsequent bar whose timestamp
 * is strictly after `availableAt`. This is conservative by design.
 */

import { pointInTimeMillis } from "../market/contracts/point-in-time-clock";

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
  let previousBarTime = Number.NEGATIVE_INFINITY;
  const barTimes = bars.map((bar) => {
    const timestamp = pointInTimeMillis(bar.timestamp);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`fundamental_bar_timestamp_invalid:${bar.timestamp}`);
    }
    if (timestamp <= previousBarTime) {
      throw new Error(`fundamental_bar_timestamps_not_increasing:${bar.timestamp}`);
    }
    previousBarTime = timestamp;
    return timestamp;
  });
  const fields = new Map<string, Array<number | null>>();
  const latest = new Map<string, number>();
  const metricByField = new Map<string, string>();
  const pending = observations
    .filter(
      (observation) => observation.metric.trim().length > 0 && Number.isFinite(observation.value)
    )
    .map((observation) => {
      const availableAtMs = pointInTimeMillis(observation.availableAt);
      if (!Number.isFinite(availableAtMs)) {
        throw new Error(`fundamental_available_at_invalid:${observation.availableAt}`);
      }
      return { ...observation, availableAtMs };
    })
    .sort(
      (left, right) =>
        left.availableAtMs - right.availableAtMs ||
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
  for (const [index, timestamp] of barTimes.entries()) {
    let observation = pending[cursor];
    while (observation && observation.availableAtMs < timestamp) {
      latest.set(fundamentalFieldName(observation.metric), observation.value);
      cursor += 1;
      observation = pending[cursor];
    }
    for (const [field, values] of fields) values[index] = latest.get(field) ?? null;
  }
  return Object.fromEntries(fields);
}
