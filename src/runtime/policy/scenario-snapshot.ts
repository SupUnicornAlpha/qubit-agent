/**
 * Single-read ScenarioRuntimeSnapshot for ToolSurface / Recovery / Completion.
 * Prefer injecting a sqlite handle from callers; hot path should not call
 * getSqliteForTesting() repeatedly once snapshot is loaded once per iteration.
 */

import type { Database } from "bun:sqlite";
import type { A2aTaskFact, ChildEvidenceFact } from "../a2a/evidence-aggregate";
import {
  type ArtifactGapDetail,
  checkRequiredArtifacts,
  resolveScenarioKey,
} from "../agent-readiness/quality/artifact-checker";
import { getScenarioExpectation } from "../agent-readiness/quality/scenario-expectations";
import {
  assessRequiredToolGate,
  listAuthorizedToolsFromSqlite,
  listWorkflowAttemptedToolsFromSqlite,
  listWorkflowSuccessfulToolsFromSqlite,
} from "../tools/required-tool-gate";
import { resolveScenarioRecipe } from "./scenario-recipe";
import type { ScenarioRecipe } from "./types";

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
  /** Full artifact facts let terminal policy stay read-only and pure. */
  missingArtifacts: ArtifactGapDetail[];
  /** Upgrade-grade artifact completeness (full minRows from expectations). */
  artifactsOk: boolean;
  /**
   * Research-floor completeness: every recipe artifact with researchMinRows>0 has ≥ floor rows.
   * Used by soft terminal gates so underfill does not hard-block finalize.
   */
  researchArtifactsOk: boolean;
  factorDefinitionCount: number;
  /** Recovery inputs, preloaded by the FactsPort instead of queried in policy. */
  activeFactorIds: string[];
  latestFactorDefinitionId: string | null;
  screenerTopSymbol: string | null;
  /** Ranked screener symbols, used to avoid recovery repeatedly writing the same recommendation. */
  screenerCandidateSymbols?: string[];
  /** Existing recommendation symbols for the workflow, normalized to uppercase. */
  recommendationSymbols?: string[];
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
  const attemptedTools = listWorkflowAttemptedToolsFromSqlite(input.sqlite, input.workflowId, [
    ...(input.extraAttemptedTools ?? []),
  ]);
  const successfulTools = listWorkflowSuccessfulToolsFromSqlite(input.sqlite, input.workflowId, []);

  let notAttemptedCapabilities: string[] = [];
  let unavailableCapabilities: string[] = [];
  let missingArtifactTables: string[] = [];
  let missingArtifacts: ArtifactGapDetail[] = [];
  let artifactsOk = true;
  let researchArtifactsOk = true;

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
      missingArtifacts = artifacts.missing;
      researchArtifactsOk = computeResearchArtifactsOk({
        sqlite: input.sqlite,
        workflowId: input.workflowId,
        recipe,
        missingArtifactTables,
      });
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
    missingArtifacts,
    artifactsOk,
    researchArtifactsOk,
    factorDefinitionCount: countFactorDefinitions(input.sqlite, input.workflowId),
    activeFactorIds: listActiveFactorIds(input.sqlite, input.workflowId, 3),
    latestFactorDefinitionId: latestFactorDefinitionId(input.sqlite, input.workflowId),
    screenerTopSymbol: pickScreenerTopSymbol(input.sqlite, input.workflowId),
    screenerCandidateSymbols: listScreenerCandidateSymbols(input.sqlite, input.workflowId),
    recommendationSymbols: listRecommendationSymbols(input.sqlite, input.workflowId),
    strategyVersionId: latestStrategyVersionId(input.sqlite, input.workflowId),
    loadedAtMs: Date.now(),
  };
}

function computeResearchArtifactsOk(input: {
  sqlite: Database;
  workflowId: string;
  recipe: ScenarioRecipe | null;
  missingArtifactTables: string[];
}): boolean {
  if (!input.recipe) return input.missingArtifactTables.length === 0;
  for (const artifact of input.recipe.completion.artifacts) {
    const floor = artifact.researchMinRows ?? 1;
    if (floor <= 0) continue;
    const count = countTableRows(input.sqlite, input.workflowId, artifact.table);
    if (count < floor) return false;
  }
  return true;
}

function countTableRows(sqlite: Database, workflowId: string, table: string): number {
  const sql: Record<string, string> = {
    recommendation_snapshot: `SELECT COUNT(*) AS c FROM recommendation_snapshot WHERE workflow_run_id = ?`,
    screener_candidate: `SELECT COUNT(*) AS c FROM screener_candidate sc
      JOIN screener_run sr ON sr.id = sc.screener_run_id WHERE sr.workflow_run_id = ?`,
    factor_definition: `SELECT COUNT(*) AS c FROM factor_definition WHERE workflow_run_id = ?`,
    factor_evaluation: `SELECT COUNT(*) AS c FROM factor_evaluation fe
      JOIN factor_definition fd ON fd.id = fe.factor_id WHERE fd.workflow_run_id = ?`,
    strategy_version: `SELECT COUNT(*) AS c FROM strategy_version WHERE workflow_run_id = ?`,
    strategy_composition: `SELECT COUNT(*) AS c FROM strategy_composition WHERE workflow_run_id = ?`,
    order_intent: `SELECT COUNT(*) AS c FROM order_intent WHERE workflow_run_id = ?`,
    risk_decision: `SELECT COUNT(*) AS c FROM risk_decision rd
      JOIN order_intent oi ON oi.id = rd.order_intent_id WHERE oi.workflow_run_id = ?`,
  };
  const query = sql[table];
  if (!query) return 0;
  try {
    const row = sqlite.prepare(query).get(workflowId) as { c: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function listActiveFactorIds(sqlite: Database, workflowId: string, limit: number): string[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT id AS id FROM factor_definition
         WHERE workflow_run_id = ? AND coalesce(status, 'active') != 'archived'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(workflowId, limit) as Array<{ id: string }>;
    return rows.map((row) => row.id).filter(Boolean);
  } catch {
    return [];
  }
}

function countFactorDefinitions(sqlite: Database, workflowId: string): number {
  try {
    const row = sqlite
      .prepare("SELECT COUNT(*) AS c FROM factor_definition WHERE workflow_run_id = ?")
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

function latestFactorDefinitionId(sqlite: Database, workflowId: string): string | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT id AS id FROM factor_definition
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

function pickScreenerTopSymbol(sqlite: Database, workflowId: string): string | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT sc.ticker AS ticker
         FROM screener_candidate sc
         JOIN screener_run sr ON sr.id = sc.screener_run_id
         WHERE sr.workflow_run_id = ?
         ORDER BY sc.score DESC
         LIMIT 1`
      )
      .get(workflowId) as { ticker?: string } | undefined;
    const ticker = (row?.ticker ?? "").trim().toUpperCase();
    return ticker || null;
  } catch {
    return null;
  }
}

function listScreenerCandidateSymbols(sqlite: Database, workflowId: string): string[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT sc.ticker AS ticker
         FROM screener_candidate sc
         JOIN screener_run sr ON sr.id = sc.screener_run_id
         WHERE sr.workflow_run_id = ?
         ORDER BY sc.score DESC
         LIMIT 20`
      )
      .all(workflowId) as Array<{ ticker?: string }>;
    return [...new Set(rows.map((row) => (row.ticker ?? "").trim().toUpperCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

function listRecommendationSymbols(sqlite: Database, workflowId: string): string[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT symbol FROM recommendation_snapshot
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC
         LIMIT 50`
      )
      .all(workflowId) as Array<{ symbol?: string }>;
    return [...new Set(rows.map((row) => (row.symbol ?? "").trim().toUpperCase()).filter(Boolean))];
  } catch {
    return [];
  }
}
