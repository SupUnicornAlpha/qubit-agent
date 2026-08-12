/**
 * Append-only DeliveryVerdict ledger (workflow_delivery_verdict).
 */

import { getRuntimeSqlite } from "./repositories/runtime-sqlite";
import type { DeliveryVerdict } from "./types";

export async function persistDeliveryVerdict(input: {
  workflowId: string;
  verdict: DeliveryVerdict;
}): Promise<void> {
  try {
    const sqlite = getRuntimeSqlite();
    sqlite
      .prepare(
        `INSERT INTO workflow_delivery_verdict (
           id, workflow_run_id, state, reason_codes_json, missing_artifacts_json,
           missing_capabilities_json, data_gaps_json, answer_json,
           evaluator_version, recipe_key, recipe_version, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        input.workflowId,
        input.verdict.state,
        JSON.stringify(input.verdict.reasonCodes),
        JSON.stringify(input.verdict.missingArtifacts),
        JSON.stringify(input.verdict.missingCapabilities),
        JSON.stringify(input.verdict.dataGaps),
        JSON.stringify(input.verdict.answer),
        input.verdict.evaluatorVersion,
        input.verdict.recipeKey,
        input.verdict.recipeVersion,
        new Date().toISOString()
      );
  } catch {
    /* table may not exist yet — non-fatal for shadow path */
  }
}

export function readLatestDeliveryVerdict(
  sqlite: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  workflowId: string
): DeliveryVerdict | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT state, reason_codes_json, missing_artifacts_json, missing_capabilities_json,
                data_gaps_json, answer_json, evaluator_version, recipe_key, recipe_version
         FROM workflow_delivery_verdict
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workflowId) as
      | {
          state: DeliveryVerdict["state"];
          reason_codes_json: string;
          missing_artifacts_json: string;
          missing_capabilities_json: string;
          data_gaps_json: string;
          answer_json: string;
          evaluator_version: string;
          recipe_key: string | null;
          recipe_version: string | null;
        }
      | undefined;
    if (!row) return null;
    const reasonCodes = JSON.parse(row.reason_codes_json || "[]") as string[];
    const softReasonCodes = reasonCodes.filter(
      (code) =>
        code === "answer_schema_unsatisfied" ||
        code === "a2a_gap" ||
        code.startsWith("artifact_underfill:") ||
        code.startsWith("artifact_fields_incomplete:")
    );
    const researchOk = row.state === "delivered" || row.state === "delivered_with_gaps";
    return {
      state: row.state,
      reasonCodes,
      softReasonCodes,
      missingArtifacts: JSON.parse(row.missing_artifacts_json || "[]") as string[],
      missingCapabilities: JSON.parse(row.missing_capabilities_json || "[]") as string[],
      dataGaps: JSON.parse(row.data_gaps_json || "[]") as DeliveryVerdict["dataGaps"],
      answer: JSON.parse(
        row.answer_json || '{"schemaOk":false,"missingSections":[]}'
      ) as DeliveryVerdict["answer"],
      researchOk,
      upgradeOk: row.state === "delivered",
      evaluatorVersion: row.evaluator_version,
      recipeKey: row.recipe_key,
      recipeVersion: row.recipe_version,
    };
  } catch {
    return null;
  }
}
