import { config } from "./config";
import { registerBuiltinConnectors } from "./connectors/bootstrap";
import { runMigrations } from "./db/sqlite/migrate";
import { startAllAgents, stopAllAgents } from "./runtime/agent-pool";
import {
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
} from "./runtime/config/workspace-config";
import { executionWorker } from "./runtime/execution/execution-worker";
import { seedAgentDefinitions } from "./runtime/seed-agent-definitions";
import { SEED_AGENT_DEFINITIONS } from "./runtime/seed-agent-definitions-data";
import { workflowScheduler } from "./runtime/workflow/scheduler";
import { createServer } from "./server";

async function main() {
  console.log(`[QUBIT] Starting in ${config.env} mode...`);

  // Apply DB migrations
  await runMigrations();
  await seedAgentDefinitions();
  await ensureWorkspaceRuntimeConfigFiles({
    definitions: SEED_AGENT_DEFINITIONS,
    policies: buildDefaultSandboxPoliciesFromDefinitions(SEED_AGENT_DEFINITIONS),
  });

  await registerBuiltinConnectors();
  await startAllAgents();
  workflowScheduler.start();
  executionWorker.start();

  // Start HTTP + WS server
  const server = createServer();
  console.log(`[QUBIT] Server listening on http://${config.host}:${config.port}`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[QUBIT] Shutting down...");
    workflowScheduler.stop();
    executionWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    workflowScheduler.stop();
    executionWorker.stop();
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[QUBIT] Fatal error:", err);
  process.exit(1);
});
