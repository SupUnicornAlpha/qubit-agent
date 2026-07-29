/**
 * Finance Memory 写入：zod 门禁 + Experience upsert（A5/A6）
 */

import type { Experience } from "../../types/entities";
import type { ExperienceStore } from "../experience/experience-store";
import { getExperienceStore } from "../experience";
import { isFinanceMemoryStrict } from "./axioms";
import { incContextMetric } from "./context-metrics";
import {
  type FactorArchiveMeta,
  validateFactorArchiveMeta,
} from "./finance-memory-schemas";

export class FinanceMemoryWriteError extends Error {
  readonly errorCode = "finance_memory_schema_invalid" as const;
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "FinanceMemoryWriteError";
    this.issues = issues;
  }
}

export interface UpsertFactorArchiveInput {
  projectId: string;
  meta: FactorArchiveMeta;
  summary?: string;
  body?: string;
  sourceRunId?: string | null;
  definitionId?: string | null;
  store?: ExperienceStore;
}

/**
 * 同 project + factorId + asof 日 upsert 一条 factor_archive。
 * 缺必填字段时：strict 模式抛 FinanceMemoryWriteError；否则记 reject metric 并返回 null。
 */
export async function upsertFactorArchiveExperience(
  input: UpsertFactorArchiveInput
): Promise<Experience | null> {
  const validated = validateFactorArchiveMeta(input.meta);
  if (!validated.ok) {
    incContextMetric("finance.memory_write_reject", 1, { subKind: "factor_archive" });
    if (isFinanceMemoryStrict()) {
      throw new FinanceMemoryWriteError(validated.message, validated.issues);
    }
    return null;
  }
  const meta = validated.data;
  const store = input.store ?? getExperienceStore();
  const asofDay = meta.asof.slice(0, 10);

  const recent = await store.query({
    kind: "semantic",
    subKind: "factor_archive",
    scope: "project",
    scopeId: input.projectId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 40,
  });
  const existing = recent.find((e) => {
    const m = e.metadataJson ?? {};
    return m["factorId"] === meta.factorId && String(m["asof"] ?? "").slice(0, 10) === asofDay;
  });

  const summary =
    input.summary ??
    `[factor] ${meta.name} ic=${fmt(meta.ic)} rankIc=${fmt(meta.rankIc)} ir=${fmt(meta.ir)} asof=${asofDay}`;

  const tags = [
    `factor:${meta.category}`,
    `universe:${meta.universe}`,
    `tier:${meta.memoryTier}`,
    "subKind:factor_archive",
  ];

  const contentJson = {
    summary,
    ...(input.body ? { body: input.body } : {}),
  };

  if (existing) {
    const updated = await store.update(existing.id, {
      contentJson,
      tagsJson: tags,
      metadataJson: { ...meta },
      qualityScore: Math.max(existing.qualityScore, qualityFromIc(meta)),
    });
    if (existing.id) {
      // supersedes self noop; link from new eval episodic left to caller
    }
    return updated;
  }

  return store.insert({
    kind: "semantic",
    subKind: "factor_archive",
    scope: "project",
    scopeId: input.projectId,
    definitionId: input.definitionId ?? null,
    visibility: "project_shared",
    contentJson,
    tagsJson: tags,
    validFrom: new Date().toISOString(),
    sourceRunId: input.sourceRunId ?? null,
    qualityScore: qualityFromIc(meta),
    metadataJson: { ...meta },
  });
}

function fmt(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(3);
}

function qualityFromIc(meta: FactorArchiveMeta): number {
  const v = Math.abs(meta.rankIc ?? meta.ic ?? 0);
  // 0..0.2 → 0.45..0.85
  return Math.min(0.9, 0.45 + Math.min(0.2, v) * 2);
}
