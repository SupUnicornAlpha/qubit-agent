/**
 * CompletionEvaluator — sole author of DeliveryVerdict.
 * Does not mutate workflow lifecycle status.
 */

import type { Database } from "bun:sqlite";
import { getScenarioExpectation } from "../agent-readiness/quality/scenario-expectations";
import { toolMatchesRequiredCapability } from "../tools/data-gap";
import { assertAnswerSchema } from "./answer-schema";
import { EVALUATOR_VERSION, type DeliveryVerdict, type ScenarioRecipe } from "./types";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";
import { resolveScenarioRecipe } from "./scenario-recipe";

export function evaluateDeliveryVerdict(input: {
  sqlite: Database;
  snapshot: ScenarioRuntimeSnapshot;
  answerText?: string | null;
  /** When true, mustIncludeTerms from recipe answerSchema are enforced (bench). */
  enforceBenchmarkTerms?: boolean;
}): DeliveryVerdict {
  const recipe =
    input.snapshot.recipe ??
    resolveScenarioRecipe(input.snapshot.scenarioKey) ??
    null;
  const reasonCodes: string[] = [];
  const missingArtifacts: string[] = [];
  const missingCapabilities: string[] = [];
  const dataGaps: DeliveryVerdict["dataGaps"] = [];

  if (!input.snapshot.scenarioKey || !recipe) {
    const answer = assertAnswerSchema(
      { requiredSections: ["goal", "evidence", "decision", "risks", "gaps"] },
      input.answerText
    );
    return {
      state: "partial",
      reasonCodes: ["scenario_recipe_missing"],
      missingArtifacts: [],
      missingCapabilities: [],
      dataGaps: [],
      answer,
      evaluatorVersion: EVALUATOR_VERSION,
      recipeKey: null,
      recipeVersion: null,
    };
  }

  // Artifacts: prefer scenario-expectations SQL counts + optional requiredFields.
  for (const artifact of recipe.completion.artifacts) {
    const count = countArtifact(input.sqlite, input.snapshot, artifact.table, recipe);
    if (count < artifact.minRows) {
      missingArtifacts.push(artifact.table);
      reasonCodes.push(`missing_artifact:${artifact.table}`);
      continue;
    }
    if (artifact.requiredFields && artifact.requiredFields.length > 0) {
      const fieldOk = checkRequiredFields(
        input.sqlite,
        input.snapshot.workflowId,
        artifact.table,
        artifact.requiredFields
      );
      if (!fieldOk) {
        missingArtifacts.push(`${artifact.table}:fields`);
        reasonCodes.push(`artifact_fields_incomplete:${artifact.table}`);
      }
    }
  }

  const childTools = (input.snapshot.childEvidence ?? []).flatMap((item) => item.toolNames);
  const effectiveSuccessful = [...new Set([...input.snapshot.successfulTools, ...childTools])];

  for (const req of recipe.completion.requiredTools) {
    const successCount = effectiveSuccessful.filter((toolName) =>
      toolMatchesRequiredCapability(toolName, req.capability)
    ).length;
    if (successCount < req.minSuccess) {
      missingCapabilities.push(req.capability);
      reasonCodes.push(`capability_not_succeeded:${req.capability}`);
    }
  }

  for (const capability of input.snapshot.unavailableCapabilities) {
    dataGaps.push({ capability, class: "unconfigured" });
    reasonCodes.push(`capability_unavailable:${capability}`);
  }

  if (input.snapshot.a2aGap) {
    reasonCodes.push("a2a_gap");
  }

  const { mustIncludeTerms: _benchmarkTerms, ...productAnswerSchema } =
    recipe.completion.answerSchema;
  const answerSchema = input.enforceBenchmarkTerms
    ? recipe.completion.answerSchema
    : productAnswerSchema;
  const answer = assertAnswerSchema(answerSchema, input.answerText);
  if (!answer.schemaOk) {
    reasonCodes.push("answer_schema_unsatisfied");
  }

  let state: DeliveryVerdict["state"];
  if (
    missingArtifacts.length === 0 &&
    missingCapabilities.length === 0 &&
    answer.schemaOk &&
    dataGaps.length === 0
  ) {
    state = "delivered";
  } else if (
    missingArtifacts.length === 0 &&
    missingCapabilities.length === 0 &&
    answer.schemaOk &&
    (dataGaps.length > 0 || input.snapshot.a2aGap)
  ) {
    state = "delivered_with_gaps";
  } else if (dataGaps.some((gap) => gap.class === "infra_error")) {
    state = "failed";
  } else {
    state = "partial";
  }

  return {
    state,
    reasonCodes: [...new Set(reasonCodes)],
    missingArtifacts,
    missingCapabilities,
    dataGaps,
    answer,
    evaluatorVersion: EVALUATOR_VERSION,
    recipeKey: recipe.key,
    recipeVersion: recipe.version,
  };
}

function countArtifact(
  sqlite: Database,
  snapshot: ScenarioRuntimeSnapshot,
  table: string,
  recipe: ScenarioRecipe
): number {
  if (!snapshot.scenarioKey) return 0;
  try {
    const exp = getScenarioExpectation(snapshot.scenarioKey);
    const match =
      exp.requiredArtifacts.find((item) => item.table === table) ??
      exp.qualityGates?.find((item) => item.table === table);
    if (match) {
      const row = sqlite.prepare(match.countSql).get(snapshot.workflowId) as
        | { c: number }
        | undefined;
      return Number(row?.c ?? 0);
    }
  } catch {
    /* fall through */
  }
  // Fallback naive counts for recipe-only tables.
  const fallbackSql: Record<string, string> = {
    order_intent: `SELECT COUNT(*) AS c FROM order_intent WHERE workflow_run_id = ?`,
    risk_decision: `SELECT COUNT(*) AS c FROM risk_decision WHERE workflow_run_id = ?`,
    strategy_version: `SELECT COUNT(*) AS c FROM strategy_version WHERE workflow_run_id = ?`,
    strategy_composition: `SELECT COUNT(*) AS c FROM strategy_composition WHERE workflow_run_id = ?`,
    factor_definition: `SELECT COUNT(*) AS c FROM factor_definition WHERE workflow_run_id = ?`,
    factor_evaluation: `SELECT COUNT(*) AS c FROM factor_evaluation WHERE workflow_run_id = ?`,
    recommendation_snapshot: `SELECT COUNT(*) AS c FROM recommendation_snapshot WHERE workflow_run_id = ?`,
    analyst_signal: `SELECT COUNT(*) AS c FROM analyst_signal WHERE workflow_run_id = ?`,
    signal_fusion_result: `SELECT COUNT(*) AS c FROM signal_fusion_result WHERE workflow_run_id = ?`,
  };
  const sql = fallbackSql[table];
  if (!sql) {
    void recipe;
    return 0;
  }
  try {
    const row = sqlite.prepare(sql).get(snapshot.workflowId) as { c: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function checkRequiredFields(
  sqlite: Database,
  workflowId: string,
  table: string,
  fields: readonly string[]
): boolean {
  const columnSql: Record<string, { sql: string; columns: string[] }> = {
    recommendation_snapshot: {
      sql: `SELECT symbol AS symbol, rationale AS rationale FROM recommendation_snapshot WHERE workflow_run_id = ? LIMIT 20`,
      columns: ["symbol", "rationale"],
    },
    factor_definition: {
      sql: `SELECT name AS name, expression AS expression FROM factor_definition WHERE workflow_run_id = ? LIMIT 5`,
      columns: ["name", "expression"],
    },
    order_intent: {
      sql: `SELECT symbol AS symbol, side AS side, qty AS qty, strategy_version_id AS strategy_version_id
            FROM order_intent WHERE workflow_run_id = ? LIMIT 5`,
      columns: ["symbol", "side", "qty", "strategy_version_id"],
    },
    risk_decision: {
      sql: `SELECT decision AS decision FROM risk_decision WHERE workflow_run_id = ? LIMIT 5`,
      columns: ["decision"],
    },
    strategy_version: {
      sql: `SELECT name AS name FROM strategy_version WHERE workflow_run_id = ? LIMIT 5`,
      columns: ["name"],
    },
    screener_candidate: {
      sql: `SELECT sc.ticker AS ticker, sc.score AS score
            FROM screener_candidate sc
            JOIN screener_run sr ON sr.id = sc.screener_run_id
            WHERE sr.workflow_run_id = ?
            LIMIT 20`,
      columns: ["ticker", "score"],
    },
    analyst_signal: {
      sql: `SELECT ticker AS ticker, reasoning AS reasoning FROM analyst_signal WHERE workflow_run_id = ? LIMIT 10`,
      columns: ["ticker", "reasoning"],
    },
  };
  const spec = columnSql[table];
  if (!spec) return true;
  try {
    const rows = sqlite.prepare(spec.sql).all(workflowId) as Array<Record<string, unknown>>;
    if (rows.length === 0) return false;
    return rows.some((row) =>
      fields.every((field) => {
        const value = row[field];
        if (value === null || value === undefined) return false;
        if (typeof value === "string" && value.trim() === "") return false;
        if (typeof value === "number" && !Number.isFinite(value)) return false;
        return true;
      })
    );
  } catch {
    return false;
  }
}
