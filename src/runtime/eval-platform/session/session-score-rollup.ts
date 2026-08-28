import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { agentScore, workflowRun } from "../../../db/sqlite/schema";

export interface SessionScoreRollupRow {
  name: string;
  count: number;
  avgNumeric: number | null;
  minNumeric: number | null;
  maxNumeric: number | null;
}

export interface SessionScoreRollup {
  sessionId: string;
  workflowCount: number;
  workflows: Array<{
    workflowRunId: string;
    status: string;
    goal: string;
    scoreCount: number;
  }>;
  scores: SessionScoreRollupRow[];
}

export async function rollupSessionScores(sessionId: string): Promise<SessionScoreRollup | null> {
  const db = await getDb();
  const workflows = await db
    .select({
      id: workflowRun.id,
      status: workflowRun.status,
      goal: workflowRun.goal,
    })
    .from(workflowRun)
    .where(eq(workflowRun.sessionId, sessionId));

  if (workflows.length === 0) {
    return {
      sessionId,
      workflowCount: 0,
      workflows: [],
      scores: [],
    };
  }

  const workflowIds = workflows.map((row) => row.id);
  const scores = await db
    .select()
    .from(agentScore)
    .where(inArray(agentScore.workflowRunId, workflowIds));

  const byName = new Map<string, { count: number; sum: number; numericCount: number; min: number; max: number }>();
  const countByWorkflow = new Map<string, number>();

  for (const row of scores) {
    countByWorkflow.set(row.workflowRunId, (countByWorkflow.get(row.workflowRunId) ?? 0) + 1);
    const bucket = byName.get(row.name) ?? {
      count: 0,
      sum: 0,
      numericCount: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };
    bucket.count += 1;
    if (row.dataType === "NUMERIC" && typeof row.valueNumeric === "number") {
      bucket.sum += row.valueNumeric;
      bucket.numericCount += 1;
      bucket.min = Math.min(bucket.min, row.valueNumeric);
      bucket.max = Math.max(bucket.max, row.valueNumeric);
    }
    byName.set(row.name, bucket);
  }

  return {
    sessionId,
    workflowCount: workflows.length,
    workflows: workflows.map((wf) => ({
      workflowRunId: wf.id,
      status: wf.status,
      goal: wf.goal,
      scoreCount: countByWorkflow.get(wf.id) ?? 0,
    })),
    scores: [...byName.entries()]
      .map(([name, bucket]) => ({
        name,
        count: bucket.count,
        avgNumeric: bucket.numericCount > 0 ? bucket.sum / bucket.numericCount : null,
        minNumeric: bucket.numericCount > 0 ? bucket.min : null,
        maxNumeric: bucket.numericCount > 0 ? bucket.max : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
