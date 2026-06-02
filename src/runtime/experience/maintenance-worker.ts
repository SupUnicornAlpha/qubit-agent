/**
 * ExperienceMaintenanceWorker — Memory V2 P1.5 后台维护循环。
 *
 * 设计目标（详见 docs/MEMORY_V2_DESIGN.md §6.6 / §8.2）：
 *   - 周期性触发 Janitor.runJanitorOnce —— 重算 qualityScore、标 decay_at、归档过期
 *   - 单 tick 串行，避免并发写 SQLite 与同表的 Writer / Extractor / Reflector 抢锁
 *   - 仿 src/runtime/monitor/monitor-aggregator-worker.ts 的模式：tick / start / stop
 *
 * 默认：启动 60s 后跑第一次（避开冷启动资源争抢），之后每 1 小时跑一次
 *   - 选择 1h 而非 24h，是因为衰减判定本身按"valid_from > 14d" 节流；
 *     1h 一跑可以让"今天写、明天就 decay"这种边角立刻生效；
 *   - 高频不增加成本：Janitor 是 O(n) 内存扫描 + 少量 update，n 大概数千。
 *
 * 注意：所有阶段都包 try/catch，单次 tick 失败仅 warn，不抛出主进程。
 *       维护基础设施失败 ≠ 业务失败。
 */

import { getExperienceBus } from "./experience-bus";
import { getExperienceStore } from "./experience-store";
import { type MetricsHandle, attachMemoryMetrics } from "./metrics";
import { type JanitorRunSummary, runJanitorOnce } from "./pipes/janitor";

/** 默认每小时一次（错过整点 5min，避开和 monitorAggregator 抢资源） */
const DEFAULT_TICK_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 60 * 1000;
const DEFAULT_MAX_BATCH = 500;

export interface ExperienceMaintenanceTickResult {
  janitor: { ok: boolean; summary?: JanitorRunSummary; error?: string };
}

export interface ExperienceMaintenanceOptions {
  tickMs?: number;
  startupDelayMs?: number;
  maxBatch?: number;
}

export class ExperienceMaintenanceWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private metricsHandle: MetricsHandle | null = null;
  private running = false;
  private readonly tickMs: number;
  private readonly startupDelayMs: number;
  private readonly maxBatch: number;

  constructor(opts: ExperienceMaintenanceOptions = {}) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.startupDelayMs = opts.startupDelayMs ?? STARTUP_DELAY_MS;
    this.maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  }

  /**
   * 单次 tick；返回每阶段结果（测试可直接 inspect）。
   * 单调用绝不抛错 — 任何 stage 异常都被 catch 转为 result.error。
   */
  async tick(): Promise<ExperienceMaintenanceTickResult> {
    if (this.running) {
      return {
        janitor: { ok: false, error: "previous tick still running" },
      };
    }
    this.running = true;
    const result: ExperienceMaintenanceTickResult = { janitor: { ok: false } };
    try {
      try {
        const summary = await runJanitorOnce({
          store: getExperienceStore(),
          bus: getExperienceBus(),
          maxBatch: this.maxBatch,
        });
        result.janitor = { ok: true, summary };
        if (summary.qualityUpdated > 0 || summary.decayMarked > 0 || summary.archived > 0) {
          console.log(
            `[experienceMaintenance] tick OK scanned=${summary.scanned} ` +
              `qUpdated=${summary.qualityUpdated} decay=${summary.decayMarked} ` +
              `archived=${summary.archived}`
          );
        }
      } catch (e) {
        const err = errToStr(e);
        result.janitor = { ok: false, error: err };
        console.warn(`[experienceMaintenance] janitor failed: ${err}`);
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  /**
   * 启动 worker：
   *   - 延迟 startupDelayMs 跑第一次；
   *   - 之后每 tickMs 一次。
   */
  start(): void {
    if (this.timer) return;
    // 把 metrics collector 挂到 Bus；进程生命周期共享同一个 Bus。
    if (!this.metricsHandle) {
      this.metricsHandle = attachMemoryMetrics(getExperienceBus());
    }
    this.startupTimer = setTimeout(() => {
      void this.tick();
    }, this.startupDelayMs);
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.metricsHandle) {
      this.metricsHandle.detach();
      this.metricsHandle = null;
    }
  }
}

function errToStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const experienceMaintenanceWorker = new ExperienceMaintenanceWorker();
