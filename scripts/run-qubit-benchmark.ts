#!/usr/bin/env bun
/**
 * qubit-bench 升级门禁 runner。
 *
 * 通过生产 HTTP 场景入口启动 qubit-bench-v0.2 真实 workflow，随后以同一 DB 读取
 * Readiness + RunEnvelope，产出逐 case gate、Soft 多维分与汇总报告。它不调用真实
 * 下单；LT case 只验证 order_intent / risk_decision / HITL 前的研究路径。
 *
 * 过滤：
 *   QUBIT_BENCH_CASES=QB-RS-01,QB-MEM-01
 *   QUBIT_BENCH_TAGS=memory,orchestration
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runReadinessFromWorkflowId } from "../src/runtime/agent-readiness/runner";
import {
  listQubitBenchCases,
  QUBIT_BENCH_CASES,
  QUBIT_BENCH_VERSION,
  type QubitBenchCase,
} from "../src/runtime/benchmark/qubit-bench-cases";
import { buildRunEnvelope } from "../src/runtime/benchmark/run-envelope";
import { scoreRunEnvelope } from "../src/runtime/benchmark/scorecard";
import { type UpgradeGateResult, evaluateUpgradeGate } from "../src/runtime/benchmark/upgrade-gate";
import { DEFAULT_USER_PROJECT_ID } from "../src/runtime/bootstrap/ensure-default-workspace";

const DEV_SERVER = process.env.QUBIT_DEV_SERVER ?? "http://127.0.0.1:17385";
const PROJECT_ID = process.env.QUBIT_BENCH_PROJECT_ID ?? DEFAULT_USER_PROJECT_ID;
const label = process.env.QUBIT_BENCH_LABEL ?? new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = resolve(process.env.QUBIT_BENCH_OUT ?? join("out", "qubit-bench", "L1", label));
const selected = resolveCases();

type CaseResult = {
  id: string;
  title: string;
  scenarioKey: string;
  workflowRunId: string | null;
  elapsedMs: number;
  gate: UpgradeGateResult | null;
  soft?: {
    score: number | null;
    status: string;
    dimensions: Array<{ id: string; score: number | null; status: string; detail: string }>;
  };
  trajectory?: {
    score: number | null;
    toolSuccessRate: number | null;
    requiredToolRecall: number | null;
  };
  error?: string;
};

function resolveCases(): readonly QubitBenchCase[] {
  const tagFilter = process.env.QUBIT_BENCH_TAGS?.trim();
  const requested = process.env.QUBIT_BENCH_CASES?.trim();
  let cases: QubitBenchCase[] = [...QUBIT_BENCH_CASES];
  if (tagFilter) {
    const tags = tagFilter
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    cases = listQubitBenchCases({ tags });
  }
  if (requested) {
    const ids = new Set(
      requested
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    );
    cases = cases.filter((item) => ids.has(item.id));
    if (cases.length !== ids.size && !tagFilter) {
      const known = new Set(cases.map((item) => item.id));
      throw new Error(
        `unknown benchmark case(s): ${[...ids].filter((id) => !known.has(id)).join(",")}`
      );
    }
  }
  return cases;
}

async function launchBenchmarkCase(benchmarkCase: QubitBenchCase): Promise<string> {
  const response = await fetch(
    `${DEV_SERVER}/api/v1/research-scenarios/${benchmarkCase.scenarioKey}/launch`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        goal: benchmarkCase.goal,
        inputParams: benchmarkCase.inputParams,
        loopOverrides: {
          maxIterations: benchmarkCase.budget.maxIterations,
          tokenBudget: { maxTotalTokens: benchmarkCase.budget.maxTotalTokens },
        },
      }),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as {
    data?: { workflowRunId?: string };
    error?: string;
    details?: { invalidInputs?: Array<{ field: string; error: string }> };
  };
  if (!response.ok || !payload.data?.workflowRunId) {
    const invalid =
      payload.details?.invalidInputs?.map((item) => `${item.field}:${item.error}`).join(",") ?? "";
    throw new Error(
      `launch_${response.status}:${payload.error ?? "unexpected_response"}${invalid ? `:${invalid}` : ""}`
    );
  }
  return payload.data.workflowRunId;
}

async function runCase(benchmarkCase: QubitBenchCase): Promise<CaseResult> {
  const startedAt = Date.now();
  try {
    const workflowRunId = await launchBenchmarkCase(benchmarkCase);
    const readiness = await runReadinessFromWorkflowId({
      scenario: benchmarkCase.scenarioKey,
      workflowRunId,
      outputDir,
      waitTimeoutMs: benchmarkCase.budget.maxDurationMs,
      pollIntervalMs: 2_000,
    });
    const scorecard = scoreRunEnvelope(
      await buildRunEnvelope({
        workflowRunId,
        suite: "L1",
        harnessVersion: QUBIT_BENCH_VERSION,
      })
    );
    return {
      id: benchmarkCase.id,
      title: benchmarkCase.title,
      scenarioKey: benchmarkCase.scenarioKey,
      workflowRunId,
      elapsedMs: Date.now() - startedAt,
      gate: evaluateUpgradeGate({
        benchmarkCase,
        snapshot: readiness.snapshot,
        grade: readiness.grade,
        scorecard,
        durationMs: readiness.elapsedMs,
      }),
      soft: {
        score: scorecard.layers.soft.score,
        status: scorecard.layers.soft.status,
        dimensions: scorecard.layers.soft.dimensions.map((d) => ({
          id: d.id,
          score: d.score,
          status: d.status,
          detail: d.detail,
        })),
      },
      trajectory: {
        score: scorecard.layers.trajectory.score,
        toolSuccessRate: scorecard.layers.trajectory.metrics.toolSuccessRate,
        requiredToolRecall: scorecard.layers.trajectory.metrics.requiredToolRecall,
      },
    };
  } catch (error) {
    return {
      id: benchmarkCase.id,
      title: benchmarkCase.title,
      scenarioKey: benchmarkCase.scenarioKey,
      workflowRunId: null,
      elapsedMs: Date.now() - startedAt,
      gate: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderSummary(results: readonly CaseResult[]): string {
  const passed = results.filter((result) => result.gate?.status === "pass").length;
  const incomplete = results.filter((result) => result.gate?.status === "incomplete").length;
  const failed = results.length - passed - incomplete;
  const lines = [
    "# QUBIT Benchmark Upgrade Report",
    "",
    `- version: \`${QUBIT_BENCH_VERSION}\``,
    `- label: \`${label}\``,
    `- project: \`${PROJECT_ID}\``,
    `- backend: \`${DEV_SERVER}\``,
    `- cases: ${results.length}; upgrade_pass: ${passed}; incomplete: ${incomplete}; fail: ${failed}`,
    `- research_success: ${results.filter((r) => r.gate?.researchSuccess === "pass").length}/${results.length}`,
    "",
    "| Case | Scenario | Upgrade | Research | Soft | Tools↑ | Memory | Orch | Recipe | Delivery | Quality | Tools | Resource |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    if (!result.gate) {
      lines.push(
        `| ${result.id} | ${result.scenarioKey} | FAIL | FAIL | 0.00 | - | - | - | - | - | - | - | - |`
      );
      continue;
    }
    const dimensions = new Map(result.gate.dimensions.map((item) => [item.name, item.status]));
    const softDims = new Map(
      (result.soft?.dimensions ?? []).map((d) => [d.id, d.score?.toFixed(2) ?? d.status])
    );
    lines.push(
      `| ${result.id} | ${result.scenarioKey} | ${result.gate.status.toUpperCase()} | ${(result.gate.researchSuccess ?? "fail").toUpperCase()} | ${result.soft?.score?.toFixed(2) ?? "-"} | ${result.trajectory?.toolSuccessRate?.toFixed(2) ?? softDims.get("tools") ?? "-"} | ${softDims.get("memory") ?? "-"} | ${softDims.get("orchestration") ?? "-"} | ${softDims.get("recipe") ?? "-"} | ${dimensions.get("delivery")} | ${dimensions.get("quality")} | ${dimensions.get("tools")} | ${dimensions.get("resource")} |`
    );
  }
  lines.push("", "## Failure / incomplete details", "");
  for (const result of results.filter((item) => item.error || item.gate?.status !== "pass")) {
    lines.push(`### ${result.id} · ${result.title}`, "");
    if (result.error) lines.push(`- error: \`${result.error}\``);
    for (const dimension of result.gate?.dimensions ?? []) {
      if (dimension.status !== "pass")
        lines.push(`- ${dimension.name}: ${dimension.status} — ${dimension.detail}`);
    }
    for (const dim of result.soft?.dimensions ?? []) {
      if (dim.status === "scored" && dim.score !== null && dim.score < 0.5) {
        lines.push(`- soft.${dim.id}: ${dim.score.toFixed(2)} — ${dim.detail}`);
      }
    }
    lines.push("");
  }
  lines.push(
    "> **Upgrade** = 晋级门禁（严）；**Research** = 研究可用（软）。**Soft** 列为多维过程分（工具/记忆/编排/recipe/content），不可单独判定 pass。只有 Upgrade 全 PASS 才可作为 challenger 晋级证据。",
    ""
  );
  return lines.join("\n");
}

await mkdir(outputDir, { recursive: true });
console.log(`QUBIT benchmark ${QUBIT_BENCH_VERSION}: ${selected.length} cases, label=${label}`);
const results: CaseResult[] = [];
for (const benchmarkCase of selected) {
  console.log(`▶ ${benchmarkCase.id} ${benchmarkCase.title}`);
  const result = await runCase(benchmarkCase);
  results.push(result);
  console.log(
    `  upgrade=${result.gate?.status ?? "fail"} research=${result.gate?.researchSuccess ?? "fail"} ${result.error ?? ""}`.trim()
  );
}
const summary = renderSummary(results);
await writeFile(join(outputDir, "summary.md"), summary, "utf8");
await writeFile(join(outputDir, "summary.json"), JSON.stringify(results, null, 2), "utf8");
console.log(summary);
if (results.some((result) => result.error || result.gate?.status !== "pass")) process.exit(1);
