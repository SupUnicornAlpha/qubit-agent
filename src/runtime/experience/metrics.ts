/**
 * Memory V2 P1.5 — 内存监控指标收集器（in-process counters）。
 *
 * 唯一职责：被动订阅 ExperienceBus 的几类事件，把计数收进内存；通过
 * `getMemoryMetricsSnapshot()` 暴露给 API / Prometheus exporter / 测试断言。
 *
 * 设计原则：
 *   - **零侵入**：5 个 pipe（Writer/Extractor/Reflector/Janitor/Recall）一行不动；
 *     新增任何指标都只在本文件加 handler，方便走 PR review。
 *   - **可热重置**：`resetMemoryMetricsForTesting()` 让单测互不污染。
 *   - **可替换 collector**：所有 record 都走 `MetricsCollector` interface；
 *     默认 in-memory，未来接 Prometheus / Datadog 只换 collector，不动 handler。
 *   - **失败不阻塞**：handler 内部不会抛错（纯计数 / 字符串拼接），但仍包 try/catch
 *     以防未来扩展时引入副作用。
 *
 * 当前订阅：
 *   - `experience_recalled` → `recall.hits.total` + `recall.hits.by_rank.{0..4}`
 *   - `experience_executed` → `execute.total` + `execute.by_outcome.{success,fail,partial,unknown}`
 *   - `maintenance_run` (kind=janitor) → `janitor.scanned/qualityUpdated/decayMarked/archived`
 *   - `maintenance_run` (kind=reflector_daily) → `reflector.runs.total` + `reflector.by_status.{...}`
 */

import type { ExperienceBus } from "./experience-bus";

// ───────────────────────── Collector 契约 ─────────────────────────

export interface MetricsCollector {
  inc(name: string, by?: number, tags?: Record<string, string>): void;
  /** snapshot：name → 累计计数；tags 内容融入 name（`name|k=v|...`） */
  snapshot(): Record<string, number>;
  reset(): void;
}

export class InMemoryMetricsCollector implements MetricsCollector {
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

// ───────────────────────── 默认 collector & 工厂 ─────────────────────────

let _collector: MetricsCollector = new InMemoryMetricsCollector();

export function getMemoryMetricsCollector(): MetricsCollector {
  return _collector;
}

export function setMemoryMetricsCollectorForTesting(c: MetricsCollector | null): void {
  _collector = c ?? new InMemoryMetricsCollector();
}

export function resetMemoryMetricsForTesting(): void {
  _collector.reset();
}

export function getMemoryMetricsSnapshot(): Record<string, number> {
  return _collector.snapshot();
}

// ───────────────────────── Bus 订阅 ─────────────────────────

export interface MetricsHandle {
  detach(): void;
}

/**
 * 把 collector 挂到 Bus 上。返回 detach() 用于取消。
 * 同一个 Bus 多次挂会重复计数；测试时记得每次 beforeEach 重建 Bus + detach。
 */
export function attachMemoryMetrics(bus: ExperienceBus): MetricsHandle {
  const c = _collector;

  const offRecalled = bus.subscribe("experience_recalled", (ev) => {
    try {
      c.inc("memory.recall.hits.total");
      c.inc("memory.recall.hits.by_rank", 1, { rank: String(Math.min(ev.rank, 9)) });
      // 平均分桶：把 0..1 切成 10 桶，用于看召回质量分布
      const bucket = Math.min(9, Math.max(0, Math.floor(ev.score * 10)));
      c.inc("memory.recall.hits.by_score_bucket", 1, { bucket: String(bucket) });
    } catch {
      // pure counter，理论上不会抛；保险加 catch
    }
  });

  const offExecuted = bus.subscribe("experience_executed", (ev) => {
    try {
      c.inc("memory.execute.total");
      c.inc("memory.execute.by_outcome", 1, { outcome: ev.outcome });
    } catch {
      /* noop */
    }
  });

  const offMaint = bus.subscribe("maintenance_run", (ev) => {
    try {
      if (ev.kind === "janitor") {
        const s = ev.summary;
        c.inc("memory.janitor.tick.total");
        c.inc("memory.janitor.scanned", numOf(s.scanned));
        c.inc("memory.janitor.quality_updated", numOf(s.qualityUpdated));
        c.inc("memory.janitor.decay_marked", numOf(s.decayMarked));
        c.inc("memory.janitor.archived", numOf(s.archived));
      } else if (ev.kind === "reflector_daily") {
        const status = String(ev.summary.status ?? "unknown");
        c.inc("memory.reflector.runs.total");
        c.inc("memory.reflector.runs.by_status", 1, { status });
      }
    } catch {
      /* noop */
    }
  });

  return {
    detach() {
      offRecalled();
      offExecuted();
      offMaint();
    },
  };
}

function numOf(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
