import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { buildRunEnvelope } from "../benchmark/run-envelope";
import { scoreRunEnvelope } from "../benchmark/scorecard";
import { createAqmScoreContributor } from "./contributors/aqm-contributor";
import {
  createBenchmarkScoreContributor,
  scorecardToDrafts,
} from "./contributors/benchmark-contributor";
import { createOutcomeScoreContributor } from "./contributors/outcome-contributor";
import type { ScoreContributor } from "./contracts";
import { replaceWorkflowScores } from "./score-writer";

function loadWorkflowContext(workflowRunId: string): {
  sessionId: string | null;
  scenarioKey: string | null;
} | null {
  const sqlite = getSqliteForTesting();
  const row = sqlite
    .prepare(
      `SELECT session_id AS sessionId, research_scenario_id AS scenarioKey
       FROM workflow_run WHERE id = ?`
    )
    .get(workflowRunId) as { sessionId: string | null; scenarioKey: string | null } | undefined;
  return row ?? null;
}

async function defaultBuildScorecard(workflowRunId: string) {
  try {
    const envelope = await buildRunEnvelope({
      workflowRunId,
      suite: "production",
      harnessVersion: "eval-platform-v1",
    });
    return scoreRunEnvelope(envelope);
  } catch {
    return null;
  }
}

/** 默认 contributor 注册表；调用方可注入 extra contributors 或 override。 */
export function createDefaultScoreContributors(
  overrides?: Partial<{
    contributors: ScoreContributor[];
  }>
): ScoreContributor[] {
  if (overrides?.contributors) return overrides.contributors;
  return [
    createBenchmarkScoreContributor({ buildScorecard: defaultBuildScorecard }),
    createAqmScoreContributor(),
    createOutcomeScoreContributor(),
  ];
}

export interface PersistWorkflowEvalScoresInput {
  workflowRunId: string;
  contributors?: ScoreContributor[];
  configFingerprint?: string;
}

export async function persistWorkflowEvalScores(
  input: PersistWorkflowEvalScoresInput
): Promise<{ written: number; contributorIds: string[] }> {
  await getDb();
  const workflow = loadWorkflowContext(input.workflowRunId);
  if (!workflow) return { written: 0, contributorIds: [] };

  const ctx = {
    workflowRunId: input.workflowRunId,
    sessionId: workflow.sessionId,
    scenarioKey: workflow.scenarioKey,
    ...(input.configFingerprint ? { configFingerprint: input.configFingerprint } : {}),
  };

  const contributors = input.contributors ?? createDefaultScoreContributors();
  const contributorIds: string[] = [];
  const drafts = [];

  for (const contributor of contributors) {
    try {
      const batch = await contributor.contribute(ctx);
      if (batch.length > 0) contributorIds.push(contributor.id);
      drafts.push(...batch);
    } catch (err) {
      console.warn(
        `[eval-platform] contributor ${contributor.id} failed for ${input.workflowRunId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const written = await replaceWorkflowScores({
    workflowRunId: input.workflowRunId,
    sessionId: workflow.sessionId,
    drafts,
  });

  return { written, contributorIds };
}

/** 已有 scorecard 时直接持久化（benchmark runner 用，避免重复 build）。 */
export async function persistScorecardScores(input: {
  workflowRunId: string;
  sessionId?: string | null;
  scorecard: Parameters<typeof scorecardToDrafts>[0];
  configFingerprint?: string;
  extraContributors?: ScoreContributor[];
}): Promise<number> {
  const drafts = scorecardToDrafts(input.scorecard);
  if (input.extraContributors?.length) {
    const workflow = loadWorkflowContext(input.workflowRunId);
    const ctx = {
      workflowRunId: input.workflowRunId,
      sessionId: input.sessionId ?? workflow?.sessionId ?? null,
      scenarioKey: workflow?.scenarioKey ?? null,
      ...(input.configFingerprint ? { configFingerprint: input.configFingerprint } : {}),
    };
    for (const contributor of input.extraContributors) {
      drafts.push(...(await contributor.contribute(ctx)));
    }
  }
  return replaceWorkflowScores({
    workflowRunId: input.workflowRunId,
    sessionId: input.sessionId ?? null,
    drafts,
  });
}
