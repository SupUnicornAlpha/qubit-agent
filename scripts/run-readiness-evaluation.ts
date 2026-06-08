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
import type { MetricGrade, OverallGrade } from "../src/runtime/agent-readiness/thresholds";
import { createJudgeClient } from "../src/runtime/agent-readiness/quality/judge-client-factory";
import type { JudgeClient } from "../src/runtime/agent-readiness/quality/content-judge";
import { writeCanvasReport } from "../src/runtime/agent-readiness/canvas-report";

const DEV_SERVER = process.env["QUBIT_DEV_SERVER"] ?? "http://127.0.0.1:17385";
const PROJECT_ID =
  process.env["QUBIT_READINESS_PROJECT_ID"] ?? "0489e81b-4c6a-4f80-a674-51a10bf23564";
const OUTPUT_DIR = resolve(process.env["QUBIT_READINESS_OUT"] ?? "./out/agent-readiness");
const WAIT_TIMEOUT_MS = Number(process.env["QUBIT_READINESS_WAIT_MS"] ?? 5 * 60_000);
const POLL_MS = Number(process.env["QUBIT_READINESS_POLL_MS"] ?? 2000);
/** 每个场景跑几轮；多轮可用于"减少噪声 + 看波动" */
const ROUNDS = Math.max(1, Number(process.env["QUBIT_READINESS_ROUNDS"] ?? 1));

// CLI flag 解析（极简：只看 process.argv）
const FLAGS = (() => {
  const a = process.argv.slice(2);
  const noJudge = a.includes("--no-judge");
  const judgeModel = a.find((s) => s.startsWith("--judge-model="))?.split("=")[1];
  const judgeMaxArtifacts = Number(
    a.find((s) => s.startsWith("--judge-max="))?.split("=")[1] ?? 5
  );
  return { noJudge, judgeModel, judgeMaxArtifacts };
})();

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
  weightedScore?: number;
  categoryScores?: Record<"A" | "B" | "C" | "D", number | null>;
  metricGrades: Record<string, MetricGrade | null>;
  metricValues: Record<string, number | null>;
  reports: { jsonPath: string; markdownPath: string };
  tracePath?: string;
  elapsedMs: number;
  timedOut: boolean;
  startError?: string;
}

/**
 * 复刻 UI 上「新建工作流 → 启动研究团队」两步链路：
 *
 *   1. POST /api/v1/workflows  (skipDispatch=true)
 *      仅占位 workflow_run；不让 orchestrator 走「单 Agent 走 react loop」
 *      的简化路径。
 *   2. POST /api/v1/analyst/run  { workflowRunId, agentGroupId, ticker | scope, hitlMode }
 *      派发 task_type=research_team_execute 给 orchestrator，runAnalystTeam
 *      内部会把 agent_group_id 写回 workflow_run，并按 group 解析分析师 slot。
 *
 * 若 group 没有 analyst slot（如 grp-strategy-pipeline / grp-live-trading 暂时
 * 无成员），analyst/run 会 4xx 报错；此时把错误透出到 startError 字段，让评
 * 测报告显式暴露"该场景在 UI 上无可用入口"，比静默 fallback 到单 Agent 裸跑
 * 更诚实。
 */
async function startWorkflowViaUiPath(recipe: ScenarioRecipe): Promise<string> {
  // ── Step 1: 创建 workflow 占位（skipDispatch=true）──
  const createPayload = {
    projectId: PROJECT_ID,
    goal: recipe.workflow.goal,
    mode: recipe.workflow.mode,
    source: "api" as const,
    skipDispatch: true,
    loopKind: recipe.workflow.loopKind,
    loopOptionsJson: recipe.workflow.loopOptionsJson,
  };
  const createRes = await fetch(`${DEV_SERVER}/api/v1/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createPayload),
  });
  if (!createRes.ok) {
    const text = await createRes.text().catch(() => "");
    throw new Error(`POST /workflows ${createRes.status}: ${text.slice(0, 300)}`);
  }
  const createJson = (await createRes.json()) as {
    data?: { id?: string };
    runId?: string;
  };
  const workflowRunId = createJson.data?.id ?? createJson.runId;
  if (!workflowRunId) {
    throw new Error(`unexpected create response: ${JSON.stringify(createJson).slice(0, 300)}`);
  }

  // ── Step 2: 启动研究团队（按 group 派发分析师 + 多 Agent）──
  const runPayload: Record<string, unknown> = {
    workflowRunId,
    agentGroupId: recipe.analystRun.agentGroupId,
    ...(recipe.analystRun.ticker ? { ticker: recipe.analystRun.ticker } : {}),
    ...(recipe.analystRun.scope ? { scope: recipe.analystRun.scope } : {}),
    ...(recipe.analystRun.context ? { context: recipe.analystRun.context } : {}),
    ...(recipe.analystRun.hitlMode ? { hitlMode: recipe.analystRun.hitlMode } : {}),
  };
  const runRes = await fetch(`${DEV_SERVER}/api/v1/analyst/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(runPayload),
  });
  if (!runRes.ok) {
    const text = await runRes.text().catch(() => "");
    throw new Error(
      `POST /analyst/run ${runRes.status}: ${text.slice(0, 300)} (workflowRunId=${workflowRunId}, group=${recipe.analystRun.agentGroupId})`
    );
  }

  return workflowRunId;
}

async function runOne(
  key: ScenarioRecipe["key"],
  judgeClient: JudgeClient | undefined
): Promise<ScenarioResult> {
  const recipe = SCENARIO_RECIPES[key];
  const t0 = Date.now();
  console.log(`\n▶ [${recipe.key}] ${recipe.displayName}`);
  console.log(`  goal: ${recipe.workflow.goal.slice(0, 80)}...`);

  let workflowRunId = "";
  try {
    workflowRunId = await startWorkflowViaUiPath(recipe);
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
    ...(judgeClient ? { judgeClient } : {}),
    judgeMaxArtifacts: FLAGS.judgeMaxArtifacts,
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
    weightedScore: r.grade.weightedScore,
    categoryScores: r.grade.categoryScores,
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
  lines.push("# Agent 五场景就绪度评测 — 总体报告（v2 AQM）");
  lines.push("");
  lines.push(`- 评测时间：${new Date().toISOString()}`);
  lines.push(`- 项目：\`${PROJECT_ID}\``);
  lines.push(`- 后端：${DEV_SERVER}`);
  lines.push(`- 报告目录：\`${OUTPUT_DIR}\``);
  lines.push("");

  // 总体等级取所有场景加权分的平均
  const validScores = results
    .map((r) => r.weightedScore)
    .filter((v): v is number => typeof v === "number");
  const avg = validScores.length
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length
    : 0;
  const overall: OverallGrade =
    avg >= 0.9 ? "A" : avg >= 0.75 ? "B" : avg >= 0.6 ? "C" : avg >= 0.4 ? "D" : "F";
  lines.push(`## 总体等级：**${overall}**（平均加权 ${avg.toFixed(2)}）`);
  lines.push("");

  lines.push("## 场景汇总（AQM 主指标 + 各类小分）");
  lines.push("");
  lines.push(
    "| 场景 | workflowRunId | 状态 | 总分 | A 内容 | B 工具 | C LLM | D 编排 | 用时 |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const cs = r.categoryScores;
    lines.push(
      `| ${r.scenario} | \`${r.workflowRunId.slice(0, 8) || "n/a"}\` | ${escapeStatus(r)} | ${r.overall} | ${formatCategoryScore(cs?.A)} | ${formatCategoryScore(cs?.B)} | ${formatCategoryScore(cs?.C)} | ${formatCategoryScore(cs?.D)} | ${(r.elapsedMs / 1000).toFixed(1)}s |`
    );
  }
  lines.push("");

  lines.push("## 主要指标明细（AQM 16 项）");
  lines.push("");
  const mainIds = [
    "A-1", "A-2", "A-3", "A-4",
    "B-1", "B-2", "B-3", "B-7",
    "C-1", "C-2", "C-3-total", "C-5",
    "D-1", "D-2", "D-3",
  ];
  lines.push(`| 场景 | ${mainIds.join(" | ")} |`);
  lines.push(`| --- | ${mainIds.map(() => "---").join(" | ")} |`);
  for (const r of results) {
    const cells = mainIds
      .map((id) => formatCell(r.metricValues[id], r.metricGrades[id]))
      .join(" | ");
    lines.push(`| ${r.scenario} | ${cells} |`);
  }
  lines.push("");

  lines.push("## LEGACY 兼容 6 指标（旧 round 对比）");
  lines.push("");
  lines.push("| 场景 | O-1 | T-1 | T-3 | T-6 | S-1 | M-1 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const cell = (id: string) => formatCell(r.metricValues[id], r.metricGrades[id]);
    lines.push(
      `| ${r.scenario} | ${cell("O-1")} | ${cell("T-1")} | ${cell("T-3")} | ${cell("T-6")} | ${cell("S-1")} | ${cell("M-1")} |`
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

function formatCategoryScore(s: number | null | undefined): string {
  if (s === null || s === undefined) return "n/a";
  return (s * 100).toFixed(0) + "%";
}

function formatCell(
  value: number | null | undefined,
  grade: MetricGrade | null | undefined
): string {
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

  console.log("Agent Readiness Evaluation (v2 AQM)");
  console.log(`  dev server : ${DEV_SERVER}`);
  console.log(`  project    : ${PROJECT_ID}`);
  console.log(`  output     : ${OUTPUT_DIR}`);
  console.log(`  wait/poll  : ${WAIT_TIMEOUT_MS}ms / ${POLL_MS}ms`);
  console.log(`  rounds     : ${ROUNDS}`);
  console.log(`  scenarios  : ${SCENARIO_ORDER.join(", ")}`);
  console.log(
    `  judge      : ${FLAGS.noJudge ? "disabled" : `enabled${FLAGS.judgeModel ? ` (${FLAGS.judgeModel})` : " (default model)"}, max=${FLAGS.judgeMaxArtifacts}`}`
  );

  // 健康检查
  try {
    const r = await fetch(`${DEV_SERVER}/health`);
    const j = await r.json();
    console.log(`  health     : ${JSON.stringify(j)}`);
  } catch (err) {
    console.error(`  ✖ dev server health 失败：${(err as Error).message}`);
    process.exit(2);
  }

  // 准备 judge client（如果启用）
  let judgeClient: JudgeClient | undefined;
  if (!FLAGS.noJudge) {
    try {
      judgeClient = await createJudgeClient(
        FLAGS.judgeModel ? { model: FLAGS.judgeModel } : {}
      );
      console.log("  judge      : client ready");
    } catch (err) {
      console.warn(
        `  ⚠ judge 初始化失败 (${(err as Error).message})；自动降级到 --no-judge`
      );
      judgeClient = undefined;
    }
  }

  const results: ScenarioResult[] = [];
  for (const key of SCENARIO_ORDER) {
    const r = await runOne(key, judgeClient);
    results.push(r);
  }

  const summaryPath = join(OUTPUT_DIR, `evaluation-summary-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await writeFile(summaryPath, renderSummaryMarkdown(results), "utf8");

  /**
   * Round 7 复盘（2026-06-08）：每轮自动生成 Cursor canvas，让用户能在 IDE 旁边看可视化报告。
   * 失败不阻塞 process.exit；canvas 仅是锦上添花。
   */
  const roundLabel = process.env["QUBIT_READINESS_ROUND_LABEL"] ?? `Round-${new Date().toISOString().slice(0, 10)}`;
  const canvasFileName = `agent-readiness-${roundLabel.replace(/\s+/g, "-").toLowerCase()}`;
  let canvasPath: string | null = null;
  try {
    canvasPath = await writeCanvasReport({
      roundLabel,
      startedAt: new Date().toISOString(),
      reportDir: OUTPUT_DIR,
      devServer: DEV_SERVER,
      projectId: PROJECT_ID,
      fileBaseName: canvasFileName,
      rows: results.map((r) => ({
        scenario: r.scenario,
        workflowRunId: r.workflowRunId,
        workflowStatus: r.workflowStatus,
        overall: r.overall,
        ...(r.weightedScore !== undefined ? { weightedScore: r.weightedScore } : {}),
        ...(r.categoryScores ? { categoryScores: r.categoryScores } : {}),
        metricGrades: r.metricGrades,
        metricValues: r.metricValues,
        elapsedMs: r.elapsedMs,
        timedOut: r.timedOut,
        ...(r.startError ? { startError: r.startError } : {}),
      })),
    });
  } catch (err) {
    console.warn("[canvas] failed to generate:", err);
  }

  console.log("");
  console.log("╭─ Evaluation Summary ─");
  for (const r of results) {
    console.log(`│ ${r.scenario.padEnd(13)} → ${r.overall} (${escapeStatus(r)})`);
  }
  console.log(`│`);
  console.log(`│ summary: ${summaryPath}`);
  if (canvasPath) console.log(`│ canvas:  ${canvasPath}`);
  console.log(`╰─────────────────────────`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
