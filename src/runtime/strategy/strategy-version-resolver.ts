import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  type indicatorStrategyScript,
  strategy,
  strategyVersion,
  workflowRun,
} from "../../db/sqlite/schema";

export async function ensureStrategyVersionForScript(
  db: DbClient,
  script: typeof indicatorStrategyScript.$inferSelect
): Promise<{ strategyVersionId: string; workflowRunId: string }> {
  const workflowRunId = script.workflowRunId;
  if (!workflowRunId) throw new Error("strategy_script_missing_workflow_run");
  const runs = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  const run = runs[0];
  if (!run) throw new Error("workflow_run_not_found");

  const logicHash = `script-${script.id}`;
  const exactVersions = await db
    .select()
    .from(strategyVersion)
    .where(eq(strategyVersion.logicHash, logicHash))
    .limit(1);
  if (exactVersions[0]) return { strategyVersionId: exactVersions[0].id, workflowRunId };

  const strategyId = randomUUID();
  await db.insert(strategy).values({
    id: strategyId,
    projectId: run.projectId,
    name: script.name,
    style: "low_freq",
    description: `strategy_script:${script.id}`,
  });
  const strategyVersionId = randomUUID();
  await db.insert(strategyVersion).values({
    id: strategyVersionId,
    strategyId,
    versionTag: "v1",
    logicHash,
    paramSchemaJson: {},
    workflowRunId,
  });
  return { strategyVersionId, workflowRunId };
}
