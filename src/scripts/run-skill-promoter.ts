/**
 * Self-Evolving Agent P5 — SkillPromoter cron CLI。
 *
 * 默认每 30 min 跑（部署时由系统 cron / launchd / k8s CronJob 调度）。
 * 给定 projectId 跑一次：扫描 procedural workflow_play → 评分 → live 落 pending_review。
 *
 * 用法：
 *   bun run src/scripts/run-skill-promoter.ts --projectId=prj_xxx [--mode=live] [--json]
 *     --mode=dry_run（默认）：仅评分 + 写 skill_promotion_run，不动 agent_skill
 *     --mode=live：合格候选写 pending_review，等用户审批
 *     --json：JSON 输出（不是 markdown）
 *     --triggeredBy=cron|manual|api
 *
 * Exit code：
 *   0 = 成功；1 = 跑批 status=failed 或 promoted 失败；2 = 参数错 / 内部异常。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { SkillPromoter } from "../runtime/skill-promoter/skill-promoter";
import type { PromoterRunSummary } from "../runtime/skill-promoter/types";

interface CliArgs {
  projectId?: string;
  mode: "dry_run" | "live";
  json: boolean;
  triggeredBy: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { mode: "dry_run", json: false, triggeredBy: "cron" };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId") out.projectId = val;
    else if (key === "mode") {
      if (val === "live" || val === "dry_run") out.mode = val;
    } else if (key === "json") out.json = val !== "false";
    else if (key === "triggeredBy") out.triggeredBy = val;
  }
  return out;
}

function usage(): void {
  console.error(
    "Usage: bun run run-skill-promoter.ts --projectId=prj_xxx [--mode=dry_run|live] [--json] [--triggeredBy=cron]"
  );
}

function renderMarkdown(r: PromoterRunSummary): string {
  const lines: string[] = [];
  lines.push(`# SkillPromoter Run · \`${r.runId.slice(0, 8)}\``);
  lines.push("");
  lines.push(`- project: \`${r.projectId}\``);
  lines.push(`- mode: **${r.mode}**`);
  lines.push(`- status: ${r.status === "completed" ? "✓ completed" : "✗ failed"}`);
  lines.push(`- triggeredBy: \`${r.triggeredBy}\``);
  lines.push(`- elapsed: ${r.elapsedMs} ms`);
  lines.push("");
  lines.push("## 汇总");
  lines.push(`- scanned: ${r.totalScanned}`);
  lines.push(`- qualified: ${r.totalQualified}`);
  lines.push(`- promoted: ${r.totalPromoted}`);
  lines.push(`- skipped_duplicate: ${r.totalSkippedDuplicate}`);
  lines.push(`- skipped_insufficient: ${r.totalSkippedInsufficient}`);
  if (r.errorMessage) {
    lines.push("");
    lines.push(`> error: ${r.errorMessage}`);
  }
  if (r.actions.length > 0) {
    lines.push("");
    lines.push("## 候选（最多展示 30 条）");
    lines.push("| signature | status | score | 命中 gate |");
    lines.push("|---|---|---:|---|");
    for (const a of r.actions.slice(0, 30)) {
      const gates = a.ruleHits
        .filter((h) => h.rule.startsWith("gate_"))
        .map((h) => `${h.rule.replace("gate_", "")}${h.passed ? "✓" : "✗"}`)
        .join(" ");
      lines.push(
        `| \`${a.signature.slice(0, 48)}\` | ${a.status} | ${a.score.toFixed(3)} | ${gates} |`
      );
    }
    if (r.actions.length > 30) {
      lines.push(`*（截断；共 ${r.actions.length} 候选）*`);
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
  const promoter = new SkillPromoter();
  const summary = await promoter.runOnce({
    projectId: args.projectId,
    mode: args.mode,
    triggeredBy: args.triggeredBy,
  });

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderMarkdown(summary));
  }

  if (summary.status === "failed") process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("[skill-promoter] fatal:", err);
  process.exit(2);
});
