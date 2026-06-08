/**
 * Agent 就绪度 Runner：
 *
 *   1. 拿 ScenarioRecipe → 调 createAndDispatchWorkflow → 拿 workflowRunId
 *   2. 轮询 workflow_run.status 直到进入终态（completed / failed / cancelled / timeout）或超时
 *   3. 调 collectSnapshot 抓 6 个指标
 *   4. 写 JSON + Markdown 报告
 *
 * 设计原则：
 *   - 启动逻辑不接 LLM mock（设计文档已选 A=主链路真 LLM），由 runner 调用方保证 provider key。
 *   - 纯异步 + 注入式：waitForTerminal 与 reportWriter 都可注入，便于单测。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { collectSnapshot } from "./snapshot-collector";
import { gradeSnapshot, type ReadinessSnapshot, type SnapshotGrade } from "./grader";
import { renderJsonReport, renderMarkdownReport } from "./reporters";
import { getScenarioRecipe, type ScenarioRecipe } from "./scenarios";

export interface RunReadinessInput {
  scenario: ScenarioRecipe["key"];
  projectId: string;
  /** 报告输出目录；不存在会自动建 */
  outputDir: string;
  /** 等终态超时（毫秒），默认 5 分钟 */
  waitTimeoutMs?: number;
  /** 轮询间隔（毫秒），默认 1500 */
  pollIntervalMs?: number;
}

export interface RunReadinessResult {
  scenario: string;
  workflowRunId: string;
  workflowStatus: string;
  snapshot: ReadinessSnapshot;
  grade: SnapshotGrade;
  reports: { jsonPath: string; markdownPath: string };
  /** runner 用了多久（毫秒），方便 P1 接 latency 指标 */
  elapsedMs: number;
  /** true=因为超时退出，没等到终态；snapshot 仍然抓了一份 */
  timedOut: boolean;
}

export async function runReadiness(input: RunReadinessInput): Promise<RunReadinessResult> {
  const recipe = getScenarioRecipe(input.scenario);
  const startMs = Date.now();

  const created = await createAndDispatchWorkflow({
    ...recipe.workflow,
    projectId: input.projectId,
  });
  const workflowRunId = created.data.id;

  const result = await runReadinessFromWorkflowId({
    scenario: input.scenario,
    workflowRunId,
    outputDir: input.outputDir,
    ...(input.waitTimeoutMs !== undefined ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
  });

  return { ...result, elapsedMs: Date.now() - startMs };
}

/**
 * 给一个已经存在的 workflowRunId 出就绪度报告。
 *
 *   - 若工作流仍在 running，会按 timeout 等终态再抓快照（适合"刚 dispatch 完的最新 run"）
 *   - 若已是终态，直接抓 → 报告，几乎瞬时返回
 *   - CLI 的 `--workflow <id>` 模式也会复用这条路径
 */
export interface RunReadinessFromIdInput {
  scenario: ScenarioRecipe["key"];
  workflowRunId: string;
  outputDir: string;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

export async function runReadinessFromWorkflowId(
  input: RunReadinessFromIdInput
): Promise<RunReadinessResult> {
  const recipe = getScenarioRecipe(input.scenario);
  const startMs = Date.now();

  const { status, timedOut } = await waitForTerminal({
    workflowRunId: input.workflowRunId,
    expected: recipe.expectedTerminalStatus,
    timeoutMs: input.waitTimeoutMs ?? 5 * 60_000,
    pollIntervalMs: input.pollIntervalMs ?? 1500,
  });

  const snapshot = await collectSnapshot({
    workflowRunId: input.workflowRunId,
    scenario: recipe.key,
  });
  const grade = gradeSnapshot(snapshot);

  const reports = await writeReports({
    outputDir: input.outputDir,
    snapshot,
    scenario: recipe.key,
    workflowRunId: input.workflowRunId,
  });

  return {
    scenario: recipe.key,
    workflowRunId: input.workflowRunId,
    workflowStatus: status,
    snapshot,
    grade,
    reports,
    elapsedMs: Date.now() - startMs,
    timedOut,
  };
}

interface WaitForTerminalInput {
  workflowRunId: string;
  expected: ReadonlyArray<string>;
  timeoutMs: number;
  pollIntervalMs: number;
}

async function waitForTerminal(input: WaitForTerminalInput): Promise<{
  status: string;
  timedOut: boolean;
}> {
  await getDb();
  const sqlite = getSqliteForTesting();
  const stmt = sqlite.prepare("SELECT status FROM workflow_run WHERE id = ?");
  const deadline = Date.now() + input.timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const row = stmt.get(input.workflowRunId) as { status: string } | undefined;
    if (row) {
      lastStatus = row.status;
      if (input.expected.includes(row.status)) {
        return { status: row.status, timedOut: false };
      }
    }
    await sleep(input.pollIntervalMs);
  }
  return { status: lastStatus, timedOut: true };
}

async function writeReports(opts: {
  outputDir: string;
  snapshot: ReadinessSnapshot;
  scenario: string;
  workflowRunId: string;
}): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(opts.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${opts.scenario}-${opts.workflowRunId}-${stamp}`;
  const jsonPath = join(opts.outputDir, `${base}.json`);
  const markdownPath = join(opts.outputDir, `${base}.md`);
  await writeFile(jsonPath, renderJsonReport(opts.snapshot), "utf8");
  await writeFile(markdownPath, renderMarkdownReport(opts.snapshot), "utf8");
  return { jsonPath, markdownPath };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
