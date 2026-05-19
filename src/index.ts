import { config } from "./config";
import { isPackagedRuntime } from "./runtime/app-paths";
import { runPlatformBootstrap } from "./runtime/bootstrap/packaged-setup";
import { startAllAgents, stopAllAgents } from "./runtime/agent-pool";
import { executionWorker } from "./runtime/execution/execution-worker";
import { restoreRunningStrategies } from "./runtime/strategy/restore-running-strategies";
import { strategyRuntimeWorker } from "./runtime/strategy/strategy-runtime-worker";
import { workflowScheduler } from "./runtime/workflow/scheduler";
import { purgeAllTraderWorkflowsOnce } from "./runtime/trader/trader-workflow";
import { createServer } from "./server";

async function main() {
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
  workflowScheduler.start();
  executionWorker.start();
  strategyRuntimeWorker.start();

  // Start HTTP + WS server
  const server = createServer();
  console.log(`[QUBIT] Server listening on http://${config.host}:${config.port}`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[QUBIT] Shutting down...");
    workflowScheduler.stop();
    executionWorker.stop();
    strategyRuntimeWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    workflowScheduler.stop();
    executionWorker.stop();
    strategyRuntimeWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[QUBIT] Fatal error:", err);
  process.exit(1);
});
