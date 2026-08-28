import { getDb, getSqliteForTesting } from "../../../db/sqlite/client";
import { getScenarioRecipe, type ScenarioRecipe } from "../../agent-readiness/scenarios";
import { collectContentJudge } from "../../agent-readiness/quality/content-judge";
import { createJudgeClient } from "../../agent-readiness/quality/judge-client-factory";
import type { ScoreDraft } from "../contracts";
import { numericScore } from "../score-value";
import { listEnabledLlmJudgeEvaluators } from "./registry";
import { resolveSampleRate, shouldSampleWorkflow } from "./sampling";
import type { EvaluatorRunContext, EvaluatorRunResult, LlmJudgeEvaluatorConfig } from "./types";

function isScenarioKey(value: string | null): value is ScenarioRecipe["key"] {
  if (!value) return false;
  try {
    getScenarioRecipe(value as ScenarioRecipe["key"]);
    return true;
  } catch {
    return false;
  }
}

function judgeResultToDrafts(
  config: LlmJudgeEvaluatorConfig,
  ctx: EvaluatorRunContext,
  a3: number | null,
  details: Awaited<ReturnType<typeof collectContentJudge>>["details"]
): ScoreDraft[] {
  const drafts: ScoreDraft[] = [];
  if (a3 !== null) {
    drafts.push({
      name: config.outputScoreName,
      ...numericScore(a3),
      source: "llm_judge",
      evaluatorId: config.id,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.configFingerprint ? { configFingerprint: ctx.configFingerprint } : {}),
    });
  }
  for (const judged of details.judged) {
    drafts.push({
      name: `${config.outputScoreName}.artifact.${judged.kind}`,
      ...numericScore(judged.score.overall, judged.score.issues.join("; ")),
      source: "llm_judge",
      evaluatorId: config.id,
      observationId: `${ctx.workflowRunId}:artifact:${judged.identifier}`,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
  }
  return drafts;
}

async function runLlmJudgeEvaluator(
  config: LlmJudgeEvaluatorConfig,
  ctx: EvaluatorRunContext
): Promise<ScoreDraft[]> {
  const rate = resolveSampleRate(config.sampleRate);
  if (!shouldSampleWorkflow(ctx.workflowRunId, rate)) return [];
  if (!isScenarioKey(ctx.scenarioKey)) return [];

  if (process.env.QUBIT_EVAL_JUDGE_ENABLED === "0") return [];

  const judge = await createJudgeClient();
  await getDb();
  const sqlite = getSqliteForTesting();
  const result = await collectContentJudge(sqlite, judge, {
    workflowRunId: ctx.workflowRunId,
    scenario: ctx.scenarioKey,
    maxArtifacts: config.maxArtifacts ?? 5,
  });
  return judgeResultToDrafts(config, ctx, result["A-3"], result.details);
}

export async function runAsyncEvaluators(ctx: EvaluatorRunContext): Promise<{
  results: EvaluatorRunResult[];
  drafts: ScoreDraft[];
}> {
  const results: EvaluatorRunResult[] = [];
  const drafts: ScoreDraft[] = [];

  for (const config of listEnabledLlmJudgeEvaluators()) {
    try {
      const batch = await runLlmJudgeEvaluator(config, ctx);
      if (batch.length === 0) {
        results.push({
          evaluatorId: config.id,
          skipped: true,
          skipReason: "sample_or_no_artifacts",
          scoresWritten: 0,
        });
        continue;
      }
      drafts.push(...batch);
      results.push({
        evaluatorId: config.id,
        skipped: false,
        scoresWritten: batch.length,
      });
    } catch (err) {
      results.push({
        evaluatorId: config.id,
        skipped: true,
        skipReason: err instanceof Error ? err.message : String(err),
        scoresWritten: 0,
      });
    }
  }

  return { results, drafts };
}
