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
import { researchScenarioService } from "../research-scenario/service";
import { collectSnapshot } from "./snapshot-collector";
import { gradeSnapshot, type ReadinessSnapshot, type SnapshotGrade } from "./grader";
import type { JudgeClient } from "./quality/content-judge";
import { renderJsonReport, renderMarkdownReport } from "./reporters";
import { getScenarioRecipe, type ScenarioRecipe } from "./scenarios";

/**
 * P2 优先级（Round 7 复盘 2026-06-08）：把 scenario 写到 workflow_run.research_scenario_id，
 * 让 act.ts artifact gate 能反查"当前 scenario 是哪个"，进而调 scenario-expectations 检查
 * requiredArtifacts 是否落库。在 wait/snapshot 之前调一次幂等 update。
 *
 * 这是 React loop artifact gate 的前置依赖；如果跳过这一步，act.ts 拿不到 scenarioKey →
 * gate 退化为 no-op（fallback 老行为，安全）。
 */
async function tagWorkflowWithScenario(
  workflowRunId: string,
  scenarioKey: ScenarioRecipe["key"]
): Promise<void> {
  await getDb();
  const sqlite = getSqliteForTesting();
  try {
    sqlite
      .prepare("UPDATE workflow_run SET research_scenario_id = ? WHERE id = ?")
      .run(scenarioKey, workflowRunId);
  } catch (err) {
    /** column 缺失或 workflow 不存在时不阻塞主流程；artifact gate 自动 fallback */
    console.warn(
      `[runner] tagWorkflowWithScenario failed (workflow=${workflowRunId}, scenario=${scenarioKey}):`,
      err
    );
  }
}

export interface RunReadinessInput {
  scenario: ScenarioRecipe["key"];
  projectId: string;
  /** 报告输出目录；不存在会自动建 */
  outputDir: string;
  /** 等终态超时（毫秒），默认 5 分钟 */
  waitTimeoutMs?: number;
  /** 轮询间隔（毫秒），默认 1500 */
  pollIntervalMs?: number;
  /** 可选：A-3 LLM-as-Judge 客户端；不传则跳过 A-3 */
  judgeClient?: JudgeClient;
  /** 单 workflow 评的 artifact 上限 */
  judgeMaxArtifacts?: number;
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

  const launched = await researchScenarioService.launch({
    scenarioKey: recipe.key,
    projectId: input.projectId,
    goal: recipe.workflow.goal,
    inputParams: scenarioInputParamsFromRecipe(recipe),
    agentGroupId: recipe.analystRun.agentGroupId,
    loopOverrides: recipe.workflow.loopOptionsJson as never,
  });
  const workflowRunId = launched.workflowRunId;

  const result = await runReadinessFromWorkflowId({
    scenario: input.scenario,
    workflowRunId,
    outputDir: input.outputDir,
    ...(input.waitTimeoutMs !== undefined ? { waitTimeoutMs: input.waitTimeoutMs } : {}),
    ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
    ...(input.judgeClient ? { judgeClient: input.judgeClient } : {}),
    ...(input.judgeMaxArtifacts !== undefined
      ? { judgeMaxArtifacts: input.judgeMaxArtifacts }
      : {}),
  });

  return { ...result, elapsedMs: Date.now() - startMs };
}

function scenarioInputParamsFromRecipe(recipe: ScenarioRecipe): Record<string, unknown> {
  return {
    ...(recipe.analystRun.ticker ? { ticker: recipe.analystRun.ticker } : {}),
    ...(recipe.analystRun.scope ? { scope: recipe.analystRun.scope } : {}),
    ...(recipe.analystRun.context ? { context: recipe.analystRun.context } : {}),
  };
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
  judgeClient?: JudgeClient;
  judgeMaxArtifacts?: number;
}

export async function runReadinessFromWorkflowId(
  input: RunReadinessFromIdInput
): Promise<RunReadinessResult> {
  const recipe = getScenarioRecipe(input.scenario);
  const startMs = Date.now();

  /**
   * P2 优先级：在等待之前先 tag scenario，确保 react loop 早期就能查到。
   * 幂等：多次调用结果一致；wait/snapshot 不受影响。
   */
  await tagWorkflowWithScenario(input.workflowRunId, recipe.key);

  const { status, timedOut } = await waitForTerminal({
    workflowRunId: input.workflowRunId,
    expected: recipe.expectedTerminalStatus,
    timeoutMs: input.waitTimeoutMs ?? 5 * 60_000,
    pollIntervalMs: input.pollIntervalMs ?? 1500,
  });

  const snapshot = await collectSnapshot({
    workflowRunId: input.workflowRunId,
    scenario: recipe.key,
    ...(input.judgeClient ? { judgeClient: input.judgeClient } : {}),
    ...(input.judgeMaxArtifacts !== undefined
      ? { judgeMaxArtifacts: input.judgeMaxArtifacts }
      : {}),
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
