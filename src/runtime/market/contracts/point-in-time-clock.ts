/** Parse an unambiguous timestamp, rejecting local-time and normalized invalid dates. */
export function pointInTimeMillis(value: string): number {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !match[1] || !isPointInTimeDate(match[1])) return Number.NaN;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    return Number.NaN;
  }
  const offset = match[5];
  if (!offset) return Number.NaN;
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function isPointInTimeDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}
