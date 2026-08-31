/**
 * Context Protocol P0 单测
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryExperienceStore } from "../../experience/experience-store";
import { assembleContextEnvelope, renderHandoffForPrompt } from "../assemble-context-prompt";
import { getContextMetricsSnapshot, resetContextMetricsForTesting } from "../context-metrics";
import {
  validateFactorArchiveMeta,
  validateResearchConclusionMeta,
} from "../finance-memory-schemas";
import { FinanceMemoryWriteError, upsertFactorArchiveExperience } from "../finance-memory-writer";
import { FinanceRecall, renderFinanceRecallBlockForPrompt } from "../finance-recall";

beforeEach(() => {
  resetContextMetricsForTesting();
  process.env.CONTEXT_PROTOCOL_V1 = "1";
  process.env.FINANCE_MEMORY_STRICT = "1";
  process.env.CONTEXT_AXIOM_PIT = "1";
});

afterEach(() => {
  resetContextMetricsForTesting();
  delete process.env.CONTEXT_PROTOCOL_V1;
  delete process.env.FINANCE_MEMORY_STRICT;
  delete process.env.CONTEXT_AXIOM_PIT;
});

describe("FinanceMemory schemas", () => {
  test("factor_archive 缺 factorId / asof 拒写", () => {
    const bad = validateFactorArchiveMeta({
      name: "mom",
      category: "momentum",
      universe: "CN-A",
      horizon: "5",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorCode).toBe("finance_memory_schema_invalid");
  });

  test("research_conclusion 强制 confidence + symbols", () => {
    const bad = validateResearchConclusionMeta({
      symbols: ["AAPL"],
      stance: "bull",
      asof: "2026-07-01",
      thesis: "up",
    });
    expect(bad.ok).toBe(false);

    const ok = validateResearchConclusionMeta({
      symbols: ["AAPL"],
      stance: "bull",
      confidence: 0.7,
      asof: "2026-07-01",
      thesis: "momentum continuation",
    });
    expect(ok.ok).toBe(true);
  });
});

describe("Strategy recipe reflection recall", () => {
  test("未经验证的 recipe 不得以深层记忆或成功结果提升权重", async () => {
    const store = new InMemoryExperienceStore();
    const validFrom = "2026-07-01T00:00:00.000Z";
    const recipeBase = {
      kind: "procedural" as const,
      subKind: "strategy_recipe",
      scope: "project" as const,
      scopeId: "p1",
      contentJson: { summary: "momentum recipe" },
      validFrom,
      qualityScore: 0.95,
      metadataJson: {
        compositionId: "composition-1",
        asof: "2026-07-01",
        memoryTier: "deep",
      },
    };
    const unverified = await store.insert(recipeBase);
    const verified = await store.insert({
      ...recipeBase,
      metadataJson: {
        ...recipeBase.metadataJson,
        compositionId: "composition-2",
        validationEvidence: {
          status: "validated" as const,
          strategyVersionId: "version-2",
          compositionId: "composition-2",
          backtestRunId: "backtest-2",
          datasetSnapshotId: "snapshot-2",
          comparisonCohortId: "cohort-2",
          finalHoldoutFingerprint: "holdout-2",
          verifiedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    });
    await store.update(unverified.id, { useCount: 10, successCount: 10 });
    await store.update(verified.id, { useCount: 10, successCount: 10 });

    const recall = new FinanceRecall({ store, now: () => new Date("2026-07-03T00:00:00.000Z") });
    const hits = await recall.recall({
      projectId: "p1",
      definitionId: null,
      query: "momentum recipe",
      topK: 5,
      silentEmit: true,
    });
    const raw = hits.find((hit) => hit.experience.id === unverified.id);
    const validated = hits.find((hit) => hit.experience.id === verified.id);
    expect(raw?.components.importance).toBeLessThanOrEqual(0.3);
    expect(raw?.components.outcomeWeight).toBeLessThanOrEqual(0.2);
    expect(validated?.components.importance).toBeGreaterThan(0.3);
    expect(validated?.components.outcomeWeight).toBeGreaterThan(0.2);
    expect(renderFinanceRecallBlockForPrompt(hits)).toContain("validation=unverified_hypothesis");
  });
});

describe("FinanceMemory writer", () => {
  test("upsert factor_archive 同 factorId+asof 日不重复", async () => {
    const store = new InMemoryExperienceStore();
    const meta = {
      factorId: "f-1",
      evaluationId: "e-1",
      name: "mom20",
      category: "momentum",
      universe: "CN-A",
      horizon: "5",
      ic: 0.05,
      rankIc: 0.08,
      asof: "2026-07-01",
      memoryTier: "deep" as const,
    };
    const a = await upsertFactorArchiveExperience({
      projectId: "p1",
      meta,
      store,
    });
    const b = await upsertFactorArchiveExperience({
      projectId: "p1",
      meta: { ...meta, evaluationId: "e-2", rankIc: 0.09 },
      store,
    });
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBe(a?.id);
    const rows = await store.query({
      kind: "semantic",
      subKind: "factor_archive",
      scopeId: "p1",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadataJson.rankIc).toBe(0.09);
  });

  test("strict 模式缺字段抛 FinanceMemoryWriteError", async () => {
    const store = new InMemoryExperienceStore();
    await expect(
      upsertFactorArchiveExperience({
        projectId: "p1",
        meta: { name: "x" } as never,
        store,
      })
    ).rejects.toBeInstanceOf(FinanceMemoryWriteError);
    const snap = getContextMetricsSnapshot();
    expect(snap["finance.memory_write_reject|subKind=factor_archive"] ?? 0).toBeGreaterThan(0);
  });
});

describe("FinanceRecall", () => {
  test("无 factorId 的 archive 不进高优池；cutoff 过滤未来 asof", async () => {
    const store = new InMemoryExperienceStore();
    await store.insert({
      kind: "semantic",
      subKind: "factor_archive",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "orphan momentum archive without id" },
      validFrom: "2026-06-01T00:00:00.000Z",
      tagsJson: ["factor:momentum"],
      metadataJson: { asof: "2026-06-01" },
      qualityScore: 0.9,
    });
    await store.insert({
      kind: "semantic",
      subKind: "factor_archive",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "good momentum factor on CN-A" },
      validFrom: "2026-06-01T00:00:00.000Z",
      tagsJson: ["factor:momentum", "symbol:600519"],
      metadataJson: {
        factorId: "f-ok",
        name: "mom",
        category: "momentum",
        universe: "CN-A",
        horizon: "5",
        asof: "2026-06-01",
        rankIc: 0.12,
        memoryTier: "deep",
      },
      qualityScore: 0.8,
    });
    await store.insert({
      kind: "semantic",
      subKind: "factor_archive",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "future leak factor" },
      validFrom: "2026-07-20T00:00:00.000Z",
      metadataJson: {
        factorId: "f-future",
        name: "leak",
        category: "momentum",
        universe: "CN-A",
        horizon: "5",
        asof: "2026-07-20",
        rankIc: 0.5,
        memoryTier: "deep",
      },
      qualityScore: 0.95,
    });

    const recall = new FinanceRecall({ store });
    const hits = await recall.recall({
      projectId: "p1",
      definitionId: null,
      query: "momentum CN-A factor",
      decisionCutoff: "2026-07-01",
      topK: 5,
      silentEmit: true,
    });

    expect(hits.every((h) => h.experience.metadataJson.factorId)).toBe(true);
    expect(hits.some((h) => h.experience.metadataJson.factorId === "f-future")).toBe(false);
    expect(hits.some((h) => h.experience.metadataJson.factorId === "f-ok")).toBe(true);

    const md = renderFinanceRecallBlockForPrompt(hits);
    expect(md).toContain("## Memory · Finance Recall");
    expect(md).toContain("factorId=f-ok");

    const snap = getContextMetricsSnapshot();
    expect(snap["finance.pit_filtered"] ?? 0).toBeGreaterThan(0);
  });
});

describe("assembleContextEnvelope", () => {
  test("按 USER 槽序拼装且裁剪超长槽", () => {
    const env = assembleContextEnvelope({
      workflowRunId: "wf-1",
      definitionId: "def-1",
      role: "analyst",
      slots: {
        goal: "GOAL_TEXT",
        recall_finance: `FINANCE_${"x".repeat(10_000)}`,
        recall_general: "GENERAL",
        session: "SESSION",
      },
    });
    expect(env.rendered?.user).toContain("GOAL_TEXT");
    expect(env.rendered?.user.indexOf("FINANCE_")).toBeLessThan(
      env.rendered?.user.indexOf("GENERAL") ?? 0
    );
    expect((env.slots.recall_finance?.text.length ?? 0) <= 4_000).toBe(true);
  });

  test("softOmit 优先丢掉 general/session 保留 finance+goal", () => {
    process.env.QUBIT_SOFT_USER_PROMPT_CHARS = "500";
    const env = assembleContextEnvelope({
      workflowRunId: "wf-1",
      definitionId: "def-1",
      role: "analyst",
      softOmitLowPriority: true,
      slots: {
        goal: "G".repeat(100),
        recall_finance: "F".repeat(100),
        recall_general: "N".repeat(400),
        session: "S".repeat(400),
      },
    });
    expect(env.slots.goal).toBeTruthy();
    expect(env.slots.recall_finance).toBeTruthy();
    expect(env.slots.recall_general || env.slots.session).toBeFalsy();
    delete process.env.QUBIT_SOFT_USER_PROMPT_CHARS;
  });

  test("handoff 无结构字段计 unstructured", () => {
    renderHandoffForPrompt({ narrative: "only prose" });
    const snap = getContextMetricsSnapshot();
    expect(snap["handoff.unstructured"] ?? 0).toBeGreaterThan(0);
  });
});
