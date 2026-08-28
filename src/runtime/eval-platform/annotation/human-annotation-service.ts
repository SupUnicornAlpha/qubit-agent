import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { agentScore, workflowRun } from "../../../db/sqlite/schema";
import { assertEvalPlatformAccess } from "../auth/eval-access";
import type { ScoreDataType, ScoreDraft } from "../contracts";
import { addWorkflowToDataset } from "../dataset/dataset-item-service";
import { insertScores } from "../score-writer";
import { decodeScoreValue } from "../score-value";
import type { AgentScoreRecord } from "../contracts";
import { booleanScore, categoricalScore, numericScore, textScore } from "../score-value";

export interface SubmitHumanAnnotationInput {
  workflowRunId: string;
  name?: string;
  dataType: ScoreDataType;
  value: number | string | boolean;
  comment?: string;
  observationId?: string;
  actor?: string;
}

function toDraft(input: SubmitHumanAnnotationInput, sessionId: string | null): ScoreDraft {
  const name = input.name?.trim() || "human.overall";
  const base = {
    name,
    source: "human" as const,
    evaluatorId: input.actor ?? "human.annotator",
    ...(input.comment ? { comment: input.comment } : {}),
    ...(input.observationId ? { observationId: input.observationId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  switch (input.dataType) {
    case "NUMERIC":
      return { ...base, ...numericScore(Number(input.value)) };
    case "BOOLEAN":
      return { ...base, ...booleanScore(Boolean(input.value)) };
    case "CATEGORICAL":
      return { ...base, ...categoricalScore(String(input.value)) };
    case "TEXT":
      return { ...base, ...textScore(String(input.value)) };
  }
}

export async function submitHumanAnnotation(input: SubmitHumanAnnotationInput) {
  assertEvalPlatformAccess({ action: "annotate", actor: input.actor });
  const db = await getDb();
  const wf = await db
    .select({ sessionId: workflowRun.sessionId })
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowRunId))
    .limit(1);
  if (!wf[0]) throw new Error(`workflow_not_found:${input.workflowRunId}`);

  const draft = toDraft(input, wf[0].sessionId ?? null);
  const written = await insertScores(input.workflowRunId, [draft], wf[0].sessionId);
  return { written, name: draft.name };
}

export async function listHumanAnnotations(workflowRunId: string): Promise<AgentScoreRecord[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentScore)
    .where(and(eq(agentScore.workflowRunId, workflowRunId), eq(agentScore.source, "human")))
    .orderBy(desc(agentScore.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    value: decodeScoreValue({
      dataType: row.dataType,
      valueNumeric: row.valueNumeric,
      valueCategorical: row.valueCategorical,
      valueBoolean: row.valueBoolean,
      valueText: row.valueText,
    }),
    ...(row.comment ? { comment: row.comment } : {}),
    source: row.source,
    ...(row.evaluatorId ? { evaluatorId: row.evaluatorId } : {}),
    workflowRunId: row.workflowRunId,
    ...(row.observationId ? { observationId: row.observationId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    createdAt: row.createdAt,
  }));
}

export async function exportWorkflowAnnotationsToGolden(input: {
  datasetId: string;
  workflowRunId: string;
  caseKey?: string;
  actor?: string;
}) {
  assertEvalPlatformAccess({ action: "export_golden", actor: input.actor });
  const humanScores = await listHumanAnnotations(input.workflowRunId);
  const expected: Record<string, unknown> = {
    humanScores: humanScores.map((row) => ({
      name: row.name,
      dataType: row.value.dataType,
      value: row.value,
      comment: row.comment,
    })),
  };
  const item = await addWorkflowToDataset({
    datasetId: input.datasetId,
    workflowRunId: input.workflowRunId,
    ...(input.caseKey ? { caseKey: input.caseKey } : {}),
    expectedJson: expected,
    metadataJson: {
      exportedFrom: "human_annotation",
      exportedAt: new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
    },
  });
  return item;
}

/** 批量导出：同一 dataset 下多个 workflow（去重 caseKey）。 */
export async function exportGoldenBatch(input: {
  datasetId: string;
  workflowRunIds: string[];
  actor?: string;
}) {
  assertEvalPlatformAccess({ action: "export_golden", actor: input.actor });
  const items = [];
  for (const workflowRunId of input.workflowRunIds) {
    items.push(
      await exportWorkflowAnnotationsToGolden({
        datasetId: input.datasetId,
        workflowRunId,
        actor: input.actor,
      })
    );
  }
  return { count: items.length, items };
}
