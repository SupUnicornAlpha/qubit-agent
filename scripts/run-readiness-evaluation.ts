#!/usr/bin/env bun
/**
 * 一键评测：5 个场景串行跑就绪度评估，最后出总 summary。
 *
 * 设计要点：
 *   - Workflow 创建 / dispatch 通过 dev server 的 HTTP API（dev server 持有 LLM key 等环境）
 *   - 评估侧（runner）直接读同一份 SQLite（用 QUBIT_DATA_DIR 指向 dev server 的 DB）
 *   - 不让用户中间确认；每个场景跑完直接进下一个；最后写一份 evaluation-summary.md
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runReadinessFromWorkflowId } from "../src/runtime/agent-readiness/runner";
import { renderTraceMarkdown } from "../src/runtime/agent-readiness/trace-reporter";
import { SCENARIO_RECIPES, type ScenarioRecipe } from "../src/runtime/agent-readiness/scenarios";
import { aggregateGrade, type MetricGrade, type OverallGrade } from "../src/runtime/agent-readiness/thresholds";

const DEV_SERVER = process.env["QUBIT_DEV_SERVER"] ?? "http://127.0.0.1:17385";
const PROJECT_ID =
  process.env["QUBIT_READINESS_PROJECT_ID"] ?? "0489e81b-4c6a-4f80-a674-51a10bf23564";
const OUTPUT_DIR = resolve(process.env["QUBIT_READINESS_OUT"] ?? "./out/agent-readiness");
const WAIT_TIMEOUT_MS = Number(process.env["QUBIT_READINESS_WAIT_MS"] ?? 5 * 60_000);
const POLL_MS = Number(process.env["QUBIT_READINESS_POLL_MS"] ?? 2000);
/** 每个场景跑几轮；多轮可用于"减少噪声 + 看波动" */
const ROUNDS = Math.max(1, Number(process.env["QUBIT_READINESS_ROUNDS"] ?? 1));

const BASE_SCENARIO_ORDER: ScenarioRecipe["key"][] = [
  "research",
  "stock_pick",
  "factor",
  "strategy",
  "live_trading",
];
const SCENARIO_ORDER: ScenarioRecipe["key"][] = Array.from({ length: ROUNDS }).flatMap(
  () => BASE_SCENARIO_ORDER
);

interface ScenarioResult {
  scenario: string;
  workflowRunId: string;
  workflowStatus: string;
  overall: OverallGrade;
  metricGrades: Record<string, MetricGrade>;
  metricValues: Record<string, number | null>;
  reports: { jsonPath: string; markdownPath: string };
  tracePath?: string;
  elapsedMs: number;
  timedOut: boolean;
  startError?: string;
}

async function startWorkflowViaHttp(recipe: ScenarioRecipe): Promise<string> {
  const payload = {
    projectId: PROJECT_ID,
    goal: recipe.workflow.goal,
    mode: recipe.workflow.mode,
    source: "api" as const,
    loopKind: recipe.workflow.loopKind,
    loopOptionsJson: recipe.workflow.loopOptionsJson,
  };
  const res = await fetch(`${DEV_SERVER}/api/v1/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`dev server ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: { id?: string }; runId?: string };
  const id = json.data?.id ?? json.runId;
  if (!id) {
    throw new Error(`unexpected response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return id;
}

async function runOne(key: ScenarioRecipe["key"]): Promise<ScenarioResult> {
  const recipe = SCENARIO_RECIPES[key];
  const t0 = Date.now();
  console.log(`\n▶ [${recipe.key}] ${recipe.displayName}`);
  console.log(`  goal: ${recipe.workflow.goal.slice(0, 80)}...`);

  let workflowRunId = "";
  try {
    workflowRunId = await startWorkflowViaHttp(recipe);
    console.log(`  workflowRunId: ${workflowRunId}`);
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`  ✖ start failed: ${msg}`);
    return {
      scenario: recipe.key,
      workflowRunId: "",
      workflowStatus: "start_failed",
      overall: "F",
      metricGrades: {},
      metricValues: {},
      reports: { jsonPath: "", markdownPath: "" },
      elapsedMs: Date.now() - t0,
      timedOut: false,
      startError: msg,
    };
  }

  const r = await runReadinessFromWorkflowId({
    scenario: recipe.key,
    workflowRunId,
    outputDir: OUTPUT_DIR,
    waitTimeoutMs: WAIT_TIMEOUT_MS,
    pollIntervalMs: POLL_MS,
  });

  let tracePath: string | undefined;
  try {
    const md = await renderTraceMarkdown({ workflowRunId });
    tracePath = join(OUTPUT_DIR, `trace-${recipe.key}-${workflowRunId}.md`);
    await writeFile(tracePath, md, "utf8");
  } catch (err) {
    console.log(`  ⚠ trace render failed: ${(err as Error).message}`);
  }

  console.log(
    `  status=${r.workflowStatus}${r.timedOut ? " (timeout)" : ""} grade=${r.grade.overall} elapsed=${r.elapsedMs}ms`
  );
  return {
    scenario: recipe.key,
    workflowRunId: r.workflowRunId,
    workflowStatus: r.workflowStatus,
    overall: r.grade.overall,
    metricGrades: r.grade.metricGrades,
    metricValues: r.grade.metricValues,
    reports: r.reports,
    ...(tracePath ? { tracePath } : {}),
    elapsedMs: r.elapsedMs,
    timedOut: r.timedOut,
  };
}

function renderSummaryMarkdown(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push("# Agent 五场景就绪度评测 — 总体报告");
  lines.push("");
  lines.push(`- 评测时间：${new Date().toISOString()}`);
  lines.push(`- 项目：\`${PROJECT_ID}\``);
  lines.push(`- 后端：${DEV_SERVER}`);
  lines.push(`- 报告目录：\`${OUTPUT_DIR}\``);
  lines.push("");

  // 总体等级 = 5 个 overall 反向映射
  const allGrades: MetricGrade[] = [];
  for (const r of results) {
    for (const g of Object.values(r.metricGrades)) allGrades.push(g);
  }
  const aggregate = aggregateGrade(allGrades);
  lines.push(`## 总体等级：**${aggregate}**`);
  lines.push("");

  lines.push("## 场景汇总");
  lines.push("");
  lines.push("| 场景 | workflowRunId | 状态 | 总分 | O-1 | T-1 | T-3 | T-6 | S-1 | M-1 | 用时 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const v = r.metricValues;
    const cell = (id: string) => formatCell(v[id], r.metricGrades[id]);
    lines.push(
      `| ${r.scenario} | \`${r.workflowRunId.slice(0, 8) || "n/a"}\` | ${escapeStatus(r)} | ${r.overall} | ${cell("O-1")} | ${cell("T-1")} | ${cell("T-3")} | ${cell("T-6")} | ${cell("S-1")} | ${cell("M-1")} | ${(r.elapsedMs / 1000).toFixed(1)}s |`
    );
  }
  lines.push("");

  lines.push("## 各场景报告");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.scenario}`);
    lines.push("");
    if (r.startError) {
      lines.push(`- ❌ 启动失败：${r.startError}`);
      lines.push("");
      continue;
    }
    lines.push(`- workflow: \`${r.workflowRunId}\``);
    lines.push(`- status: \`${r.workflowStatus}\`${r.timedOut ? " (timeout)" : ""}`);
    lines.push(`- json: \`${r.reports.jsonPath}\``);
    lines.push(`- md:   \`${r.reports.markdownPath}\``);
    if (r.tracePath) lines.push(`- trace: \`${r.tracePath}\``);
    lines.push("");
  }
  return lines.join("\n");
}

function formatCell(value: number | null | undefined, grade: MetricGrade | undefined): string {
  const icon = grade === "green" ? "✅" : grade === "yellow" ? "⚠️" : grade === "red" ? "❌" : "·";
  if (value === null || value === undefined) return `${icon} n/a`;
  if (Number.isInteger(value)) return `${icon} ${value}`;
  if (value > -1.0001 && value < 1.0001) return `${icon} ${(value * 100).toFixed(1)}%`;
  return `${icon} ${value.toFixed(2)}`;
}

function escapeStatus(r: ScenarioResult): string {
  if (r.startError) return "start_failed";
  return r.timedOut ? `${r.workflowStatus} (timeout)` : r.workflowStatus;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log("Agent Readiness Evaluation");
  console.log(`  dev server : ${DEV_SERVER}`);
  console.log(`  project    : ${PROJECT_ID}`);
  console.log(`  output     : ${OUTPUT_DIR}`);
  console.log(`  wait/poll  : ${WAIT_TIMEOUT_MS}ms / ${POLL_MS}ms`);
  console.log(`  rounds     : ${ROUNDS}`);
  console.log(`  scenarios  : ${SCENARIO_ORDER.join(", ")}`);

  // 健康检查
  try {
    const r = await fetch(`${DEV_SERVER}/health`);
    const j = await r.json();
    console.log(`  health     : ${JSON.stringify(j)}`);
  } catch (err) {
    console.error(`  ✖ dev server health 失败：${(err as Error).message}`);
    process.exit(2);
  }

  const results: ScenarioResult[] = [];
  for (const key of SCENARIO_ORDER) {
    const r = await runOne(key);
    results.push(r);
  }

  const summaryPath = join(OUTPUT_DIR, `evaluation-summary-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await writeFile(summaryPath, renderSummaryMarkdown(results), "utf8");

  console.log("");
  console.log("╭─ Evaluation Summary ─");
  for (const r of results) {
    console.log(`│ ${r.scenario.padEnd(13)} → ${r.overall} (${escapeStatus(r)})`);
  }
  console.log(`│`);
  console.log(`│ summary: ${summaryPath}`);
  console.log(`╰─────────────────────────`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
