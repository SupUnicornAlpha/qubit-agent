#!/usr/bin/env bun
/**
 * Round 6 补抓：对 5 个已 completed 的 workflow 重新拉一次终态快照，
 * 生成 final 报告 + summary。
 *
 * 用途：Round 6 主脚本 wait timeout 设的是 10min，但多 Agent 团队跑 11-13min
 * 才 completed → 抓的快照很多还是 running 态的，grade=D 是误判。
 * 这里用相同 collectSnapshot + judgeClient + writeReports 链路重新生成报告。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectSnapshot } from "../src/runtime/agent-readiness/snapshot-collector";
import { gradeSnapshot } from "../src/runtime/agent-readiness/grader";
import {
  renderJsonReport,
  renderMarkdownReport,
} from "../src/runtime/agent-readiness/reporters";
import { renderTraceMarkdown } from "../src/runtime/agent-readiness/trace-reporter";
import { SCENARIO_RECIPES, type ScenarioRecipe } from "../src/runtime/agent-readiness/scenarios";
import type { MetricGrade, OverallGrade } from "../src/runtime/agent-readiness/thresholds";
import { createJudgeClient } from "../src/runtime/agent-readiness/quality/judge-client-factory";
import type { JudgeClient } from "../src/runtime/agent-readiness/quality/content-judge";
import { getDb } from "../src/db/sqlite/client";
import { workflowRun } from "../src/db/sqlite/schema";
import { eq } from "drizzle-orm";

const OUTPUT_DIR = resolve(process.env["QUBIT_READINESS_OUT"] ?? "./out/agent-readiness");
const JUDGE_MAX = Number(
  process.argv.find((s) => s.startsWith("--judge-max="))?.split("=")[1] ?? 3
);
const NO_JUDGE = process.argv.includes("--no-judge");

// Round 6 跑出来的 5 个 workflow id（按 SCENARIO_ORDER）
const ROUND6_WORKFLOWS: Array<{ key: ScenarioRecipe["key"]; workflowRunId: string }> = [
  { key: "research", workflowRunId: "25e84c0f-59d4-42c4-8391-a47896f01ab1" },
  { key: "stock_pick", workflowRunId: "1337daf2-8c33-4d11-addc-44f4c4b5cedf" },
  { key: "factor", workflowRunId: "5511cd87-9e0f-470f-84eb-511edd0cb73c" },
  { key: "strategy", workflowRunId: "d205a695-0164-4f2a-97d5-3cc3111c683d" },
  { key: "live_trading", workflowRunId: "f6196ef0-db09-44b2-8256-ad476617a1fa" },
];

interface Result {
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
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log("Agent Readiness — Round 6 final-snapshot re-collection");
  console.log(`  output     : ${OUTPUT_DIR}`);
  console.log(`  judge      : ${NO_JUDGE ? "disabled" : `enabled, max=${JUDGE_MAX}`}`);

  let judgeClient: JudgeClient | undefined;
  if (!NO_JUDGE) {
    try {
      judgeClient = await createJudgeClient({});
      console.log("  judge      : client ready");
    } catch (err) {
      console.warn(`  ⚠ judge init failed (${(err as Error).message})`);
    }
  }

  const db = await getDb();
  const results: Result[] = [];
  for (const { key, workflowRunId } of ROUND6_WORKFLOWS) {
    console.log(`\n▶ [${key}] ${workflowRunId}`);
    const wfRow = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowRunId))
      .limit(1);
    if (!wfRow[0]) {
      console.log(`  ✖ workflow_run not found`);
      continue;
    }
    const status = wfRow[0].status;
    console.log(`  status: ${status}`);

    const snapshot = await collectSnapshot({
      workflowRunId,
      scenario: key,
      ...(judgeClient ? { judgeClient } : {}),
      judgeMaxArtifacts: JUDGE_MAX,
    });
    const grade = gradeSnapshot(snapshot);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = join(OUTPUT_DIR, `final-${key}-${workflowRunId}-${ts}.json`);
    const markdownPath = join(OUTPUT_DIR, `final-${key}-${workflowRunId}-${ts}.md`);
    await writeFile(jsonPath, renderJsonReport(snapshot), "utf8");
    await writeFile(markdownPath, renderMarkdownReport(snapshot), "utf8");
    const reports = { jsonPath, markdownPath };

    let tracePath: string | undefined;
    try {
      const md = await renderTraceMarkdown({ workflowRunId });
      tracePath = join(OUTPUT_DIR, `final-trace-${key}-${workflowRunId}.md`);
      await writeFile(tracePath, md, "utf8");
    } catch (err) {
      console.log(`  ⚠ trace failed: ${(err as Error).message}`);
    }

    console.log(
      `  grade=${grade.overall} weighted=${grade.weightedScore?.toFixed(3) ?? "n/a"}`
    );
    const r: Result = {
      scenario: key,
      workflowRunId,
      workflowStatus: status,
      overall: grade.overall,
      metricGrades: grade.metricGrades,
      metricValues: grade.metricValues,
      reports,
    };
    if (grade.weightedScore !== undefined) r.weightedScore = grade.weightedScore;
    if (grade.categoryScores) r.categoryScores = grade.categoryScores;
    if (tracePath) r.tracePath = tracePath;
    results.push(r);
  }

  const summaryPath = join(
    OUTPUT_DIR,
    `final-summary-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
  );
  await writeFile(summaryPath, renderSummary(results), "utf8");

  console.log("\n╭─ Final Summary ─");
  for (const r of results) {
    console.log(
      `│ ${r.scenario.padEnd(13)} → ${r.overall} (${r.workflowStatus}) ` +
        `[A=${pctOf(r.categoryScores?.A)} B=${pctOf(r.categoryScores?.B)} ` +
        `C=${pctOf(r.categoryScores?.C)} D=${pctOf(r.categoryScores?.D)}]`
    );
  }
  console.log(`│\n│ summary: ${summaryPath}\n╰────`);
  process.exit(0);
}

function pctOf(v: number | null | undefined): string {
  if (typeof v !== "number") return "  -";
  return `${Math.round(v * 100)}%`.padStart(4);
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

function renderSummary(results: Result[]): string {
  const lines: string[] = [];
  lines.push("# Agent 五场景就绪度评测 — Round 6 终态报告（UI 路径 + 多 Agent 团队）");
  lines.push("");
  lines.push(`- 评测时间：${new Date().toISOString()}`);
  lines.push(`- 报告目录：\`${OUTPUT_DIR}\``);
  lines.push(
    "- 入口：`POST /api/v1/workflows` (skipDispatch=true) → `POST /api/v1/analyst/run` (带 agentGroupId / ticker / scope)"
  );
  lines.push("- 与 Round 5 区别：Round 5 走单 Agent 裸跑；Round 6 走 UI 同款多 Agent 团队");
  lines.push("");

  const validScores = results.map((r) => r.weightedScore).filter((v): v is number => typeof v === "number");
  const avg = validScores.length
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length
    : 0;
  const overall: OverallGrade =
    avg >= 0.9 ? "A" : avg >= 0.75 ? "B" : avg >= 0.6 ? "C" : avg >= 0.4 ? "D" : "F";
  lines.push(`## 总体等级：**${overall}**（平均加权 ${avg.toFixed(3)}）`);
  lines.push("");

  lines.push("## 场景汇总");
  lines.push("");
  lines.push("| 场景 | workflowRunId | group | 状态 | 总分 | A 内容 | B 工具 | C LLM | D 编排 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const groups: Record<string, string> = {
    research: "grp-full-analyst-team",
    stock_pick: "grp-full-analyst-team",
    factor: "grp-factor-research",
    strategy: "grp-strategy-pipeline",
    live_trading: "grp-live-trading",
  };
  for (const r of results) {
    const cs = r.categoryScores;
    lines.push(
      `| ${r.scenario} | \`${r.workflowRunId.slice(0, 8)}\` | ${groups[r.scenario] ?? "?"} | ${r.workflowStatus} | ${r.overall} | ${pctOf(cs?.A)} | ${pctOf(cs?.B)} | ${pctOf(cs?.C)} | ${pctOf(cs?.D)} |`
    );
  }
  lines.push("");

  lines.push("## 主要指标明细（AQM 15 项）");
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

  lines.push("## LEGACY 兼容 6 指标");
  lines.push("");
  lines.push("| 场景 | O-1 | T-1 | T-3 | T-6 | S-1 | M-1 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const cells = ["O-1", "T-1", "T-3", "T-6", "S-1", "M-1"]
      .map((id) => formatCell(r.metricValues[id], r.metricGrades[id]))
      .join(" | ");
    lines.push(`| ${r.scenario} | ${cells} |`);
  }
  lines.push("");

  lines.push("## 报告文件");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.scenario}`);
    lines.push("");
    lines.push(`- workflow: \`${r.workflowRunId}\``);
    lines.push(`- status: \`${r.workflowStatus}\``);
    lines.push(`- json: \`${r.reports.jsonPath}\``);
    lines.push(`- md:   \`${r.reports.markdownPath}\``);
    if (r.tracePath) lines.push(`- trace: \`${r.tracePath}\``);
    lines.push("");
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
