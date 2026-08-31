/**
 * strategy_recipe → agent_skill 晋升（05 §4.4.7 / P1）
 */

import type { Experience } from "../../types/entities";
import {
  type StrategyRecipeEvidence,
  type StrategyRecipeEvidenceAssessment,
  assessStrategyRecipeEvidence,
} from "../effect-validation/strategy-recipe-evidence";
import { getExperienceStore } from "../experience";
import type { ExperienceStore } from "../experience/experience-store";
import { skillService } from "../skills/skill-service";
import { incContextMetric } from "./context-metrics";

export interface PromoteRecipeOptions {
  projectId: string;
  mode?: "dry_run" | "live";
  /** quality 门槛 */
  minQuality?: number;
  /** 至少被召回/使用次数 */
  minUseCount?: number;
  store?: ExperienceStore;
  /** 测试注入：已存在的 compositionId */
  existingCompositionIds?: Set<string>;
  /** 测试注入；生产环境以冻结回测、OOS、Holdout 与 paper 证据评估。 */
  evidenceAssessor?: (input: {
    projectId: string;
    compositionId: string;
  }) => Promise<StrategyRecipeEvidenceAssessment>;
}

export interface PromoteRecipeResult {
  scanned: number;
  promoted: number;
  skippedDuplicate: number;
  skippedLowQuality: number;
  skippedInsufficientEvidence: number;
  skillIds: string[];
}

export async function promoteStrategyRecipes(
  opts: PromoteRecipeOptions
): Promise<PromoteRecipeResult> {
  const store = opts.store ?? getExperienceStore();
  const mode = opts.mode ?? "dry_run";
  const minQuality = opts.minQuality ?? 0.55;
  const minUseCount = opts.minUseCount ?? 1;

  const rows = await store.query({
    kind: "procedural",
    subKind: "strategy_recipe",
    scope: "project",
    scopeId: opts.projectId,
    archivalMode: "exclude_archived",
    orderBy: "quality_desc",
    limit: 200,
  });

  const result: PromoteRecipeResult = {
    scanned: rows.length,
    promoted: 0,
    skippedDuplicate: 0,
    skippedLowQuality: 0,
    skippedInsufficientEvidence: 0,
    skillIds: [],
  };

  const existing =
    opts.existingCompositionIds ?? (await listExistingCompositionIds(opts.projectId));
  const assessEvidence = opts.evidenceAssessor ?? assessStrategyRecipeEvidence;

  for (const exp of rows) {
    const compositionId = String(exp.metadataJson?.compositionId ?? "").trim();
    if (!compositionId) {
      result.skippedLowQuality += 1;
      continue;
    }
    if (existing.has(compositionId)) {
      result.skippedDuplicate += 1;
      continue;
    }
    if ((exp.qualityScore ?? 0) < minQuality || (exp.useCount ?? 0) < minUseCount) {
      result.skippedLowQuality += 1;
      continue;
    }
    const assessment = await assessEvidence({ projectId: opts.projectId, compositionId });
    if (!assessment.eligible) {
      result.skippedInsufficientEvidence += 1;
      continue;
    }
    if (mode === "dry_run") {
      result.promoted += 1;
      continue;
    }
    const skill = await createSkillFromRecipe(
      opts.projectId,
      exp,
      compositionId,
      assessment.evidence
    );
    existing.add(compositionId);
    result.promoted += 1;
    result.skillIds.push(skill.id);
    incContextMetric("finance.recipe_promoted", 1);
  }

  return result;
}

async function listExistingCompositionIds(projectId: string): Promise<Set<string>> {
  try {
    const skills = await skillService.list(projectId, { includeArchived: false });
    const out = new Set<string>();
    for (const s of skills) {
      const meta = (s.metadataJson ?? {}) as Record<string, unknown>;
      const cid = meta.compositionId;
      if (typeof cid === "string" && cid) out.add(cid);
    }
    return out;
  } catch {
    return new Set();
  }
}

async function createSkillFromRecipe(
  projectId: string,
  exp: Experience,
  compositionId: string,
  evidence: StrategyRecipeEvidence
) {
  const summary = exp.contentJson.summary ?? `strategy recipe ${compositionId.slice(0, 8)}`;
  const bodyCore = typeof exp.contentJson.body === "string" ? exp.contentJson.body : summary;
  const bodyMd = [
    "# Strategy Recipe",
    "",
    `compositionId: \`${compositionId}\``,
    `validationEvidence: \`${evidence.backtestRunId}\` / \`${evidence.finalHoldoutFingerprint}\``,
    "",
    bodyCore.slice(0, 12_000),
    "",
    `<!-- compositionId: ${compositionId} -->`,
    `<!-- sourceExperienceId: ${exp.id} -->`,
  ].join("\n");

  return skillService.create({
    projectId,
    name: `strategy-recipe-${compositionId.slice(0, 8)}`,
    description: summary.slice(0, 240),
    bodyMd,
    category: "strategy_recipe",
    source: "agent_created",
    state: "pending_review",
    createdBy: "context_protocol:strategy_recipe",
    metadata: {
      compositionId,
      sourceExperienceId: exp.id,
      subKind: "strategy_recipe",
      validationEvidence: evidence,
    },
  });
}
