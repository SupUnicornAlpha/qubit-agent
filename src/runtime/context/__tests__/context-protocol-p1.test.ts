/**
 * Context Protocol P1 单测
 */

import { describe, expect, test } from "bun:test";
import { InMemoryExperienceStore } from "../../experience/experience-store";
import { evaluateDecay } from "../../experience/pipes/janitor";
import { parseSlotContextParam, renderSlotContextForPrompt } from "../handoff";
import {
  applyToolResultToWorkingMemory,
  createEmptyWorkingMemory,
  extractFinanceRefsFromPayload,
  renderWorkingMemoryForPrompt,
} from "../working-memory";
import { promoteStrategyRecipes } from "../promote-strategy-recipe";

describe("WorkingMemory", () => {
  test("工具成功写入 trailStub + financeRefs", () => {
    const wm = applyToolResultToWorkingMemory(createEmptyWorkingMemory(), {
      step: 2,
      tool: "factor.evaluate",
      ok: true,
      result: {
        builtinResult: { factorId: "f-1", evaluationId: "e-1", symbols: ["600519"] },
      },
    });
    expect(wm.trailStub).toHaveLength(1);
    expect(wm.trailStub[0]?.ok).toBe(true);
    expect(wm.financeRefs.factorIds).toContain("f-1");
    expect(wm.financeRefs.evaluationIds).toContain("e-1");
    expect(wm.financeRefs.symbols).toContain("600519");
    expect(renderWorkingMemoryForPrompt(wm)).toContain("WorkingMemory");
  });

  test("工具失败追加 openQuestions", () => {
    const wm = applyToolResultToWorkingMemory(null, {
      step: 1,
      tool: "fetch_klines",
      ok: false,
      errorMessage: "timeout",
    });
    expect(wm.openQuestions.some((q) => q.includes("fetch_klines"))).toBe(true);
  });

  test("extractFinanceRefsFromPayload 深挖", () => {
    const refs = extractFinanceRefsFromPayload({
      data: { compositionId: "c-9", nested: { factor_id: "fx" } },
    });
    expect(refs.compositionIds).toContain("c-9");
    expect(refs.factorIds).toContain("fx");
  });
});

describe("Handoff V1", () => {
  test("纯字符串计 unstructured，结构化优先渲染", () => {
    const a = parseSlotContextParam("only prose context");
    expect(a.unstructured).toBe(true);
    const b = parseSlotContextParam({
      version: 1,
      goal: "analyze",
      symbols: ["AAPL"],
      asof: "2026-07-01",
      narrative: "details",
    });
    expect(b.unstructured).toBe(false);
    const md = renderSlotContextForPrompt(b.handoff);
    expect(md).toContain("symbols: AAPL");
    expect(md).toContain("asof: 2026-07-01");
  });
});

describe("Janitor MemoryTier", () => {
  test("shallow 过 TTL 触发 mark_decay", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");
    const decision = evaluateDecay(
      {
        id: "1",
        kind: "semantic",
        subKind: "market_snapshot",
        scope: "project",
        scopeId: "p",
        definitionId: null,
        visibility: "project_shared",
        contentJson: { summary: "snap" },
        tagsJson: ["tier:shallow"],
        qualityScore: 0.9,
        useCount: 0,
        successCount: 0,
        failCount: 0,
        decayAt: null,
        validFrom: "2026-07-01T00:00:00.000Z",
        validTo: null,
        parentId: null,
        sourceRunId: null,
        embeddingRef: null,
        pinned: false,
        metadataJson: { memoryTier: "shallow", decayHours: 24 },
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      now
    );
    expect(decision).toBe("mark_decay");
  });

  test("deep 高 quality 不轻易衰减", () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    const decision = evaluateDecay(
      {
        id: "2",
        kind: "semantic",
        subKind: "factor_archive",
        scope: "project",
        scopeId: "p",
        definitionId: null,
        visibility: "project_shared",
        contentJson: { summary: "f" },
        tagsJson: ["tier:deep"],
        qualityScore: 0.8,
        useCount: 3,
        successCount: 2,
        failCount: 0,
        decayAt: null,
        validFrom: "2026-06-01T00:00:00.000Z",
        validTo: null,
        parentId: null,
        sourceRunId: null,
        embeddingRef: null,
        pinned: false,
        metadataJson: { memoryTier: "deep", factorId: "f" },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
      now
    );
    expect(decision).toBe("noop");
  });
});

describe("promoteStrategyRecipes", () => {
  test("缺 compositionId / 低质量跳过；达标 dry_run 计数", async () => {
    const store = new InMemoryExperienceStore();
    await store.insert({
      kind: "procedural",
      subKind: "strategy_recipe",
      scope: "project",
      scopeId: "proj-x",
      contentJson: { summary: "no id" },
      validFrom: "2026-07-01T00:00:00.000Z",
      metadataJson: {},
      qualityScore: 0.9,
    });
    await store.insert({
      kind: "procedural",
      subKind: "strategy_recipe",
      scope: "project",
      scopeId: "proj-x",
      contentJson: { summary: "good recipe", body: "steps" },
      validFrom: "2026-07-01T00:00:00.000Z",
      metadataJson: { compositionId: "comp-1" },
      qualityScore: 0.8,
      // useCount set via update
    });
    const rows = await store.query({ subKind: "strategy_recipe", scopeId: "proj-x" });
    const good = rows.find((r) => r.metadataJson["compositionId"] === "comp-1");
    if (good) await store.update(good.id, { useCount: 2 });

    const result = await promoteStrategyRecipes({
      projectId: "proj-x",
      mode: "dry_run",
      store,
      minUseCount: 1,
      minQuality: 0.55,
      existingCompositionIds: new Set(),
    });
    expect(result.scanned).toBe(2);
    expect(result.promoted).toBe(1);
    expect(result.skippedLowQuality).toBeGreaterThanOrEqual(1);
  });
});
