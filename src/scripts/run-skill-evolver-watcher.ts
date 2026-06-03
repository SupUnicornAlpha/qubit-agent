/**
 * Self-Evolving Agent P6 — SkillEvolverWatcher cron CLI。
 *
 * 默认每 60 min 跑一次（LLM 推理比较贵，频率比 SkillPromoter 低）。
 * 给定 projectId 跑一次：扫 reflective(skill_revision_request) → 调 SkillEvolver.evolve
 * → 回写 evolutionRunId 标记已处理。
 *
 * 用法：
 *   bun run src/scripts/run-skill-evolver-watcher.ts --projectId=prj_xxx [--maxBatch=50] [--json]
 *
 * Exit code：
 *   0 = 成功（含 0 候选）；1 = 有 failed；2 = 参数错 / 内部异常。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { SkillEvolverWatcher } from "../runtime/skill-evolver-watcher/watcher";
import type { WatcherTickSummary } from "../runtime/skill-evolver-watcher/types";

interface CliArgs {
  projectId?: string;
  maxBatch: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { maxBatch: 50, json: false };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId") out.projectId = val;
    else if (key === "maxBatch") out.maxBatch = Math.max(1, Number(val) || 50);
    else if (key === "json") out.json = val !== "false";
  }
  return out;
}

function usage(): void {
  console.error(
    "Usage: bun run run-skill-evolver-watcher.ts --projectId=prj_xxx [--maxBatch=50] [--json]"
  );
}

function renderMarkdown(s: WatcherTickSummary): string {
  const lines: string[] = [];
  lines.push("# SkillEvolverWatcher Tick");
  lines.push("");
  lines.push(`- scanned: ${s.scanned}`);
  lines.push(`- processed: **${s.processed}**`);
  lines.push(`- skipped_base_missing: ${s.skippedBaseMissing}`);
  lines.push(`- skipped_base_archived: ${s.skippedBaseArchived}`);
  lines.push(`- failed: ${s.failed}`);
  lines.push(`- elapsed: ${s.elapsedMs} ms`);
  if (s.results.length > 0) {
    lines.push("");
    lines.push("## 处理详情");
    lines.push("| experience | base skill | status | evolution run | error |");
    lines.push("|---|---|---|---|---|");
    for (const r of s.results.slice(0, 50)) {
      lines.push(
        `| \`${r.experienceId.slice(0, 8)}\` | \`${r.baseSkillId.slice(0, 10)}\` | ${r.status} | \`${r.evolutionRunId?.slice(0, 8) ?? "-"}\` | ${r.errorMessage ?? ""} |`
      );
    }
    if (s.results.length > 50) {
      lines.push(`*（截断；共 ${s.results.length} 行）*`);
    }
  } else {
    lines.push("");
    lines.push("（无待处理请求）");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId) {
    usage();
    process.exit(2);
  }
  await runMigrations();
  const watcher = new SkillEvolverWatcher();
  const summary = await watcher.runOnce({
    projectId: args.projectId,
    maxBatch: args.maxBatch,
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderMarkdown(summary));
  }

  if (summary.failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[skill-evolver-watcher] fatal:", err);
  process.exit(2);
});
