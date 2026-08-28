import { isBenchmarkWorkflow } from "../../benchmark/benchmark-namespace";
import { insertScores } from "../score-writer";
import { runAsyncEvaluators } from "../evaluators/llm-judge-runner";
import {
  compareScoreWindows,
  scanScoreRegressionAlerts as scanScoreRegressionAlertsImpl,
} from "../analytics/score-analytics";

type QueueItem = { workflowRunId: string; enqueuedAt: string };

const queue: QueueItem[] = [];
let draining = false;

async function loadEvalContext(workflowRunId: string) {
  const { getDb, getSqliteForTesting } = await import("../../../db/sqlite/client");
  await getDb();
  const sqlite = getSqliteForTesting();
  return sqlite
    .prepare(
      `SELECT session_id AS sessionId, research_scenario_id AS scenarioKey
       FROM workflow_run WHERE id = ?`
    )
    .get(workflowRunId) as
    | { sessionId: string | null; scenarioKey: string | null }
    | undefined;
}

async function processItem(workflowRunId: string): Promise<void> {
  if (await isBenchmarkWorkflow(workflowRunId)) return;
  const workflow = await loadEvalContext(workflowRunId);
  if (!workflow) return;

  const { drafts } = await runAsyncEvaluators({
    workflowRunId,
    sessionId: workflow.sessionId,
    scenarioKey: workflow.scenarioKey,
  });
  if (drafts.length > 0) {
    await insertScores(workflowRunId, drafts, workflow.sessionId);
  }
  await scanScoreRegressionAlertsImpl().catch((err) => {
    console.warn("[eval-platform] score alert scan failed:", err);
  });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      try {
        await processItem(item.workflowRunId);
      } catch (err) {
        console.warn(
          `[eval-platform] async eval failed for ${item.workflowRunId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  } finally {
    draining = false;
  }
}

/** Fire-and-forget：workflow 终态后 enqueue，不阻塞 caller。 */
export function enqueueAsyncEval(workflowRunId: string): void {
  queue.push({ workflowRunId, enqueuedAt: new Date().toISOString() });
  void drainQueue();
}

/** 单测 / 脚本同步跑完队列。 */
export async function flushAsyncEvalQueueForTesting(): Promise<void> {
  await drainQueue();
}

export function asyncEvalQueueDepth(): number {
  return queue.length;
}
