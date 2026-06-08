#!/usr/bin/env bun
/**
 * Agent 就绪度 Runner CLI。
 *
 * 用法：
 *   # 模式 A：跑某个场景的全新工作流（需要后端 / 主链路 LLM key 已配好）
 *   bun run scripts/agent-readiness-runner.ts --scenario research \
 *      --project=<projectId> --output-dir=./out
 *
 *   # 模式 B：给一条已有 workflowRunId 出报告（通常配合 dev 跑出来的最新 run）
 *   bun run scripts/agent-readiness-runner.ts --scenario research \
 *      --workflow=<workflowRunId> --output-dir=./out
 *
 *   # 模式 C：把 trace（agent_step + tool_call_log + llm_call_log）转 Markdown
 *   bun run scripts/agent-readiness-runner.ts --trace=<workflowRunId> \
 *      --output-dir=./out
 *
 *   # 模式 D：两份快照 JSON 的差异报告
 *   bun run scripts/agent-readiness-runner.ts --diff=base.json,target.json \
 *      --output-dir=./out
 *
 * 当未提供 --workflow 也没提供 --project 时，会用 config.defaultProjectId 兜底。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runReadiness, runReadinessFromWorkflowId } from "../src/runtime/agent-readiness/runner";
import { renderTraceMarkdown } from "../src/runtime/agent-readiness/trace-reporter";
import { renderDiffMarkdown } from "../src/runtime/agent-readiness/diff-reporter";
import type { ScenarioRecipe } from "../src/runtime/agent-readiness/scenarios";

interface CliFlags {
  scenario?: ScenarioRecipe["key"];
  project?: string;
  workflow?: string;
  trace?: string;
  diff?: string;
  outputDir: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  help?: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { outputDir: "./out/agent-readiness" };
  for (const a of argv.slice(2)) {
    if (a === "--help" || a === "-h") flags.help = true;
    else if (a.startsWith("--scenario=")) flags.scenario = a.slice(11) as ScenarioRecipe["key"];
    else if (a.startsWith("--project=")) flags.project = a.slice(10);
    else if (a.startsWith("--workflow=")) flags.workflow = a.slice(11);
    else if (a.startsWith("--trace=")) flags.trace = a.slice(8);
    else if (a.startsWith("--diff=")) flags.diff = a.slice(7);
    else if (a.startsWith("--output-dir=")) flags.outputDir = a.slice(13);
    else if (a.startsWith("--wait-timeout-ms=")) flags.waitTimeoutMs = Number(a.slice(18));
    else if (a.startsWith("--poll-interval-ms=")) flags.pollIntervalMs = Number(a.slice(19));
  }
  return flags;
}

function printHelp(): void {
  console.log(`Agent Readiness Runner

模式：
  --scenario=<k> --project=<id>          A 模式：启动新 workflow 跑场景
  --scenario=<k> --workflow=<id>          B 模式：给已存在 workflow 出报告
  --trace=<workflowRunId>                 C 模式：导出 trace markdown
  --diff=base.json,target.json            D 模式：两份快照差异

通用：
  --output-dir=<dir>     报告输出目录（默认 ./out/agent-readiness）
  --wait-timeout-ms=N    等终态超时，A/B 模式生效（默认 300000=5min）
  --poll-interval-ms=N   轮询间隔（默认 1500）

场景 key：research / stock_pick / factor / strategy / live_trading
`);
}

async function main() {
  const flags = parseFlags(process.argv);
  if (flags.help) {
    printHelp();
    process.exit(0);
  }
  await mkdir(flags.outputDir, { recursive: true });
  const outputDir = resolve(flags.outputDir);

  // ── 模式 D：diff ──────────────────────────────────────────────────
  if (flags.diff) {
    const [a, b] = flags.diff.split(",");
    if (!a || !b) {
      console.error("[ERR] --diff 需要 base.json,target.json 两份路径");
      process.exit(2);
    }
    const baseRaw = JSON.parse(await readFile(a, "utf8"));
    const targetRaw = JSON.parse(await readFile(b, "utf8"));
    const md = renderDiffMarkdown({ base: baseRaw, target: targetRaw });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = join(outputDir, `diff-${stamp}.md`);
    await writeFile(out, md, "utf8");
    console.log(`[OK] diff written: ${out}`);
    return;
  }

  // ── 模式 C：trace ────────────────────────────────────────────────
  if (flags.trace) {
    const md = await renderTraceMarkdown({ workflowRunId: flags.trace });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = join(outputDir, `trace-${flags.trace}-${stamp}.md`);
    await writeFile(out, md, "utf8");
    console.log(`[OK] trace written: ${out}`);
    return;
  }

  // ── 模式 A / B：必须有 scenario ──────────────────────────────────
  if (!flags.scenario) {
    console.error("[ERR] --scenario=<k> 必填，或使用 --trace / --diff 模式");
    printHelp();
    process.exit(2);
  }

  // ── 模式 B：已有 workflowRunId ─────────────────────────────────
  if (flags.workflow) {
    const r = await runReadinessFromWorkflowId({
      scenario: flags.scenario,
      workflowRunId: flags.workflow,
      outputDir,
      ...(flags.waitTimeoutMs !== undefined ? { waitTimeoutMs: flags.waitTimeoutMs } : {}),
      ...(flags.pollIntervalMs !== undefined ? { pollIntervalMs: flags.pollIntervalMs } : {}),
    });
    summarize(r);
    return;
  }

  // ── 模式 A：启动新 workflow ────────────────────────────────────
  if (!flags.project) {
    console.error("[ERR] A 模式需 --project=<id>");
    process.exit(2);
  }
  const r = await runReadiness({
    scenario: flags.scenario,
    projectId: flags.project,
    outputDir,
    ...(flags.waitTimeoutMs !== undefined ? { waitTimeoutMs: flags.waitTimeoutMs } : {}),
    ...(flags.pollIntervalMs !== undefined ? { pollIntervalMs: flags.pollIntervalMs } : {}),
  });
  summarize(r);
}

function summarize(r: {
  scenario: string;
  workflowRunId: string;
  workflowStatus: string;
  grade: { overall: string };
  reports: { jsonPath: string; markdownPath: string };
  elapsedMs: number;
  timedOut: boolean;
}) {
  console.log("");
  console.log(`╭─ Agent Readiness ─ ${r.scenario}`);
  console.log(`│ workflow:  ${r.workflowRunId}`);
  console.log(`│ status:    ${r.workflowStatus}${r.timedOut ? " (timed out)" : ""}`);
  console.log(`│ overall:   ${r.grade.overall}`);
  console.log(`│ elapsedMs: ${r.elapsedMs}`);
  console.log(`│ json:      ${r.reports.jsonPath}`);
  console.log(`│ markdown:  ${r.reports.markdownPath}`);
  console.log(`╰────────────────────────────────────────`);
  if (existsSync(r.reports.markdownPath)) {
    // 简单重读一下 md 顶部摘要
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
