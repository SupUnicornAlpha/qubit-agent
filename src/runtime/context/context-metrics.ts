/**
 * Context Protocol / Finance Memory 进程内计数（对齐 05 §4.8）。
 * 与 experience/metrics 并列；API 可后续合并导出。
 */

export interface ContextMetricsCollector {
  inc(name: string, by?: number, tags?: Record<string, string>): void;
  snapshot(): Record<string, number>;
  reset(): void;
}

class InMemoryContextMetrics implements ContextMetricsCollector {
  private readonly counters = new Map<string, number>();

  inc(name: string, by = 1, tags?: Record<string, string>): void {
    const key = buildKey(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) out[k] = v;
    return out;
  }

  reset(): void {
    this.counters.clear();
  }
}

function buildKey(name: string, tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return name;
  const sorted = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join("|");
  return `${name}|${sorted}`;
}

let _collector: ContextMetricsCollector = new InMemoryContextMetrics();

export function getContextMetricsCollector(): ContextMetricsCollector {
  return _collector;
}

export function resetContextMetricsForTesting(): void {
  _collector.reset();
}

export function getContextMetricsSnapshot(): Record<string, number> {
  return _collector.snapshot();
}

export function incContextMetric(
  name: string,
  by = 1,
  tags?: Record<string, string>
): void {
  try {
    _collector.inc(name, by, tags);
  } catch {
    /* noop */
  }
}
