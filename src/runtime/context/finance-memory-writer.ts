/**
 * Finance Memory 写入：zod 门禁 + Experience upsert（A5/A6）
 */

import type { Experience } from "../../types/entities";
import type { ExperienceStore } from "../experience/experience-store";
import { getExperienceStore } from "../experience";
import { isFinanceMemoryStrict, isMarketSnapshotWriteEnabled } from "./axioms";
import { incContextMetric } from "./context-metrics";
import {
  type FactorArchiveMeta,
  type MarketSnapshotMeta,
  type PnlEpisodeMeta,
  type StrategyEvalMeta,
  validateFactorArchiveMeta,
  validateMarketSnapshotMeta,
  validatePnlEpisodeMeta,
  validateStrategyEvalMeta,
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

export interface UpsertStrategyEvalInput {
  projectId: string;
  meta: StrategyEvalMeta;
  summary?: string;
  sourceRunId?: string | null;
  store?: ExperienceStore;
}

export async function upsertStrategyEvalExperience(
  input: UpsertStrategyEvalInput
): Promise<Experience | null> {
  const validated = validateStrategyEvalMeta(input.meta);
  if (!validated.ok) {
    incContextMetric("finance.memory_write_reject", 1, { subKind: "strategy_eval" });
    if (isFinanceMemoryStrict()) {
      throw new FinanceMemoryWriteError(validated.message, validated.issues);
    }
    return null;
  }
  const meta = validated.data;
  const store = input.store ?? getExperienceStore();
  const asofDay = meta.asof.slice(0, 10);
  const key = meta.backtestRunId ?? meta.strategyVersionId ?? meta.compositionId ?? "anon";

  const recent = await store.query({
    kind: "semantic",
    subKind: "strategy_eval",
    scope: "project",
    scopeId: input.projectId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 40,
  });
  const existing = recent.find((e) => {
    const m = e.metadataJson ?? {};
    const id =
      (m["backtestRunId"] as string | undefined) ??
      (m["strategyVersionId"] as string | undefined) ??
      (m["compositionId"] as string | undefined) ??
      "anon";
    return id === key && String(m["asof"] ?? "").slice(0, 10) === asofDay;
  });

  const sharpe =
    typeof meta.metrics["sharpe"] === "number" ? (meta.metrics["sharpe"] as number) : undefined;
  const summary =
    input.summary ??
    `[strategy_eval] ${meta.evalKind} pass=${meta.pass ?? "n/a"} sharpe=${fmt(sharpe)} asof=${asofDay}`;

  const tags = [
    `eval:${meta.evalKind}`,
    `tier:${meta.memoryTier}`,
    "subKind:strategy_eval",
    ...(meta.compositionId ? [`composition:${meta.compositionId}`] : []),
  ];
  const contentJson = { summary, metrics: meta.metrics };
  const qualityScore =
    meta.qualityScore ??
    (meta.pass === true ? 0.8 : meta.pass === false ? 0.35 : 0.5);

  if (existing) {
    return store.update(existing.id, {
      contentJson,
      tagsJson: tags,
      metadataJson: { ...meta },
      qualityScore: Math.max(existing.qualityScore, qualityScore),
    });
  }

  return store.insert({
    kind: "semantic",
    subKind: "strategy_eval",
    scope: "project",
    scopeId: input.projectId,
    visibility: "project_shared",
    contentJson,
    tagsJson: tags,
    validFrom: new Date().toISOString(),
    sourceRunId: input.sourceRunId ?? null,
    qualityScore,
    metadataJson: { ...meta },
  });
}

export interface UpsertPnlEpisodeInput {
  /** 有 project 时走 project scope；否则 agent scope + strategyRuntimeId */
  projectId?: string;
  meta: PnlEpisodeMeta;
  summary?: string;
  sourceRunId?: string | null;
  store?: ExperienceStore;
}

export async function upsertPnlEpisodeExperience(
  input: UpsertPnlEpisodeInput
): Promise<Experience | null> {
  const validated = validatePnlEpisodeMeta(input.meta);
  if (!validated.ok) {
    incContextMetric("finance.memory_write_reject", 1, { subKind: "pnl_episode" });
    if (isFinanceMemoryStrict()) {
      throw new FinanceMemoryWriteError(validated.message, validated.issues);
    }
    return null;
  }
  const meta = validated.data;
  const store = input.store ?? getExperienceStore();
  const scope = input.projectId ? ("project" as const) : ("strategy" as const);
  const scopeId =
    input.projectId ?? meta.strategyRuntimeId ?? `pnl:${meta.symbol}:${meta.tradingDay}`;

  const recent = await store.query({
    kind: "semantic",
    subKind: "pnl_episode",
    scope,
    scopeId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 40,
  });
  const existing = recent.find((e) => {
    const m = e.metadataJson ?? {};
    return (
      m["tradingDay"] === meta.tradingDay &&
      String(m["symbol"] ?? "").toUpperCase() === meta.symbol.toUpperCase() &&
      (m["strategyRuntimeId"] ?? null) === (meta.strategyRuntimeId ?? null)
    );
  });

  const summary =
    input.summary ??
    `[pnl] ${meta.symbol} ${meta.tradingDay} realized=${meta.realized.toFixed(2)}`;
  const tags = [
    `symbol:${meta.symbol.toUpperCase()}`,
    `day:${meta.tradingDay}`,
    `tier:${meta.memoryTier}`,
    "subKind:pnl_episode",
  ];
  const contentJson = { summary };
  const qualityScore = Math.min(0.9, 0.4 + Math.min(0.4, Math.abs(meta.realized) / 10_000));

  if (existing) {
    return store.update(existing.id, {
      contentJson,
      tagsJson: tags,
      metadataJson: { ...meta },
      qualityScore: Math.max(existing.qualityScore, qualityScore),
    });
  }

  return store.insert({
    kind: "semantic",
    subKind: "pnl_episode",
    scope,
    scopeId,
    visibility: scope === "project" ? "project_shared" : "agent_private",
    contentJson,
    tagsJson: tags,
    validFrom: new Date().toISOString(),
    sourceRunId: input.sourceRunId ?? null,
    qualityScore,
    metadataJson: { ...meta },
  });
}

export interface UpsertMarketSnapshotInput {
  projectId: string;
  meta: MarketSnapshotMeta;
  summary?: string;
  sourceRunId?: string | null;
  store?: ExperienceStore;
  /** 测试可强制；默认读 FINANCE_MARKET_SNAPSHOT_WRITE */
  forceWrite?: boolean;
}

/**
 * market_snapshot：默认不写（FINANCE_MARKET_SNAPSHOT_WRITE≠1）。
 */
export async function upsertMarketSnapshotExperience(
  input: UpsertMarketSnapshotInput
): Promise<Experience | null> {
  if (!input.forceWrite && !isMarketSnapshotWriteEnabled()) {
    return null;
  }
  const validated = validateMarketSnapshotMeta(input.meta);
  if (!validated.ok) {
    incContextMetric("finance.memory_write_reject", 1, { subKind: "market_snapshot" });
    if (isFinanceMemoryStrict()) {
      throw new FinanceMemoryWriteError(validated.message, validated.issues);
    }
    return null;
  }
  const meta = validated.data;
  const store = input.store ?? getExperienceStore();
  const asofDay = meta.asof.slice(0, 10);
  const symKey = meta.symbols
    .map((s) => s.toUpperCase())
    .sort()
    .join(",");

  const recent = await store.query({
    kind: "semantic",
    subKind: "market_snapshot",
    scope: "project",
    scopeId: input.projectId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 40,
  });
  const existing = recent.find((e) => {
    const m = e.metadataJson ?? {};
    const syms = Array.isArray(m["symbols"])
      ? (m["symbols"] as string[])
          .map((s) => String(s).toUpperCase())
          .sort()
          .join(",")
      : "";
    return syms === symKey && String(m["asof"] ?? "").slice(0, 10) === asofDay;
  });

  const summary =
    input.summary ??
    `[market] ${meta.symbols.slice(0, 6).join(",")} asof=${asofDay} — ${meta.indicatorsBrief.slice(0, 120)}`;
  const tags = [
    ...meta.symbols.slice(0, 12).map((s) => `symbol:${s.toUpperCase()}`),
    `tier:${meta.memoryTier}`,
    "subKind:market_snapshot",
  ];
  const contentJson = { summary, brief: meta.indicatorsBrief };

  if (existing) {
    return store.update(existing.id, {
      contentJson,
      tagsJson: tags,
      metadataJson: { ...meta },
    });
  }

  return store.insert({
    kind: "semantic",
    subKind: "market_snapshot",
    scope: "project",
    scopeId: input.projectId,
    visibility: "project_shared",
    contentJson,
    tagsJson: tags,
    validFrom: new Date().toISOString(),
    sourceRunId: input.sourceRunId ?? null,
    qualityScore: 0.4,
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
