import { config } from "./config";
import { isPackagedRuntime } from "./runtime/app-paths";
import { runPlatformBootstrap } from "./runtime/bootstrap/packaged-setup";
import { startAllAgents, stopAllAgents } from "./runtime/agent-pool";
import { executionWorker } from "./runtime/execution/execution-worker";
import { installAcpMonitoringHook } from "./runtime/monitor/acp-monitoring-hook";
import { monitorAggregatorWorker } from "./runtime/monitor/monitor-aggregator-worker";
import { restoreRunningStrategies } from "./runtime/strategy/restore-running-strategies";
import { strategyRuntimeWorker } from "./runtime/strategy/strategy-runtime-worker";
import { restoreRunningWorkflows } from "./runtime/workflow/restore-running-workflows";
import { workflowScheduler } from "./runtime/workflow/scheduler";
import { purgeAllTraderWorkflowsOnce } from "./runtime/trader/trader-workflow";
import { formatStartupBanner } from "./routes/meta.routes";
import { createServer } from "./server";

async function main() {
  /** banner 单独打一行明显的分隔，便于 `tail -f dev-backend.log` 数重启次数 / 看 commit */
  console.log(formatStartupBanner());
  console.log(`[QUBIT] Starting in ${config.env} mode...`);
  if (isPackagedRuntime()) {
    console.log(`[QUBIT] Packaged app root: ${process.env["QUBIT_APP_ROOT"]}`);
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
  // 监控 V2 P2：在 ACP caller 注入 connector_call_log 写入 hook。幂等。
  installAcpMonitoringHook();

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
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    workflowScheduler.stop();
    executionWorker.stop();
    strategyRuntimeWorker.stop();
    monitorAggregatorWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[QUBIT] Fatal error:", err);
  process.exit(1);
});
