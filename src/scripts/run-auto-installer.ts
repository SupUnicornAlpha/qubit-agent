/**
 * Self-Evolving Agent P8 — AutoInstaller cron CLI（propose 模式）。
 *
 * 默认每 60 min 跑一次（与 ToolGapWatcher 一档；都在 self-evolve 周期任务里）。
 * 给定 projectId 跑一次：扫 tool_gap_log.status=open → 写 auto_install_proposal。
 *
 * 用法：
 *   bun run src/scripts/run-auto-installer.ts --projectId=prj_xxx
 *     [--maxGapsPerRun=50] [--scoreThreshold=0.3] [--topK=3] [--json]
 *
 * Exit code：
 *   0 = 成功；1 = status=failed；2 = 参数错 / 内部异常。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { AutoInstaller } from "../runtime/auto-installer/installer";
import type { AutoInstallerRunSummary } from "../runtime/auto-installer/types";

interface CliArgs {
  projectId?: string;
  maxGapsPerRun: number;
  scoreThreshold: number;
  topK: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    maxGapsPerRun: 50,
    scoreThreshold: 0.3,
    topK: 3,
    json: false,
  };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId") out.projectId = val;
    else if (key === "maxGapsPerRun") out.maxGapsPerRun = Math.max(1, Number(val) || 50);
    else if (key === "scoreThreshold") out.scoreThreshold = Math.max(0, Number(val) || 0.3);
    else if (key === "topK") out.topK = Math.max(1, Number(val) || 3);
    else if (key === "json") out.json = val !== "false";
  }
  return out;
}

function usage(): void {
  console.error(
    "Usage: bun run run-auto-installer.ts --projectId=prj_xxx [--maxGapsPerRun=50] [--scoreThreshold=0.3] [--topK=3] [--json]"
  );
}

function renderMarkdown(s: AutoInstallerRunSummary): string {
  const lines: string[] = [];
  lines.push(`# AutoInstaller Tick · \`${s.runId.slice(0, 8)}\``);
  lines.push("");
  lines.push(`- project: \`${s.projectId}\``);
  lines.push(`- status: ${s.status}`);
  lines.push(`- elapsed: ${s.elapsedMs} ms`);
  lines.push(`- started: \`${s.startedAt}\` → \`${s.endedAt ?? "-"}\``);
  lines.push("");
  lines.push("## 摘要");
  lines.push(`- gaps scanned: ${s.gapsScanned}`);
  lines.push(`- proposals created: **${s.proposalsCreated}**`);
  lines.push(`- skipped existing: ${s.proposalsSkippedExisting}`);
  lines.push(`- no candidate: ${s.proposalsNoCandidate}`);
  if (s.errorMessage) {
    lines.push("");
    lines.push(`> error: ${s.errorMessage}`);
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
  const summary = await new AutoInstaller().runOnce({
    projectId: args.projectId,
    maxGapsPerRun: args.maxGapsPerRun,
    scoreThreshold: args.scoreThreshold,
    topK: args.topK,
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
  console.error("[auto-installer] fatal:", err);
  process.exit(2);
});
