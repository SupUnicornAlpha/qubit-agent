import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { evalDataset, evalDatasetItem, workflowRun } from "../../../db/sqlite/schema";

export interface DatasetItemRecord {
  id: string;
  datasetId: string;
  caseKey: string;
  inputJson: Record<string, unknown>;
  expectedJson: Record<string, unknown>;
  metadataJson: Record<string, unknown>;
  sourceWorkflowRunId: string | null;
  createdAt: string;
}

export async function listDatasetItems(datasetId: string): Promise<DatasetItemRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(evalDatasetItem)
    .where(eq(evalDatasetItem.datasetId, datasetId))
    .orderBy(desc(evalDatasetItem.createdAt));
  return rows.map(toRecord);
}

export async function getDatasetItem(itemId: string): Promise<DatasetItemRecord | null> {
  const db = await getDb();
  const rows = await db.select().from(evalDatasetItem).where(eq(evalDatasetItem.id, itemId)).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function createDatasetItem(input: {
  datasetId: string;
  caseKey: string;
  inputJson?: Record<string, unknown>;
  expectedJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
  sourceWorkflowRunId?: string;
}): Promise<DatasetItemRecord> {
  const db = await getDb();
  const dataset = await db
    .select({ id: evalDataset.id })
    .from(evalDataset)
    .where(eq(evalDataset.id, input.datasetId))
    .limit(1);
  if (!dataset[0]) throw new Error(`eval_dataset_not_found:${input.datasetId}`);

  const id = randomUUID();
  await db.insert(evalDatasetItem).values({
    id,
    datasetId: input.datasetId,
    caseKey: input.caseKey,
    inputJson: input.inputJson ?? {},
    expectedJson: input.expectedJson ?? {},
    metadataJson: input.metadataJson ?? {},
    sourceWorkflowRunId: input.sourceWorkflowRunId ?? null,
  });
  const created = await getDatasetItem(id);
  if (!created) throw new Error("dataset_item_create_failed");
  return created;
}

export async function updateDatasetItem(
  itemId: string,
  patch: {
    caseKey?: string;
    inputJson?: Record<string, unknown>;
    expectedJson?: Record<string, unknown>;
    metadataJson?: Record<string, unknown>;
    sourceWorkflowRunId?: string | null;
  }
): Promise<DatasetItemRecord | null> {
  const db = await getDb();
  const existing = await getDatasetItem(itemId);
  if (!existing) return null;
  await db
    .update(evalDatasetItem)
    .set({
      ...(patch.caseKey !== undefined ? { caseKey: patch.caseKey } : {}),
      ...(patch.inputJson !== undefined ? { inputJson: patch.inputJson } : {}),
      ...(patch.expectedJson !== undefined ? { expectedJson: patch.expectedJson } : {}),
      ...(patch.metadataJson !== undefined ? { metadataJson: patch.metadataJson } : {}),
      ...(patch.sourceWorkflowRunId !== undefined
        ? { sourceWorkflowRunId: patch.sourceWorkflowRunId }
        : {}),
    })
    .where(eq(evalDatasetItem.id, itemId));
  return getDatasetItem(itemId);
}

export async function deleteDatasetItem(itemId: string): Promise<boolean> {
  const db = await getDb();
  const existing = await getDatasetItem(itemId);
  if (!existing) return false;
  await db.delete(evalDatasetItem).where(eq(evalDatasetItem.id, itemId));
  return true;
}

export async function addWorkflowToDataset(input: {
  datasetId: string;
  workflowRunId: string;
  caseKey?: string;
  expectedJson?: Record<string, unknown>;
  metadataJson?: Record<string, unknown>;
}): Promise<DatasetItemRecord> {
  const db = await getDb();
  const rows = await db
    .select({
      id: workflowRun.id,
      goal: workflowRun.goal,
      projectId: workflowRun.projectId,
      researchScenarioId: workflowRun.researchScenarioId,
      loopOptionsJson: workflowRun.loopOptionsJson,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowRunId))
    .limit(1);
  const workflow = rows[0];
  if (!workflow) throw new Error(`workflow_not_found:${input.workflowRunId}`);

  const loopOptions = (workflow.loopOptionsJson ?? {}) as Record<string, unknown>;
  const inputParams =
    typeof loopOptions.inputParams === "object" && loopOptions.inputParams
      ? (loopOptions.inputParams as Record<string, unknown>)
      : {};

  const caseKey =
    input.caseKey?.trim() ||
    `${workflow.researchScenarioId ?? "workflow"}_${workflow.id.slice(0, 8)}`;

  return createDatasetItem({
    datasetId: input.datasetId,
    caseKey,
    sourceWorkflowRunId: workflow.id,
    inputJson: {
      scenarioKey: workflow.researchScenarioId,
      goal: workflow.goal,
      projectId: workflow.projectId,
      inputParams,
    },
    expectedJson: input.expectedJson ?? {},
    metadataJson: {
      addedFrom: "trace",
      workflowRunId: workflow.id,
      ...(input.metadataJson ?? {}),
    },
  });
}

function toRecord(row: typeof evalDatasetItem.$inferSelect): DatasetItemRecord {
  return {
    id: row.id,
    datasetId: row.datasetId,
    caseKey: row.caseKey,
    inputJson: row.inputJson,
    expectedJson: row.expectedJson,
    metadataJson: row.metadataJson,
    sourceWorkflowRunId: row.sourceWorkflowRunId ?? null,
    createdAt: row.createdAt,
  };
}

export async function countDatasetItems(datasetId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: evalDatasetItem.id })
    .from(evalDatasetItem)
    .where(eq(evalDatasetItem.datasetId, datasetId));
  return rows.length;
}
