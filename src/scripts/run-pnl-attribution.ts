/**
 * Self-Evolving Agent P4b — PnlAttributor 独立 cron 脚本。
 *
 * 用法：
 *   bun run src/scripts/run-pnl-attribution.ts \
 *     --from=2026-06-01 --to=2026-06-03 [--marketScope=US,CN] [--runtimeIds=rt_xxx,rt_yyy] \
 *     [--dryRun] [--no-skill] [--no-analyst] [--json]
 *
 * 行为：
 *   1) 跑 PnlAttributor.runOnce → 策略层 snapshot + skill 归因 + analyst accuracy 两阶段
 *   2) 输出汇总：默认人类可读 markdown；--json 输出原始 JSON 给监控面板用
 *   3) Exit code：0=完全成功；1=有 errors；2=参数错 / 未捕获异常
 *
 * 推荐节奏：
 *   - US EOD：每天 21:30 ET（21:30 + 5 = 02:30 UTC 次日，UTC+8 早 10:30），跑 --from=昨天 --to=昨天 --marketScope=US
 *   - CN EOD：每天 15:30 CST（07:30 UTC，UTC+8 15:30），跑 --from=今天 --to=今天 --marketScope=CN
 *   - 周末批量补：每周日跑 --from=过去7天 --to=昨天，覆盖全部 market
 *
 * 不做的事：
 *   - 不主动 fetch mark price（由 DailyMarkPriceFetcher 单独脚本负责）；本脚本假设
 *     daily_mark_price 已就绪。mark 缺失时 PnlAttributor 走 fallback_avg_cost 兜底（不 fatal）。
 *   - 不写 logs 表：所有运行轨迹通过 Bus → metrics 流出，前端走 GET /monitor/pnl/* 看快照。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { getDb } from "../db/sqlite/client";
import {
  type PnlAttributorRunSummary,
  createPnlAttributor,
} from "../runtime/attribution/pnl-attributor";

interface CliArgs {
  from?: string;
  to?: string;
  marketScope?: string[];
  runtimeIds?: string[];
  dryRun: boolean;
  evaluateSkills: boolean;
  evaluateAnalyst: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    evaluateSkills: true,
    evaluateAnalyst: true,
    json: false,
  };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "from") args.from = val;
    else if (key === "to") args.to = val;
    else if (key === "marketScope" || key === "market_scope") {
      args.marketScope = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (key === "runtimeIds" || key === "runtime_ids") {
      args.runtimeIds = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (key === "dryRun" || key === "dry-run") args.dryRun = val !== "false";
    else if (key === "no-skill") args.evaluateSkills = false;
    else if (key === "no-analyst") args.evaluateAnalyst = false;
    else if (key === "json") args.json = val !== "false";
  }
  return args;
}

function usage(): void {
  console.error(
    "Usage: bun run run-pnl-attribution.ts --from=YYYY-MM-DD --to=YYYY-MM-DD " +
      "[--marketScope=US,CN] [--runtimeIds=rt_a,rt_b] [--dryRun] [--no-skill] [--no-analyst] [--json]"
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    usage();
    process.exit(2);
  }

  await runMigrations();
  const db = await getDb();
  const attr = createPnlAttributor(db);

  const t0 = Date.now();
  const summary = await attr.runOnce({
    fromDay: args.from,
    toDay: args.to,
    ...(args.marketScope ? { marketScope: args.marketScope } : {}),
    ...(args.runtimeIds ? { runtimeIds: args.runtimeIds } : {}),
    dryRun: args.dryRun,
    attributeSkills: args.evaluateSkills,
    evaluateAnalystAccuracy: args.evaluateAnalyst,
  });
  const elapsedMs = Date.now() - t0;

  if (args.json) {
    console.log(JSON.stringify({ ...summary, elapsedMs }, null, 2));
  } else {
    console.log(renderMarkdown(summary, elapsedMs));
  }

  process.exit(summary.errors.length === 0 ? 0 : 1);
}

function renderMarkdown(summary: PnlAttributorRunSummary, elapsedMs: number): string {
  const lines: string[] = [];
  lines.push("# PnL Attribution Report");
  lines.push("");
  lines.push(`- Range: \`${summary.fromDay}\` ~ \`${summary.toDay}\``);
  lines.push(`- Dry-run: \`${summary.dryRun}\``);
  lines.push(`- Elapsed: ${elapsedMs} ms`);
  lines.push(`- Started: \`${summary.startedAt}\`  Ended: \`${summary.endedAt}\``);
  lines.push("");
  lines.push("## Strategy Layer");
  lines.push(`- runtimes scanned: ${summary.runtimesScanned}`);
  lines.push(`- runtimes processed: ${summary.runtimesProcessed}`);
  lines.push(`- runtimes skipped: ${summary.runtimesSkipped}`);
  lines.push(`- fills scanned: ${summary.fillsScanned}`);
  lines.push(`- snapshots written: ${summary.snapshotsWritten}`);
  if (summary.skillAttribution) {
    lines.push("");
    lines.push("## Skill Layer");
    lines.push(`- attribution rows upserted: ${summary.skillAttribution.attributionRowsUpserted}`);
    lines.push(`- items skipped (no executed skill): ${summary.skillAttribution.itemsSkippedNoSkill}`);
    lines.push(`- skill_run.pnlDelta updated: ${summary.skillAttribution.skillRunsUpdated}`);
    lines.push(`- skills recomputed: ${summary.skillAttribution.skillsRecomputed}`);
  } else {
    lines.push("");
    lines.push("## Skill Layer: skipped (attributeSkills=false 或 dryRun)");
  }
  if (summary.analystAccuracy) {
    lines.push("");
    lines.push("## Analyst Accuracy");
    lines.push(`- placeholders inserted: ${summary.analystAccuracy.sync.placeholdersInserted}`);
    lines.push(`- evaluated: ${summary.analystAccuracy.evaluate.evaluated}`);
    lines.push(`- skipped (no mark): ${summary.analystAccuracy.evaluate.skippedNoMark}`);
    lines.push(`- skipped (no future mark): ${summary.analystAccuracy.evaluate.skippedNoFutureMark}`);
    if (summary.analystAccuracy.evaluate.failures.length > 0) {
      lines.push(`- failures: ${summary.analystAccuracy.evaluate.failures.length}`);
    }
  } else {
    lines.push("");
    lines.push("## Analyst Accuracy: skipped");
  }
  if (summary.errors.length > 0) {
    lines.push("");
    lines.push("## Errors");
    for (const e of summary.errors) {
      lines.push(`- \`${e.strategyRuntimeId}\`: ${e.reason}`);
    }
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error("[pnl-attribution] fatal:", err);
  process.exit(2);
});
