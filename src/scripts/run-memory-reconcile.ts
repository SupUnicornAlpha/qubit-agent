/**
 * Memory V2 双写对账 CLI — Memory V2 P1.5
 *
 * 用法：
 *   bun run src/scripts/run-memory-reconcile.ts --projectId=<id> [--sinceDays=7] [--json]
 *
 * 输出：默认人类可读 markdown 报告；--json 输出 ReconcileReport 原始 JSON 给监控面板用。
 *
 * 推荐节奏：每天一次（cron），到 7d 连续 `recommendation=ok_to_sunset`
 * 即可去 src/runtime/monitor/observability-hook.ts 删旧 consolidate 一段。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { reconcileProject } from "../runtime/experience/reconciliation";

interface CliArgs {
  projectId?: string;
  sinceDays: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { sinceDays: 7, json: false };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId" || key === "project_id") args.projectId = val;
    else if (key === "sinceDays") args.sinceDays = Math.max(1, Number(val) || 7);
    else if (key === "json") args.json = val !== "false";
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId) {
    console.error(
      "Usage: bun run run-memory-reconcile.ts --projectId=<id> [--sinceDays=7] [--json]"
    );
    process.exit(2);
  }

  await runMigrations();

  const now = new Date();
  const since = new Date(now.getTime() - args.sinceDays * 86_400_000);
  const report = await reconcileProject({
    projectId: args.projectId,
    since,
    now,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.summary);
  }

  process.exit(report.recommendation === "ok_to_sunset" ? 0 : 1);
}

main().catch((err) => {
  console.error("[memory-reconcile] fatal:", err);
  process.exit(2);
});
