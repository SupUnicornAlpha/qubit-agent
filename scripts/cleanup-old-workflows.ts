#!/usr/bin/env bun
/**
 * 一次性运维脚本：清理 workflow_run 历史数据。
 *
 * 默认行为：按 created_at 倒序保留最近 N 条（默认 10），把其它全部硬删除。
 *
 * 注意：
 *   - 复用 `hardDeleteWorkflowRun`，确保 a2a_message / agent_step / agent_instance /
 *     llm_call_log / langgraph_checkpoint 等级联子表也被一起清掉，避免外键残留。
 *   - 后端可能正在跑（dev mode），SQLite 已开 WAL + busy_timeout=10s，
 *     通常足够等到写锁。如果撞上正在写入的 workflow，重跑即可（有事务保护）。
 *   - 删除前会自动备份 core.sqlite 到 core.sqlite.bak-cleanup-YYYYMMDD-HHMMSS。
 *
 * 用法：
 *   bun run scripts/cleanup-old-workflows.ts            # 保留最近 10 条
 *   bun run scripts/cleanup-old-workflows.ts --keep=20  # 保留最近 20 条
 *   bun run scripts/cleanup-old-workflows.ts --dry-run  # 仅打印不删除
 */
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config";
import { getDb, getSqliteForTesting } from "../src/db/sqlite/client";
import { hardDeleteWorkflowRun } from "../src/runtime/workflow/hard-delete";

interface WorkflowRow {
  id: string;
  status: string;
  createdAt: string;
}

interface CleanupOptions {
  keep: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CleanupOptions {
  let keep = 10;
  let dryRun = false;
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--keep=")) {
      const n = Number(raw.slice("--keep=".length));
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`[cleanup] invalid --keep: ${raw}`);
      }
      keep = Math.floor(n);
    } else if (raw === "--dry-run" || raw === "-n") {
      dryRun = true;
    } else if (raw === "--help" || raw === "-h") {
      console.log(
        "Usage: bun run scripts/cleanup-old-workflows.ts [--keep=N] [--dry-run]"
      );
      process.exit(0);
    }
  }
  return { keep, dryRun };
}

async function backupDb(): Promise<string> {
  const dbPath = join(config.dataDir, "db", "core.sqlite");
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15); // YYYYMMDDTHHMMSS
  const backupPath = `${dbPath}.bak-cleanup-${ts}`;
  await copyFile(dbPath, backupPath);
  return backupPath;
}

async function main() {
  const { keep, dryRun } = parseArgs(process.argv);

  console.log(
    `[cleanup] dataDir=${config.dataDir}  keep=${keep}  dryRun=${dryRun}`
  );

  await getDb(); // ensure connection + PRAGMA
  const sqlite = getSqliteForTesting();
  const all = sqlite
    .prepare(
      "SELECT id, status, created_at AS createdAt FROM workflow_run ORDER BY datetime(created_at) DESC"
    )
    .all() as WorkflowRow[];

  const total = all.length;
  const survivors = all.slice(0, keep);
  const victims = all.slice(keep);

  console.log(
    `[cleanup] total=${total}  survivors=${survivors.length}  victims=${victims.length}`
  );

  if (survivors.length > 0) {
    console.log("[cleanup] keeping (most recent):");
    for (const w of survivors) {
      console.log(`  - ${w.id}  ${w.status}  ${w.createdAt}`);
    }
  }

  if (victims.length === 0) {
    console.log("[cleanup] nothing to delete; bye.");
    process.exit(0);
  }

  if (dryRun) {
    console.log("[cleanup] dry-run; would delete:");
    for (const w of victims) {
      console.log(`  - ${w.id}  ${w.status}  ${w.createdAt}`);
    }
    process.exit(0);
  }

  const backupPath = await backupDb();
  console.log(`[cleanup] backup written to ${backupPath}`);

  let ok = 0;
  let failed = 0;
  const aggregate: Record<string, number> = {};
  for (const w of victims) {
    try {
      const r = await hardDeleteWorkflowRun(w.id);
      ok += 1;
      for (const [k, v] of Object.entries(r.details)) {
        aggregate[k] = (aggregate[k] ?? 0) + v;
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[cleanup] failed to delete ${w.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  console.log(`[cleanup] done. deleted=${ok}  failed=${failed}`);
  console.log("[cleanup] aggregate cascade counts:");
  const sorted = Object.entries(aggregate)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    console.log(`  ${k.padEnd(36)} ${v}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[cleanup] fatal:", err);
  process.exit(1);
});
