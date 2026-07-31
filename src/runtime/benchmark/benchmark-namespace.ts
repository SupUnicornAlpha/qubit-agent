import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { parseLoopOptionsJson } from "../../types/loop";

export function isBenchmarkNamespace(rawLoopOptions: unknown): boolean {
  return parseLoopOptionsJson(rawLoopOptions).benchmarkNamespace === true;
}

export async function isBenchmarkWorkflow(workflowRunId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .select({ loopOptionsJson: workflowRun.loopOptionsJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  return isBenchmarkNamespace(rows[0]?.loopOptionsJson);
}
