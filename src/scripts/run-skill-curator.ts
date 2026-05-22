/**
 * Skill Curator runner — M11.C2
 *
 * 用法：
 *   bun run src/scripts/run-skill-curator.ts --projectId=<id> [--mode=dry_run|live] [--no-llm]
 *
 * 建议用 cron / systemd-timer / 工作流 hook 周期触发：
 *   每 12h 跑一次 dry_run，由人审 skill_curator_run.summary_yaml 后再跑 live。
 *
 * 失败不会中断进程：错误写入 skill_curator_run.error_message，进程退出码反映 success/failure。
 */
import { runMigrations } from "../db/sqlite/migrate";
import { skillCurator } from "../runtime/skills/skill-curator";

interface CliArgs {
  projectId?: string;
  mode: "dry_run" | "live";
  useLlm: boolean;
  triggeredBy: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "dry_run", useLlm: true, triggeredBy: "cli" };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId" || key === "project_id") args.projectId = val;
    else if (key === "mode" && (val === "dry_run" || val === "live")) args.mode = val;
    else if (key === "no-llm") args.useLlm = false;
    else if (key === "triggeredBy") args.triggeredBy = val;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectId) {
    console.error("Usage: bun run run-skill-curator.ts --projectId=<id> [--mode=dry_run|live] [--no-llm]");
    process.exit(2);
  }

  await runMigrations();
  console.log(`[curator] running on project=${args.projectId} mode=${args.mode} useLlm=${args.useLlm}`);
  const result = await skillCurator.run({
    projectId: args.projectId,
    mode: args.mode,
    useLlm: args.useLlm,
    triggeredBy: args.triggeredBy,
  });
  console.log(`[curator] ${result.summaryText}`);
  if (result.status === "failed") {
    console.error(`[curator] failed: ${result.errorMessage}`);
    process.exit(1);
  }
  console.log(`[curator] run_id=${result.curatorRunId} → view via /api/skills/curator-runs`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[curator] fatal:", err);
    process.exit(1);
  });
}
