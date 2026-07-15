#!/usr/bin/env bun
/**
 * 一键评测：5 个场景串行跑就绪度评估，最后出总 summary。
 *
 * 设计要点：
 *   - Workflow 创建 / dispatch 通过 dev server 的 HTTP API（dev server 持有 LLM key 等环境）
 *   - 评估侧（runner）直接读同一份 SQLite（用 QUBIT_DATA_DIR 指向 dev server 的 DB）
 *   - 不让用户中间确认；每个场景跑完直接进下一个；最后写一份 evaluation-summary.md
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { runReadinessFromWorkflowId } from "../src/runtime/agent-readiness/runner";
import { renderTraceMarkdown } from "../src/runtime/agent-readiness/trace-reporter";
import { SCENARIO_RECIPES, type ScenarioRecipe } from "../src/runtime/agent-readiness/scenarios";
import type { MetricGrade, OverallGrade } from "../src/runtime/agent-readiness/thresholds";
import { createJudgeClient } from "../src/runtime/agent-readiness/quality/judge-client-factory";
import type { JudgeClient } from "../src/runtime/agent-readiness/quality/content-judge";
import { writeCanvasReport } from "../src/runtime/agent-readiness/canvas-report";
import {
  aggregateHealth,
  renderHealthMarkdown,
} from "../src/runtime/agent-readiness/health-aggregator";
import { writeHealthCanvas } from "../src/runtime/agent-readiness/health-canvas";

const DEV_SERVER = process.env["QUBIT_DEV_SERVER"] ?? "http://127.0.0.1:17385";
const PROJECT_ID =
  process.env["QUBIT_READINESS_PROJECT_ID"] ?? "0489e81b-4c6a-4f80-a674-51a10bf23564";
const OUTPUT_DIR = resolve(process.env["QUBIT_READINESS_OUT"] ?? "./out/agent-readiness");
const WAIT_TIMEOUT_MS = Number(process.env["QUBIT_READINESS_WAIT_MS"] ?? 5 * 60_000);
const POLL_MS = Number(process.env["QUBIT_READINESS_POLL_MS"] ?? 2000);
/** 每个场景跑几轮；多轮可用于"减少噪声 + 看波动" */
const ROUNDS = Math.max(1, Number(process.env["QUBIT_READINESS_ROUNDS"] ?? 1));
const CONCURRENCY = Math.max(1, Number(process.env["QUBIT_READINESS_CONCURRENCY"] ?? 1));

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

/**
 * 9 个用例的执行顺序：按依赖关系排（factor → strategy → live_trading），并把多
 * 维度变体放在 base 之后（避免 base 还没有 factor / strategy 产出就跑 long_short）。
 *
 * 期权场景 ST-OPT 待 instrument schema 扩展支持期权后再补，详见
 * docs/superpowers/specs/2026-06-09-options-data-model.md（待生成）。
 */
const BASE_SCENARIO_ORDER: ScenarioRecipe["key"][] = [
  "research",
  "research_multi",
  "research_theme",
  "stock_pick",
  "stock_pick_short",
  "factor",
  "strategy",
  "strategy_long_short",
  "live_trading",
  "live_trading_short",
];

/**
 * Smoke / debug 子集（2026-06-09）：通过 `QUBIT_READINESS_SCENARIOS=factor,strategy,...`
 * env 限定本次执行的场景，未指定则跑全量 BASE_SCENARIO_ORDER。
 *
 * 严格匹配 ScenarioRecipe.key；未识别的 key 直接抛 fail-fast，避免一长串 typo
 * 跑下来才发现没跑想跑的场景。
 */
function resolveBaseOrder(): ScenarioRecipe["key"][] {
  const raw = process.env["QUBIT_READINESS_SCENARIOS"]?.trim();
  if (!raw) return BASE_SCENARIO_ORDER;
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as ScenarioRecipe["key"][];
  const known = new Set(BASE_SCENARIO_ORDER);
  const bad = picked.filter((k) => !known.has(k));
  if (bad.length > 0) {
    throw new Error(
      `QUBIT_READINESS_SCENARIOS 含未知 key: [${bad.join(", ")}]；` +
        `合法 key: ${BASE_SCENARIO_ORDER.join(", ")}`
    );
  }
  if (picked.length === 0) return BASE_SCENARIO_ORDER;
  return picked;
}

const ACTIVE_BASE_ORDER = resolveBaseOrder();
const SCENARIO_ORDER: ScenarioRecipe["key"][] = Array.from({ length: ROUNDS }).flatMap(
  () => ACTIVE_BASE_ORDER
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
 * 通过统一 Scenario Harness 启动：
 *
 *   POST /api/v1/research-scenarios/:key/launch
 *
 * 该入口内部负责 create workflow、tag research_scenario_id、启动研究团队。
 * 评测脚本不再手写「create workflow + analyst/run」两步，避免 UI / harness 漂移。
 */
async function startWorkflowViaUiPath(recipe: ScenarioRecipe): Promise<string> {
  const inputParams: Record<string, unknown> = { ...recipe.scenarioInputParams };
  if (recipe.key === "live_trading" || recipe.key === "live_trading_short") {
    Object.assign(inputParams, await ensureExecutionBenchmarkPrerequisites());
  }
  const launchPayload = {
    projectId: PROJECT_ID,
    goal: recipe.workflow.goal,
    inputParams,
    agentGroupId: recipe.analystRun.agentGroupId,
    loopOverrides: recipe.workflow.loopOptionsJson,
  };
  const launchRes = await fetch(`${DEV_SERVER}/api/v1/research-scenarios/${recipe.key}/launch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(launchPayload),
  });
  if (!launchRes.ok) {
    const text = await launchRes.text().catch(() => "");
    throw new Error(
      `POST /research-scenarios/${recipe.key}/launch ${launchRes.status}: ${text.slice(0, 300)} (group=${recipe.analystRun.agentGroupId})`
    );
  }
  const launchJson = (await launchRes.json()) as {
    data?: { workflowRunId?: string };
  };
  const workflowRunId = launchJson.data?.workflowRunId;
  if (!workflowRunId) {
    throw new Error(`unexpected launch response: ${JSON.stringify(launchJson).slice(0, 300)}`);
  }

  return workflowRunId;
}

async function ensureExecutionBenchmarkPrerequisites(): Promise<{
  strategyId: string;
  brokerAccountId: string;
}> {
  const sqlite = new Database(defaultDbPath(), { readonly: true });
  let strategyId = "";
  let brokerAccountId = "";
  try {
    const strategy = sqlite
      .prepare(`SELECT id FROM strategy ORDER BY created_at DESC LIMIT 1`)
      .get() as { id?: string } | undefined;
    strategyId = strategy?.id ?? "";
    const account = sqlite
      .prepare(`SELECT id FROM broker_account WHERE enabled = 1 ORDER BY is_default DESC, updated_at DESC LIMIT 1`)
      .get() as { id?: string } | undefined;
    brokerAccountId = account?.id ?? "";
  } finally {
    sqlite.close();
  }

  if (!strategyId) {
    throw new Error("execution benchmark requires at least one strategy; strategy scenarios produced none");
  }
  if (!brokerAccountId) {
    const response = await fetch(`${DEV_SERVER}/api/v1/reia/broker/accounts/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "futu",
        accountRef: "benchmark-v2-mock",
        mode: "mock",
        isDefault: true,
        enabled: true,
      }),
    });
    const payload = (await response.json()) as { data?: { id?: string }; error?: string };
    if (!response.ok || !payload.data?.id) {
      throw new Error(`unable to provision benchmark mock broker: ${payload.error ?? response.status}`);
    }
    brokerAccountId = payload.data.id;
  }
  return { strategyId, brokerAccountId };
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
    "D-1", "D-2", "D-3", "D-4", "D-5",
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

  /**
   * Round 10 复盘（2026-06-09）：评测脚本 default dataDir 是 ~/.quant-agent，
   * 但 dev server 通常用 ~/Library/Application Support/app.qubit.agent
   * （macOS native packaging 默认目录）。这俩 DB 完全独立 → 评测脚本通过
   * HTTP 让 dev server 创建 workflow_run，但 collectSnapshot 读自己本地
   * DB → 100% workflow_run not found，FATAL 退出。
   *
   * 修复：启动时主动 sanity check：如果 QUBIT_DATA_DIR 未设但 macOS
   * 标准目录下的 DB 比本地 ~/.quant-agent/db/core.sqlite 大很多或后者
   * 不存在 → 提示用户设置。
   */
  if (!process.env["QUBIT_DATA_DIR"]) {
    const localDb = join(homedir(), ".quant-agent", "db", "core.sqlite");
    const macDb = join(
      homedir(),
      "Library",
      "Application Support",
      "app.qubit.agent",
      "db",
      "core.sqlite"
    );
    if (!existsSync(localDb) && existsSync(macDb)) {
      console.error(
        `\n[FATAL] QUBIT_DATA_DIR 未设置，评测脚本会走 ${localDb}（不存在），\n` +
          `        但 dev server 看起来用的是 ${macDb}。\n` +
          `        请在跑评测前 export:\n` +
          `          export QUBIT_DATA_DIR="${join(homedir(), "Library", "Application Support", "app.qubit.agent")}"\n` +
          `        然后重新跑。\n`
      );
      process.exit(3);
    }
  }

  console.log("Agent Readiness Evaluation (v2 AQM)");
  console.log(`  dev server : ${DEV_SERVER}`);
  console.log(`  data dir   : ${process.env["QUBIT_DATA_DIR"] ?? join(homedir(), ".quant-agent")}`);
  console.log(`  project    : ${PROJECT_ID}`);
  console.log(`  output     : ${OUTPUT_DIR}`);
  console.log(`  wait/poll  : ${WAIT_TIMEOUT_MS}ms / ${POLL_MS}ms`);
  console.log(`  rounds     : ${ROUNDS}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
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

  const results: ScenarioResult[] = new Array(SCENARIO_ORDER.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= SCENARIO_ORDER.length) return;
      const key = SCENARIO_ORDER[index]!;
      results[index] = await runOne(key, judgeClient);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, SCENARIO_ORDER.length) }, () => worker())
  );

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

  /**
   * Round 9 复盘（2026-06-09）：评测完毕后自动跑跨工作流"健康度报告"
   * （tool / mcp / llm / skill / error 五维），写 markdown + canvas。
   * 失败不阻塞 process.exit。
   */
  let healthMdPath: string | null = null;
  let healthCanvasPath: string | null = null;
  try {
    const workflowIds = results
      .map((r) => r.workflowRunId)
      .filter((id) => typeof id === "string" && id.length > 0);
    if (workflowIds.length > 0) {
      const dbPath = defaultDbPath();
      if (existsSync(dbPath)) {
        const sqlite = new Database(dbPath, { readonly: true });
        let report;
        try {
          report = aggregateHealth(sqlite, workflowIds);
        } finally {
          sqlite.close();
        }
        const healthMd = renderHealthMarkdown(report, { roundLabel });
        healthMdPath = join(OUTPUT_DIR, "health-report.md");
        await writeFile(healthMdPath, healthMd, "utf8");
        const healthJsonPath = join(OUTPUT_DIR, "health-report.json");
        await writeFile(healthJsonPath, JSON.stringify(report, null, 2), "utf8");
        const healthCanvasName = `agent-health-${roundLabel.replace(/\s+/g, "-").toLowerCase()}`;
        healthCanvasPath = await writeHealthCanvas({
          roundLabel,
          report,
          reportDir: OUTPUT_DIR,
          fileBaseName: healthCanvasName,
        });
      } else {
        console.warn(`[health] DB 不存在 ${dbPath}，跳过健康度报告生成`);
      }
    }
  } catch (err) {
    console.warn("[health] 报告生成失败：", err);
  }

  console.log("");
  console.log("╭─ Evaluation Summary ─");
  for (const r of results) {
    console.log(`│ ${r.scenario.padEnd(20)} → ${r.overall} (${escapeStatus(r)})`);
  }
  console.log(`│`);
  console.log(`│ summary:        ${summaryPath}`);
  if (canvasPath) console.log(`│ scenarios canv: ${canvasPath}`);
  if (healthMdPath) console.log(`│ health md:      ${healthMdPath}`);
  if (healthCanvasPath) console.log(`│ health canvas:  ${healthCanvasPath}`);
  console.log(`╰─────────────────────────`);

  process.exit(0);
}

function defaultDbPath(): string {
  const dataDir =
    process.env["QUBIT_DATA_DIR"] ??
    join(homedir(), "Library", "Application Support", "app.qubit.agent");
  return join(dataDir, "db", "core.sqlite");
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
