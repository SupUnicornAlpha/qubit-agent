#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb, getSqliteForTesting } from "../src/db/sqlite/client";
import { loadOrchestratorTopologyForWorkflow } from "../src/runtime/orchestration/topology-dispatch";
import { runGlobalToolSyntheticSmoke } from "../src/runtime/benchmark/tool-synthetic-smoke";

await getDb();
const sqlite = getSqliteForTesting();
const enabledMcpServers = (
  sqlite
    .prepare("SELECT DISTINCT name FROM mcp_server_config WHERE enabled=1 ORDER BY name")
    .all() as Array<{ name: string }>
).map((row) => row.name);
const topology = await loadOrchestratorTopologyForWorkflow().catch(() => null);
const results = runGlobalToolSyntheticSmoke({
  topologyTools: topology?.toolNames ?? [],
  enabledMcpServers,
});
const failed = results.filter((result) => !result.ok);
const outputDir = resolve(process.env.QUBIT_BENCH_OUT ?? "out/qubit-bench/smoke");
await mkdir(outputDir, { recursive: true });
await writeFile(
  resolve(outputDir, "tool-smoke.json"),
  JSON.stringify(
    {
      schemaVersion: "1.0",
      generatedAt: new Date().toISOString(),
      summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
      results,
    },
    null,
    2
  )
);
console.log(`[tool-smoke] total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
for (const failure of failed) console.error(`[tool-smoke] FAIL ${failure.name}: ${failure.detail}`);
if (failed.length > 0) process.exit(1);
