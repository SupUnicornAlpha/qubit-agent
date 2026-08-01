/**
 * Single-read ScenarioRuntimeSnapshot for ToolSurface / Recovery / Completion.
 * Prefer injecting a sqlite handle from callers; hot path should not call
 * getSqliteForTesting() repeatedly once snapshot is loaded once per iteration.
 */

import type { Database } from "bun:sqlite";
import { getScenarioExpectation } from "../agent-readiness/quality/scenario-expectations";
import {
  checkRequiredArtifacts,
  resolveScenarioKey,
} from "../agent-readiness/quality/artifact-checker";
import {
  assessRequiredToolGate,
  listAuthorizedToolsFromSqlite,
  listWorkflowAttemptedToolsFromSqlite,
  listWorkflowSuccessfulToolsFromSqlite,
} from "../tools/required-tool-gate";
import { resolveScenarioRecipe } from "./scenario-recipe";
import type { ScenarioRecipe } from "./types";
import type { A2aTaskFact, ChildEvidenceFact } from "../a2a/evidence-aggregate";

export interface ScenarioRuntimeSnapshot {
  workflowId: string;
  scenarioKey: string | null;
  recipe: ScenarioRecipe | null;
  authorizedTools: string[];
  attemptedTools: string[];
  successfulTools: string[];
  notAttemptedCapabilities: string[];
  unavailableCapabilities: string[];
  missingArtifactTables: string[];
  artifactsOk: boolean;
  factorDefinitionCount: number;
  strategyVersionId: string | null;
  loadedAtMs: number;
  /** Populated by FactsPort when includeA2a is true. */
  openA2aTasks?: A2aTaskFact[];
  childEvidence?: ChildEvidenceFact[];
  a2aGap?: boolean;
}

export function loadScenarioRuntimeSnapshot(input: {
  sqlite: Database;
  workflowId: string;
  availableTools?: readonly string[];
  extraAttemptedTools?: readonly string[];
}): ScenarioRuntimeSnapshot {
  const scenarioKey = resolveScenarioKey(input.sqlite, input.workflowId);
  const recipe = resolveScenarioRecipe(scenarioKey);
  const available = [...(input.availableTools ?? [])];
  const authorizedTools = listAuthorizedToolsFromSqlite(input.sqlite, available);
  const attemptedTools = listWorkflowAttemptedToolsFromSqlite(
    input.sqlite,
    input.workflowId,
    [...(input.extraAttemptedTools ?? [])]
  );
  const successfulTools = listWorkflowSuccessfulToolsFromSqlite(
    input.sqlite,
    input.workflowId,
    []
  );

  let notAttemptedCapabilities: string[] = [];
  let unavailableCapabilities: string[] = [];
  let missingArtifactTables: string[] = [];
  let artifactsOk = true;

  if (scenarioKey) {
    try {
      const requiredTools = getScenarioExpectation(scenarioKey).requiredTools;
      const gate = assessRequiredToolGate({
        requiredTools,
        authorizedTools,
        attemptedTools,
        runnableTools: available.length > 0 ? available : authorizedTools,
        unavailableManifestTools: [],
        market: "UNKNOWN",
      });
      notAttemptedCapabilities = gate.notAttempted.map((gap) => gap.capability);
      unavailableCapabilities = gate.unavailableRequired.map((gap) => gap.capability);
      const artifacts = checkRequiredArtifacts(input.sqlite, scenarioKey, input.workflowId);
      artifactsOk = artifacts.ok;
      missingArtifactTables = artifacts.missing.map((item) => item.table);
    } catch {
      /* leave defaults */
    }
  }

  return {
    workflowId: input.workflowId,
    scenarioKey,
    recipe,
    authorizedTools,
    attemptedTools,
    successfulTools,
    notAttemptedCapabilities,
    unavailableCapabilities,
    missingArtifactTables,
    artifactsOk,
    factorDefinitionCount: countFactorDefinitions(input.sqlite, input.workflowId),
    strategyVersionId: latestStrategyVersionId(input.sqlite, input.workflowId),
    loadedAtMs: Date.now(),
  };
}

function countFactorDefinitions(sqlite: Database, workflowId: string): number {
  try {
    const row = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM factor_definition WHERE workflow_run_id = ?`)
      .get(workflowId) as { c: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function latestStrategyVersionId(sqlite: Database, workflowId: string): string | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT id AS id FROM strategy_version
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workflowId) as { id?: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}
