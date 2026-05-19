import { config } from "./config";
import { registerBuiltinConnectors } from "./connectors/bootstrap";
import { runMigrations } from "./db/sqlite/migrate";
import { startAllAgents, stopAllAgents } from "./runtime/agent-pool";
import {
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
} from "./runtime/config/workspace-config";
import { executionWorker } from "./runtime/execution/execution-worker";
import { restoreRunningStrategies } from "./runtime/strategy/restore-running-strategies";
import { strategyRuntimeWorker } from "./runtime/strategy/strategy-runtime-worker";
import { seedAgentDefinitions } from "./runtime/seed-agent-definitions";
import { SEED_AGENT_DEFINITIONS } from "./runtime/seed-agent-definitions-data";
import { workflowScheduler } from "./runtime/workflow/scheduler";
import { purgeAllTraderWorkflowsOnce } from "./runtime/trader/trader-workflow";
import { createServer } from "./server";

async function main() {
  console.log(`[QUBIT] Starting in ${config.env} mode...`);

  // Apply DB migrations
  await runMigrations();
  await seedAgentDefinitions();
  await ensureWorkspaceRuntimeConfigFiles({
    definitions: SEED_AGENT_DEFINITIONS,
    policies: buildDefaultSandboxPoliciesFromDefinitions(SEED_AGENT_DEFINITIONS),
    refresh: true,
  });

  await registerBuiltinConnectors();
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
