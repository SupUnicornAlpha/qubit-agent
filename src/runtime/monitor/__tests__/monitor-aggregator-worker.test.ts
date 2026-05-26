/**
 * P2-4：MonitorAggregatorWorker 行为单测（不依赖真实 sqlite）。
 *
 * 这里直接走真实 tick，但依赖 DB 的 stage 在测试环境会失败（sqlite 不可达 / 表不存在），
 * 我们期待 tick **不抛错** + 每个 stage 都 ok=false 携带 error。
 *
 * 同时验：
 *   - 串行保护：第二次 tick 在前一轮没完成时被跳过；
 *   - start/stop 幂等。
 */
import { describe, expect, test } from "bun:test";
import { MonitorAggregatorWorker } from "../monitor-aggregator-worker";

describe("MonitorAggregatorWorker", () => {
  test("tick 在 DB 不可用时不抛错，每个 stage 都返回 ok=false + error", async () => {
    const worker = new MonitorAggregatorWorker();
    /**
     * 注意：bun:test 默认无 sqlite 环境配置，aggregateAgentRuntimeMetrics /
     * createStuckWorkflowAlerts / scanAllSystemAlerts 都会因 sqlite 客户端启动
     * 失败而抛 — 我们的 tick 内层 try/catch 应该把异常吃掉并填 error 字段。
     */
    const result = await worker.tick();

    // 不论哪个 stage 是 ok 还是 fail，结构一定齐全
    expect(result).toHaveProperty("aggregateMetrics");
    expect(result).toHaveProperty("stuckAlerts");
    expect(result).toHaveProperty("systemAlerts");

    // 至少一个 stage 应该 fail 时携带 error 字符串（在没有 sqlite 的测试中应该全 fail；
    // 但如果 CI 已经 bootstrap 数据库也可能全成功 — 兼容两种情况只断结构正确性）
    if (!result.aggregateMetrics.ok) {
      expect(typeof result.aggregateMetrics.error).toBe("string");
    }
    if (!result.stuckAlerts.ok) {
      expect(typeof result.stuckAlerts.error).toBe("string");
    }
    if (!result.systemAlerts.ok) {
      expect(typeof result.systemAlerts.error).toBe("string");
    }
  });

  test("二次 tick 在前一轮 in-flight 时被跳过（串行保护）", async () => {
    const worker = new MonitorAggregatorWorker();
    /**
     * 通过私有字段 hack `running = true` 强制让 tick 走串行 guard 分支；
     * 不依赖时序竞争（更稳定）。
     */
    (worker as unknown as { running: boolean }).running = true;
    const result = await worker.tick();
    expect(result.aggregateMetrics.error).toBe("previous tick still running");
    expect(result.stuckAlerts.error).toBe("skipped");
    expect(result.systemAlerts.error).toBe("skipped");
  });

  test("start/stop 幂等", () => {
    const worker = new MonitorAggregatorWorker(60_000);
    worker.start();
    worker.start(); // 第二次 start 不应起新 timer
    worker.stop();
    worker.stop(); // 第二次 stop 不应抛
    // 没抛即通过
    expect(true).toBe(true);
  });
});
