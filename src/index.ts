import { config } from "./config";
import { createServer } from "./server";
import { startAllAgents, stopAllAgents } from "./agents";
import { runMigrations } from "./db/sqlite/migrate";

async function main() {
  console.log(`[QUBIT] Starting in ${config.env} mode...`);

  // Apply DB migrations
  await runMigrations();

  // Start all agents
  await startAllAgents();

  // Start HTTP + WS server
  const server = createServer();
  console.log(`[QUBIT] Server listening on http://${config.host}:${config.port}`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[QUBIT] Shutting down...");
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await stopAllAgents();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[QUBIT] Fatal error:", err);
  process.exit(1);
});
