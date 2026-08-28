import { randomUUID } from "node:crypto";
import { and, eq, inArray, not } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentScore } from "../../db/sqlite/schema";
import type { ScoreDraft, ScoreSource } from "./contracts";
import { encodeScoreColumns } from "./score-value";

export interface ReplaceWorkflowScoresInput {
  workflowRunId: string;
  sessionId?: string | null;
  drafts: ScoreDraft[];
  /** 默认保留 human / llm_judge，只替换 sync 类评分。 */
  preserveSources?: readonly ScoreSource[];
}

const DEFAULT_PRESERVE: readonly ScoreSource[] = ["human", "llm_judge"];

export async function replaceWorkflowScores(input: ReplaceWorkflowScoresInput): Promise<number> {
  if (input.drafts.length === 0) return 0;
  const db = await getDb();
  const preserve = input.preserveSources ?? DEFAULT_PRESERVE;
  const sessionId = input.sessionId ?? null;

  await db
    .delete(agentScore)
    .where(
      and(
        eq(agentScore.workflowRunId, input.workflowRunId),
        not(inArray(agentScore.source, [...preserve]))
      )
    );

  const rows = input.drafts.map((draft) => {
    const encoded = encodeScoreColumns(draft.value);
    return {
      id: randomUUID(),
      name: draft.name,
      dataType: draft.value.dataType,
      ...encoded,
      comment: draft.comment ?? null,
      source: draft.source,
      evaluatorId: draft.evaluatorId ?? null,
      workflowRunId: input.workflowRunId,
      observationId: draft.observationId ?? null,
      sessionId: draft.sessionId ?? sessionId,
      evalRunId: draft.evalRunId ?? null,
      datasetItemId: draft.datasetItemId ?? null,
      configFingerprint: draft.configFingerprint ?? null,
    };
  });

  await db.insert(agentScore).values(rows);
  return rows.length;
}

export async function insertScores(
  workflowRunId: string,
  drafts: ScoreDraft[],
  sessionId?: string | null
): Promise<number> {
  if (drafts.length === 0) return 0;
  const db = await getDb();
  const rows = drafts.map((draft) => {
    const encoded = encodeScoreColumns(draft.value);
    return {
      id: randomUUID(),
      name: draft.name,
      dataType: draft.value.dataType,
      ...encoded,
      comment: draft.comment ?? null,
      source: draft.source,
      evaluatorId: draft.evaluatorId ?? null,
      workflowRunId,
      observationId: draft.observationId ?? null,
      sessionId: draft.sessionId ?? sessionId ?? null,
      evalRunId: draft.evalRunId ?? null,
      datasetItemId: draft.datasetItemId ?? null,
      configFingerprint: draft.configFingerprint ?? null,
    };
  });
  await db.insert(agentScore).values(rows);
  return rows.length;
}
