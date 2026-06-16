import { config } from "./config";
import { formatStartupBanner } from "./routes/meta.routes";
import { startAllAgents, stopAllAgents } from "./runtime/agent-pool";
import { isPackagedRuntime } from "./runtime/app-paths";
import { runPlatformBootstrap } from "./runtime/bootstrap/packaged-setup";
import { executionWorker } from "./runtime/execution/execution-worker";
import { experienceMaintenanceWorker } from "./runtime/experience/maintenance-worker";
import { attachExperiencePipes } from "./runtime/experience/pipe-bootstrap";
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

  const boot = await runPlatformBootstrap({ skipPython: !isPackagedRuntime() });
  if (boot.pythonVenv === "created") {
    console.log("[QUBIT] Python venv created for connectors.");
  } else if (boot.pythonVenv === "failed") {
    console.warn(`[QUBIT] Python setup warning: ${boot.pythonMessage ?? "unknown"}`);
  }
  await purgeAllTraderWorkflowsOnce();
  await startAllAgents();
  const restored = await restoreRunningStrategies();
  if (restored > 0) {
    console.log(`[QUBIT] Restored ${restored} strategy runtime(s)`);
  }
  const wfRestore = await restoreRunningWorkflows();
  if (wfRestore.scanned > 0) {
    console.log(
      `[QUBIT] Workflow sweep: scanned=${wfRestore.scanned} resumed=${wfRestore.resumed} ` +
        `cliResumed=${wfRestore.cliResumed} enqueuedRetry=${wfRestore.enqueuedRetry} ` +
        `markedFailed=${wfRestore.markedFailed}`
    );
  }
  workflowScheduler.start();
  executionWorker.start();
  strategyRuntimeWorker.start();
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

  // Start HTTP + WS server
  const server = createServer();
  console.log(`[QUBIT] Server listening on http://${config.host}:${config.port}`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[QUBIT] Shutting down...");
    workflowScheduler.stop();
    executionWorker.stop();
    strategyRuntimeWorker.stop();
    monitorAggregatorWorker.stop();
    experienceMaintenanceWorker.stop();
    skillSelfEvolveWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    workflowScheduler.stop();
    executionWorker.stop();
    strategyRuntimeWorker.stop();
    monitorAggregatorWorker.stop();
    experienceMaintenanceWorker.stop();
    skillSelfEvolveWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[QUBIT] Fatal error:", err);
  process.exit(1);
});
