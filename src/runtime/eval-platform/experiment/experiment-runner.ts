import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { evalCaseResult, evalRun } from "../../../db/sqlite/schema";
import { researchScenarioService } from "../../research-scenario/service";
import { persistWorkflowEvalScores } from "../orchestrator";
import { listScores } from "../score-query";
import { listDatasetItems } from "../dataset/dataset-item-service";
import { waitForWorkflowTerminal } from "./workflow-wait";

export interface ExperimentRunInput {
  datasetId: string;
  experimentLabel: string;
  configFingerprint: string;
  projectId: string;
  baselineRunId?: string;
  /** replay=只用 sourceWorkflowRunId；launch=按 inputJson 重新跑 */
  mode?: "replay" | "launch";
  waitTimeoutMs?: number;
}

export interface ExperimentCaseOutcome {
  caseKey: string;
  datasetItemId: string;
  workflowRunId: string | null;
  score: number;
  pass: boolean;
  error?: string;
}

export interface ExperimentRunResult {
  runId: string;
  baselineRunId: string | null;
  cases: ExperimentCaseOutcome[];
  summary: {
    caseCount: number;
    passCount: number;
    passRate: number;
    avgScore: number;
  };
}

function readLaunchInput(inputJson: Record<string, unknown>, fallbackProjectId: string) {
  const scenarioKey = typeof inputJson.scenarioKey === "string" ? inputJson.scenarioKey : null;
  const goal = typeof inputJson.goal === "string" ? inputJson.goal : "";
  const projectId = typeof inputJson.projectId === "string" ? inputJson.projectId : fallbackProjectId;
  const inputParams =
    typeof inputJson.inputParams === "object" && inputJson.inputParams
      ? (inputJson.inputParams as Record<string, unknown>)
      : {};
  return { scenarioKey, goal, projectId, inputParams };
}

async function primaryScore(workflowRunId: string): Promise<number> {
  const scores = await listScores({ workflowRunId, limit: 100 });
  const preferred = scores.find((s) => s.name === "benchmark.overall.score");
  if (preferred?.value.dataType === "NUMERIC" && typeof preferred.value.numeric === "number") {
    return preferred.value.numeric;
  }
  const aqm = scores.find((s) => s.name === "aqm.weighted_score");
  if (aqm?.value.dataType === "NUMERIC" && typeof aqm.value.numeric === "number") {
    return aqm.value.numeric;
  }
  return 0;
}

export async function runExperiment(input: ExperimentRunInput): Promise<ExperimentRunResult> {
  const db = await getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const mode = input.mode ?? "replay";
  const items = await listDatasetItems(input.datasetId);

  await db.insert(evalRun).values({
    id: runId,
    datasetId: input.datasetId,
    status: "running",
    startedAt: now,
    configFingerprint: input.configFingerprint,
    experimentLabel: input.experimentLabel,
    configSnapshotJson: {
      mode,
      experimentLabel: input.experimentLabel,
      baselineRunId: input.baselineRunId ?? null,
    },
  });

  const cases: ExperimentCaseOutcome[] = [];

  for (const item of items) {
    try {
      let workflowRunId = item.sourceWorkflowRunId;
      if (mode === "launch") {
        const launch = readLaunchInput(item.inputJson, input.projectId);
        if (!launch.scenarioKey) {
          throw new Error("missing scenarioKey in dataset item inputJson");
        }
        const launched = await researchScenarioService.launch({
          projectId: launch.projectId,
          scenarioKey: launch.scenarioKey,
          goal: launch.goal,
          inputParams: launch.inputParams,
        });
        workflowRunId = launched.workflowRunId;
        await waitForWorkflowTerminal({
          workflowRunId,
          timeoutMs: input.waitTimeoutMs,
        });
      }

      if (!workflowRunId) {
        throw new Error("no workflowRunId for dataset item");
      }

      await persistWorkflowEvalScores({
        workflowRunId,
        configFingerprint: input.configFingerprint,
      });

      const score = await primaryScore(workflowRunId);
      const pass = score >= 0.6;
      cases.push({
        caseKey: item.caseKey,
        datasetItemId: item.id,
        workflowRunId,
        score,
        pass,
      });

      await db.insert(evalCaseResult).values({
        id: randomUUID(),
        evalRunId: runId,
        caseKey: item.caseKey,
        workflowRunId,
        expectedJson: item.expectedJson,
        actualJson: { score, workflowRunId, datasetItemId: item.id },
        score,
        pass,
      });
    } catch (err) {
      cases.push({
        caseKey: item.caseKey,
        datasetItemId: item.id,
        workflowRunId: null,
        score: 0,
        pass: false,
        error: err instanceof Error ? err.message : String(err),
      });
      await db.insert(evalCaseResult).values({
        id: randomUUID(),
        evalRunId: runId,
        caseKey: item.caseKey,
        expectedJson: item.expectedJson,
        actualJson: { error: err instanceof Error ? err.message : String(err) },
        score: 0,
        pass: false,
      });
    }
  }

  const passCount = cases.filter((c) => c.pass).length;
  const avgScore = cases.length
    ? cases.reduce((sum, c) => sum + c.score, 0) / cases.length
    : 0;
  const summary = {
    caseCount: cases.length,
    passCount,
    passRate: cases.length ? passCount / cases.length : 0,
    avgScore,
  };

  await db
    .update(evalRun)
    .set({
      status: "completed",
      endedAt: new Date().toISOString(),
      summaryMetricsJson: summary,
    })
    .where(eq(evalRun.id, runId));

  return {
    runId,
    baselineRunId: input.baselineRunId ?? null,
    cases,
    summary,
  };
}

export interface ExperimentDiffRow {
  caseKey: string;
  baselineScore: number | null;
  challengerScore: number | null;
  delta: number | null;
}

export async function diffExperimentRuns(
  baselineRunId: string,
  challengerRunId: string
): Promise<{
  baselineRunId: string;
  challengerRunId: string;
  rows: ExperimentDiffRow[];
  summary: { improved: number; regressed: number; unchanged: number };
}> {
  const db = await getDb();
  const [baselineCases, challengerCases] = await Promise.all([
    db.select().from(evalCaseResult).where(eq(evalCaseResult.evalRunId, baselineRunId)),
    db.select().from(evalCaseResult).where(eq(evalCaseResult.evalRunId, challengerRunId)),
  ]);

  const baselineByKey = new Map(baselineCases.map((row) => [row.caseKey, row]));
  const keys = new Set([
    ...baselineCases.map((row) => row.caseKey),
    ...challengerCases.map((row) => row.caseKey),
  ]);

  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  const rows: ExperimentDiffRow[] = [];

  for (const caseKey of keys) {
    const base = baselineByKey.get(caseKey)?.score ?? null;
    const challenger = challengerCases.find((row) => row.caseKey === caseKey)?.score ?? null;
    const delta = base !== null && challenger !== null ? challenger - base : null;
    if (delta === null) {
      /* skip */
    } else if (delta > 0.001) improved += 1;
    else if (delta < -0.001) regressed += 1;
    else unchanged += 1;

    rows.push({ caseKey, baselineScore: base, challengerScore: challenger, delta });
  }

  return {
    baselineRunId,
    challengerRunId,
    rows,
    summary: { improved, regressed, unchanged },
  };
}
