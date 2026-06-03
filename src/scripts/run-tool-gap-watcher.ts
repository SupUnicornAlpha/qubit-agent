/**
 * Self-Evolving Agent P7 — ToolGapWatcher cron CLI。
 *
 * 默认每 60 min 跑一次（与 SkillEvolverWatcher 一档；都是"agent 自进化"周期任务）。
 * 给定 projectId 跑一次：扫 tool_call_log + reflective → 折叠 → upsert tool_gap_log。
 *
 * 用法：
 *   bun run src/scripts/run-tool-gap-watcher.ts --projectId=prj_xxx
 *     [--windowHours=24] [--repeatedFailThreshold=3] [--maxSignalsPerDetector=500] [--json]
 *
 * Exit code：
 *   0 = 成功；1 = 跑批 status=failed；2 = 参数错 / 内部异常。
 */

import { runMigrations } from "../db/sqlite/migrate";
import { ToolGapWatcher } from "../runtime/tool-gap-watcher/watcher";
import type { WatcherRunSummary } from "../runtime/tool-gap-watcher/types";

interface CliArgs {
  projectId?: string;
  windowHours: number;
  repeatedFailThreshold: number;
  maxSignalsPerDetector: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    windowHours: 24,
    repeatedFailThreshold: 3,
    maxSignalsPerDetector: 500,
    json: false,
  };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "projectId") out.projectId = val;
    else if (key === "windowHours") out.windowHours = Math.max(1, Number(val) || 24);
    else if (key === "repeatedFailThreshold")
      out.repeatedFailThreshold = Math.max(2, Number(val) || 3);
    else if (key === "maxSignalsPerDetector")
      out.maxSignalsPerDetector = Math.max(1, Number(val) || 500);
    else if (key === "json") out.json = val !== "false";
  }
  return out;
}

function usage(): void {
  console.error(
    "Usage: bun run run-tool-gap-watcher.ts --projectId=prj_xxx [--windowHours=24] [--repeatedFailThreshold=3] [--maxSignalsPerDetector=500] [--json]"
  );
}

function renderMarkdown(s: WatcherRunSummary): string {
  const lines: string[] = [];
  lines.push(`# ToolGapWatcher Tick · \`${s.runId.slice(0, 8)}\``);
  lines.push("");
  lines.push(`- project: \`${s.projectId}\``);
  lines.push(`- window: \`${s.fromTs}\` → \`${s.toTs}\``);
  lines.push(`- status: ${s.status}`);
  lines.push(`- elapsed: ${s.elapsedMs} ms`);
  lines.push("");
  lines.push("## 信号");
  lines.push(`- unknown_tool: ${s.unknownToolCount}`);
  lines.push(`- repeated_fail: ${s.repeatedFailCount}`);
  lines.push(`- reflective_mention: ${s.reflectiveMentionCount}`);
  lines.push(`- **total: ${s.totalSignals}**`);
  lines.push("");
  lines.push("## Gap 操作");
  lines.push(`- created: **${s.gapsCreated}**`);
  lines.push(`- incremented: ${s.gapsIncremented}`);
  lines.push(`- skipped: ${s.gapsSkipped}`);
  if (s.errorMessage) {
    lines.push("");
    lines.push(`> error: ${s.errorMessage}`);
  }
  if (s.actions.length > 0) {
    lines.push("");
    lines.push("## 详情（最多 30）");
    lines.push("| signature | kind | action | gap id |");
    lines.push("|---|---|---|---|");
    for (const a of s.actions.slice(0, 30)) {
      lines.push(
        `| \`${a.signature}\` | ${a.detectionKind} | ${a.action} | \`${a.gapId?.slice(0, 8) ?? "-"}\` |`
      );
    }
    if (s.actions.length > 30) {
      lines.push(`*（截断；共 ${s.actions.length} 条）*`);
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
  const watcher = new ToolGapWatcher();
  const summary = await watcher.runOnce({
    projectId: args.projectId,
    windowHours: args.windowHours,
    repeatedFailThreshold: args.repeatedFailThreshold,
    maxSignalsPerDetector: args.maxSignalsPerDetector,
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
  console.error("[tool-gap-watcher] fatal:", err);
  process.exit(2);
});
