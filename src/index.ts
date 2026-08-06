import { config } from "./config";
import { formatStartupBanner } from "./routes/meta.routes";
import { startAllAgents, stopAllAgents } from "./runtime/agent-pool";
import { isPackagedRuntime } from "./runtime/app-paths";
import { ensurePythonRuntime, runPlatformBootstrap } from "./runtime/bootstrap/packaged-setup";
import { recommendationOutcomeWorker } from "./runtime/effect-validation/recommendation-outcome-evaluator";
import { executionWorker } from "./runtime/execution/execution-worker";
import { experienceMaintenanceWorker } from "./runtime/experience/maintenance-worker";
import { attachExperiencePipes } from "./runtime/experience/pipe-bootstrap";
import { runMarketDataReadinessGate } from "./runtime/market/market-data-health";
import { monitorAggregatorWorker } from "./runtime/monitor/monitor-aggregator-worker";
import { skillSelfEvolveWorker } from "./runtime/skills/skill-self-evolve-worker";
import { restoreRunningStrategies } from "./runtime/strategy/restore-running-strategies";
import { strategyRuntimeWorker } from "./runtime/strategy/strategy-runtime-worker";
import { purgeAllTraderWorkflowsOnce } from "./runtime/trader/trader-workflow";
import { restoreRunningWorkflows } from "./runtime/workflow/restore-running-workflows";
import { workflowScheduler } from "./runtime/workflow/scheduler";
import { createServer } from "./server";

async function main() {
  /** banner 单独打一行明显的分隔，便于 `tail -f dev-backend.log` 数重启次数 / 看 commit */
  console.log(formatStartupBanner());
  console.log(`[QUBIT] Starting in ${config.env} mode...`);
  if (isPackagedRuntime()) {
    console.log(`[QUBIT] Packaged app root: ${process.env.QUBIT_APP_ROOT}`);
    console.log(`[QUBIT] Data directory: ${config.dataDir}`);
  }

  // Python venv 准备可能涉及坏二进制探测或 pip 网络访问，不能阻塞核心 HTTP。
  await runPlatformBootstrap({ skipPython: true });
  await purgeAllTraderWorkflowsOnce();
  await startAllAgents();
  const restored = await restoreRunningStrategies();
  if (restored > 0) {
    console.log(`[QUBIT] Restored ${restored} strategy runtime(s)`);
  }
  if (process.env.QUBIT_SKIP_WORKFLOW_RESTORE === "1") {
    console.log("[QUBIT] Workflow sweep skipped (QUBIT_SKIP_WORKFLOW_RESTORE=1)");
  } else {
    const wfRestore = await restoreRunningWorkflows();
    if (wfRestore.scanned > 0) {
      console.log(
        `[QUBIT] Workflow sweep: scanned=${wfRestore.scanned} resumed=${wfRestore.resumed} ` +
          `cliResumed=${wfRestore.cliResumed} enqueuedRetry=${wfRestore.enqueuedRetry} ` +
          `markedFailed=${wfRestore.markedFailed}`
      );
    }
  }
  workflowScheduler.start();
  executionWorker.start();
  recommendationOutcomeWorker.start();
  strategyRuntimeWorker.start();
  const { startSimEventReactor } = await import("./runtime/trading/sim-event-reactor");
  startSimEventReactor();
  // 监控聚合 + 告警扫描 worker（P2-4）：每 5min 跑一次 aggregateMetrics +
  // stuckWorkflowAlerts + scanAllSystemAlerts；任一阶段失败仅 warn，不影响主链路。
  monitorAggregatorWorker.start();
  // Memory V2 P1.5：每小时跑一次 ExperienceJanitor —— 重算 qualityScore + decay/archive。
  // 单 tick 全程串行，失败仅 warn。
  experienceMaintenanceWorker.start();
  // P1（2026-06）：进程内 Skill 自进化 worker——定时枚举 active 项目跑
  // SkillPromoter / SkillEvolverWatcher / SkillBaselineObserver（此前只有外部 cron，
  // 生产几乎不跑 → P0 接通的 Extractor 候选无人晋升）。受 SELF_EVOLVE_ENABLED 总闸约束。
  skillSelfEvolveWorker.start();
  /**
   * Wave-1（2026-06-10）：attach experience pipes（目前只接 workflow-summarizer）。
   * 见 src/runtime/experience/pipe-bootstrap.ts 的 JSDoc 说明历史断点 + 这一波只接一个。
   */
  attachExperiencePipes();

  // 先听端口（Legacy Bridge 可被 Core 回调），再拉起/附着 Rust Core。
  const server = createServer();
  console.log(`[QUBIT] Server listening on http://${config.host}:${config.port}`);

  const bridgeHost = config.host === "localhost" ? "127.0.0.1" : config.host;
  const bridgeUrl = `http://${bridgeHost}:${config.port}/api/v1/prime-bridge`;
  process.env.QUBIT_LEGACY_BRIDGE_URL =
    process.env.QUBIT_LEGACY_BRIDGE_URL?.trim() || bridgeUrl;

  const { ensureRustCoreRunning, stopOwnedRustCore } = await import(
    "./runtime/prime/spawn-core"
  );
  const { attachPrimeCore, resolveAttachMode } = await import("./runtime/prime/attach");
  const attachMode = resolveAttachMode(config.coreBackend);

  if (config.spawnRustCore && attachMode !== "ts") {
    const core = await ensureRustCoreRunning({
      rustCoreUrl: config.rustCoreUrl,
      bridgeUrl: process.env.QUBIT_LEGACY_BRIDGE_URL,
    });
    console.log(
      `[QUBIT] Rust Core: spawned=${core.spawned} url=${core.url}` +
        (core.pid ? ` pid=${core.pid}` : "") +
        ` (${core.reason})`
    );
  }

  const attach = await attachPrimeCore({
    mode: attachMode,
    rustCoreUrl: config.rustCoreUrl,
  });
  console.log(
    `[QUBIT] Prime Core attach: mode=${attach.mode} active=${attach.activeBackend} ` +
      `healthy=${attach.healthy} synced=${attach.syncedSpecs ?? "-"} (${attach.reason})`
  );
  console.log(
    `[QUBIT] Core backend=${attach.activeBackend}` +
      (attach.activeBackend === "rust" ? ` url=${attach.rustCoreUrl}` : "") +
      ` bridge=${process.env.QUBIT_LEGACY_BRIDGE_URL}`
  );

  // Block silent TS ReAct fallback when debugging / defaulting to Rust Core.
  if (attachMode === "rust" && (!attach.healthy || attach.activeBackend !== "rust")) {
    console.error(
      `[QUBIT] FATAL: QUBIT_CORE_BACKEND=rust but Core is not healthy ` +
        `(active=${attach.activeBackend}, reason=${attach.reason}). ` +
        `Refusing to fall back to TS. Build/start qubit-app-server or set ` +
        `QUBIT_CORE_BACKEND=ts / QUBIT_CORE_STRICT=0 explicitly.`
    );
    process.exit(1);
  }

  // 行情 readiness 会访问多个外部 provider，网络异常时可能耗时数十秒。
  // 必须在 HTTP 已监听后异步执行：服务先以 degraded/checking 对外提供 `/health`，
  // 探针完成后再切换 readiness，避免客户端把“探针尚未完成”误判成后端启动失败。
  void runMarketDataReadinessGate().catch((e) => {
    console.warn(`[MarketData] startup readiness gate failed: ${(e as Error).message}`);
  });
  if (isPackagedRuntime()) {
    void ensurePythonRuntime()
      .then((python) => {
        if (python.status === "created") {
          console.log("[QUBIT] Python venv created for connectors.");
        } else if (python.status === "failed") {
          console.warn(`[QUBIT] Python setup warning: ${python.message ?? "unknown"}`);
        }
      })
      .catch((error) => {
        console.warn(`[QUBIT] Python setup warning: ${(error as Error).message}`);
      });
  }

  const shutdown = async (signal: string) => {
    console.log(`\n[QUBIT] Shutting down (${signal})...`);
    stopOwnedRustCore();
    workflowScheduler.stop();
    executionWorker.stop();
    recommendationOutcomeWorker.stop();
    strategyRuntimeWorker.stop();
    const { stopSimEventReactor } = await import("./runtime/trading/sim-event-reactor");
    stopSimEventReactor();
    monitorAggregatorWorker.stop();
    experienceMaintenanceWorker.stop();
    skillSelfEvolveWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", () => {
    stopOwnedRustCore();
  });
}

main().catch((err) => {
  console.error("[QUBIT] Fatal error:", err);
  process.exit(1);
});
