/**
 * 监控 V2 P2 — 监控聚合与告警扫描的后台 worker。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §6.9 / §7.5）：
 *   - 周期性触发：
 *     1) aggregateAgentRuntimeMetrics（Agent 维度指标聚合，写 breakdownJson）
 *     2) createStuckWorkflowAlerts（卡死工作流）
 *     3) scanAllSystemAlerts（mcp_circuit_open + token_anomaly）
 *   - 串行 tick 避免并发写 SQLite；
 *   - 仿 src/runtime/execution/execution-worker.ts 的 ExecutionWorker 模式：
 *     start() / stop() / tick(now)，便于单元测试直接调 tick 验证。
 *
 * 默认每 5 分钟跑一次（也是 docs/MONITORING_V2_DESIGN.md 推荐节奏）。
 *
 * 注意：所有阶段都包 try/catch，单个阶段失败不阻塞其它阶段；
 * 失败仅 console.warn，不抛出主进程。监控基础设施失败 ≠ 业务失败。
 */
import {
  cancelInactiveWorkflows,
  createStuckWorkflowAlerts,
} from "./alert-service";
import { scanAllSystemAlerts } from "./alert-scanners";
import { aggregateAgentRuntimeMetrics } from "./quality-metrics";

/** 默认 5 分钟一次（avoid 跟整点对齐，因为整点很多用户手动触发） */
const DEFAULT_TICK_MS = 5 * 60 * 1000;

/** 启动后等多久跑第一次（避免与 server 启动期资源争抢） */
const STARTUP_DELAY_MS = 30 * 1000;

export type MonitorAggregatorTickResult = {
  aggregateMetrics: { ok: boolean; error?: string };
  stuckAlerts: { ok: boolean; created?: number; error?: string };
  systemAlerts: { ok: boolean; mcpCreated?: number; tokenCreated?: number; error?: string };
  /**
   * 2026-06-05 P1：watchdog 阶段，主动 cancel 卡死无进度的 workflow。
   * cancelled=本 tick 处理的 workflow 数；不抛错（错误转 result.error）。
   */
  inactiveCancelled: { ok: boolean; cancelled?: number; error?: string };
};

export class MonitorAggregatorWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tickMs: number;

  constructor(tickMs = DEFAULT_TICK_MS) {
    this.tickMs = tickMs;
  }

  /**
   * 单次聚合 + 扫描；返回每阶段结果（测试可直接 inspect）。
   * 单调用绝不抛错 — 任何 stage 异常都被 catch 转为 result.error。
   */
  async tick(): Promise<MonitorAggregatorTickResult> {
    if (this.running) {
      // 上一轮还在跑：保守跳过，避免长时间聚合互相挤压 sqlite
      return {
        aggregateMetrics: { ok: false, error: "previous tick still running" },
        stuckAlerts: { ok: false, error: "skipped" },
        systemAlerts: { ok: false, error: "skipped" },
        inactiveCancelled: { ok: false, error: "skipped" },
      };
    }
    this.running = true;
    const result: MonitorAggregatorTickResult = {
      aggregateMetrics: { ok: false },
      stuckAlerts: { ok: false },
      systemAlerts: { ok: false },
      inactiveCancelled: { ok: false },
    };
    try {
      // 1) Agent 维度指标聚合（写 breakdownJson + agent_runtime_metric）
      try {
        await aggregateAgentRuntimeMetrics();
        result.aggregateMetrics = { ok: true };
      } catch (e) {
        result.aggregateMetrics = { ok: false, error: errToStr(e) };
        console.warn(`[monitorAggregator] aggregateMetrics failed: ${result.aggregateMetrics.error}`);
      }

      // 2) 卡死工作流（沿用现有 stuck 阈值 120 分钟）
      try {
        const r = await createStuckWorkflowAlerts(120);
        result.stuckAlerts = { ok: true, created: r.created };
      } catch (e) {
        result.stuckAlerts = { ok: false, error: errToStr(e) };
        console.warn(`[monitorAggregator] stuckAlerts failed: ${result.stuckAlerts.error}`);
      }

      // 3) 系统级告警（mcp_circuit_open + token_anomaly）
      try {
        const r = await scanAllSystemAlerts();
        result.systemAlerts = {
          ok: true,
          mcpCreated: r.mcp.created,
          tokenCreated: r.token.created,
        };
      } catch (e) {
        result.systemAlerts = { ok: false, error: errToStr(e) };
        console.warn(`[monitorAggregator] systemAlerts failed: ${result.systemAlerts.error}`);
      }

      // 4) workflow watchdog（无进度 ≥ 20min → 强制 failed）
      try {
        const r = await cancelInactiveWorkflows(20);
        result.inactiveCancelled = { ok: true, cancelled: r.cancelled };
      } catch (e) {
        result.inactiveCancelled = { ok: false, error: errToStr(e) };
        console.warn(`[monitorAggregator] inactiveCancelled failed: ${result.inactiveCancelled.error}`);
      }

      const summary = formatTickSummary(result);
      if (summary) console.log(`[monitorAggregator] tick OK ${summary}`);
    } finally {
      this.running = false;
    }
    return result;
  }

  /**
   * 启动 worker：
   *   - 延迟 STARTUP_DELAY_MS 跑第一次（避免 server 启动期资源争抢）；
   *   - 之后每 tickMs 一次（默认 5 min）。
   */
  start(): void {
    if (this.timer) return;
    this.startupTimer = setTimeout(() => {
      void this.tick();
    }, STARTUP_DELAY_MS);
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
  }
}

function errToStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatTickSummary(r: MonitorAggregatorTickResult): string {
  const parts: string[] = [];
  if (r.aggregateMetrics.ok) parts.push("agg");
  if (r.stuckAlerts.ok)
    parts.push(`stuck=${r.stuckAlerts.created ?? 0}`);
  if (r.systemAlerts.ok)
    parts.push(`mcp=${r.systemAlerts.mcpCreated ?? 0} token=${r.systemAlerts.tokenCreated ?? 0}`);
  if (r.inactiveCancelled.ok)
    parts.push(`inactive=${r.inactiveCancelled.cancelled ?? 0}`);
  return parts.join(" ");
}

export const monitorAggregatorWorker = new MonitorAggregatorWorker();
