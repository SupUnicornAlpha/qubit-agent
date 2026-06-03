/**
 * Self-Evolving Agent P9 — SkillBaselineObserver cron CLI。
 *
 * 默认每日跑一次（与 SkillPromoter 一档；都在 self-evolve 周期任务里）。
 * 给定 projectId 跑一次：扫 evolved+pending_review skill → 召回观察期达标的自动 enable。
 *
 * 用法：
 *   bun run src/scripts/run-skill-baseline-observer.ts --projectId=prj_xxx
 *     [--observationWindowDays=14] [--minRecallCount=3] [--minSignaledRuns=2]
 *     [--minSuccessRate=0.6] [--maxApprovesPerRun=20] [--json]
 *
 * Exit code:
 *   0 = 成功；1 = status=failed；2 = 参数错 / 内部异常。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { SkillBaselineObserver } from "../runtime/skill-baseline-observer/observer";
import type { SkillBaselineObserverSummary } from "../runtime/skill-baseline-observer/observer";

interface CliArgs {
  projectId?: string;
  observationWindowDays: number;
  minRecallCount: number;
  minSignaledRuns: number;
  minSuccessRate: number;
  maxApprovesPerRun: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    observationWindowDays: 14,
    minRecallCount: 3,
    minSignaledRuns: 2,
    minSuccessRate: 0.6,
    maxApprovesPerRun: 20,
    json: false,
  };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId") out.projectId = val;
    else if (key === "observationWindowDays")
      out.observationWindowDays = Math.max(1, Number(val) || 14);
    else if (key === "minRecallCount") out.minRecallCount = Math.max(1, Number(val) || 3);
    else if (key === "minSignaledRuns") out.minSignaledRuns = Math.max(1, Number(val) || 2);
    else if (key === "minSuccessRate") {
      const n = Number(val);
      out.minSuccessRate = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6;
    } else if (key === "maxApprovesPerRun")
      out.maxApprovesPerRun = Math.max(1, Number(val) || 20);
    else if (key === "json") out.json = val !== "false";
  }
  return out;
}

function usage(): void {
  console.error(
    "Usage: bun run run-skill-baseline-observer.ts --projectId=prj_xxx [--observationWindowDays=14] [--minRecallCount=3] [--minSignaledRuns=2] [--minSuccessRate=0.6] [--maxApprovesPerRun=20] [--json]"
  );
}

function renderMarkdown(s: SkillBaselineObserverSummary): string {
  const lines: string[] = [];
  lines.push("# SkillBaselineObserver Tick");
  lines.push("");
  lines.push(`- status: ${s.status}`);
  if (s.reason) lines.push(`- reason: ${s.reason}`);
  lines.push(`- elapsed: ${s.elapsedMs} ms`);
  lines.push("");
  lines.push("## 摘要");
  lines.push(`- candidates scanned: ${s.scanned}`);
  lines.push(`- approved (auto-enabled): **${s.approved}**`);
  lines.push(`- not ready: ${s.notReady}`);
  lines.push(`- errors: ${s.errors}`);
  if (s.results.length > 0) {
    lines.push("");
    lines.push("## 详情（top 10）");
    for (const r of s.results.slice(0, 10)) {
      lines.push(
        `- \`${r.skillId.slice(0, 8)}\` **${r.name}** — ${r.action} recall=${r.recallCount} signaled=${r.signaledRunCount} success=${r.successCount}/${r.failCount} rate=${(r.successRate * 100).toFixed(0)}%${r.reason ? ` (${r.reason})` : ""}`
      );
    }
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
  const summary = await new SkillBaselineObserver().runOnce({
    projectId: args.projectId,
    observationWindowDays: args.observationWindowDays,
    minRecallCount: args.minRecallCount,
    minSignaledRuns: args.minSignaledRuns,
    minSuccessRate: args.minSuccessRate,
    maxApprovesPerRun: args.maxApprovesPerRun,
  });

  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(renderMarkdown(summary));
  if (summary.status === "failed") process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[skill-baseline-observer] fatal:", err);
  process.exit(2);
});
