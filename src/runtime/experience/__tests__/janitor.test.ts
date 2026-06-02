/**
 * Janitor Pipe 单测 — Memory V2 P1
 *
 * 覆盖：
 *   - qualityScore 重算公式（base / recency / hitlBoost / conflictPenalty）
 *   - pinned 永不衰减
 *   - 新经验（< 14d）不会被标 decay
 *   - quality < 0.2 且 valid_from > 14d → mark_decay
 *   - decay_at 到期 + 7d 后 → archive
 *   - runJanitorOnce 写 op_log + emit maintenance_run
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Experience } from "../../../types/entities";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import { InMemoryExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import { computeQualityScore, evaluateDecay, runJanitorOnce } from "../pipes/janitor";

function fakeExp(over: Partial<Experience> = {}): Experience {
  return {
    id: over.id ?? "exp",
    kind: "semantic",
    subKind: "",
    scope: "project",
    scopeId: "p",
    definitionId: null,
    visibility: "project_shared",
    contentJson: { summary: "" },
    tagsJson: [],
    qualityScore: 0.5,
    useCount: 0,
    successCount: 0,
    failCount: 0,
    decayAt: null,
    validFrom: "2026-06-02T00:00:00.000Z",
    validTo: null,
    parentId: null,
    sourceRunId: null,
    embeddingRef: null,
    pinned: false,
    metadataJson: {},
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...over,
  };
}

describe("Janitor — computeQualityScore 公式", () => {
  const now = new Date("2026-06-02T00:00:00.000Z");

  test("全新 + 无使用 → 仅 recency + 0.2 基础", () => {
    const s = computeQualityScore(fakeExp({}), now);
    // base=0/5=0; recency=exp(0)=1; raw = 0*0.5 + 1*0.3 + 0.2 = 0.5
    expect(s).toBeCloseTo(0.5, 5);
  });

  test("高成功率项目分数高", () => {
    const s = computeQualityScore(fakeExp({ useCount: 20, successCount: 18 }), now);
    // base=18/20=0.9; recency=1; raw=0.9*0.5+0.3+0.2=0.95
    expect(s).toBeCloseTo(0.95, 5);
  });

  test("旧经验 recency 衰减", () => {
    const old = "2026-04-03T00:00:00.000Z"; // 60d 前
    const s = computeQualityScore(fakeExp({ validFrom: old }), now);
    // recency ≈ exp(-2) ≈ 0.135；raw = 0 + 0.135*0.3 + 0.2 = 0.2406
    expect(s).toBeGreaterThan(0.2);
    expect(s).toBeLessThan(0.3);
  });

  test("hitlBoost / conflictPenalty 生效", () => {
    const s = computeQualityScore(
      fakeExp({
        metadataJson: { hitlBoost: 0.15, conflictPenalty: 0.1 },
      }),
      now
    );
    // raw = 0+0.3+0.2 + 0.15 - 0.1 = 0.55
    expect(s).toBeCloseTo(0.55, 5);
  });

  test("clamp 到 [0, 1]", () => {
    const high = computeQualityScore(
      fakeExp({
        useCount: 100,
        successCount: 100,
        metadataJson: { hitlBoost: 10 },
      }),
      now
    );
    expect(high).toBe(1);
    const low = computeQualityScore(
      fakeExp({
        metadataJson: { conflictPenalty: 999 },
      }),
      now
    );
    expect(low).toBe(0);
  });
});

describe("Janitor — evaluateDecay 判定", () => {
  const now = new Date("2026-06-30T00:00:00.000Z");

  test("pinned → noop", () => {
    expect(evaluateDecay(fakeExp({ pinned: true, qualityScore: 0.01 }), now)).toBe("noop");
  });

  test("新经验（<14d）即使低分也 noop", () => {
    const recent = "2026-06-25T00:00:00.000Z"; // 5d 前
    expect(evaluateDecay(fakeExp({ qualityScore: 0.1, validFrom: recent }), now)).toBe("noop");
  });

  test("旧经验 + 低分 → mark_decay", () => {
    expect(
      evaluateDecay(fakeExp({ qualityScore: 0.1, validFrom: "2026-06-01T00:00:00.000Z" }), now)
    ).toBe("mark_decay");
  });

  test("已 decay_at 但未到归档时机 → noop", () => {
    const decay = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    expect(evaluateDecay(fakeExp({ decayAt: decay }), now)).toBe("noop");
  });

  test("decay_at + 7d 已过 → archive", () => {
    const decay = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    expect(evaluateDecay(fakeExp({ decayAt: decay }), now)).toBe("archive");
  });
});

describe("Janitor — runJanitorOnce 整合", () => {
  let store: InMemoryExperienceStore;
  let bus: ReturnType<typeof getExperienceBus>;
  const now = new Date("2026-06-30T00:00:00.000Z");

  beforeEach(() => {
    store = new InMemoryExperienceStore();
    setExperienceStoreForTesting(store);
    setExperienceBusForTesting(null);
    bus = getExperienceBus();
  });

  afterEach(() => {
    bus.clearAllForTesting();
    setExperienceStoreForTesting(null);
    setExperienceBusForTesting(null);
  });

  test("混合场景：一条高质量 + 一条该 decay + 一条 pinned", async () => {
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "high quality" },
      validFrom: "2026-06-20T00:00:00.000Z",
      qualityScore: 0.9,
    });
    const oldLow = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "low and old" },
      validFrom: "2026-05-01T00:00:00.000Z",
      qualityScore: 0.5,
      // 60 天前 + conflictPenalty 让重算 quality 跌破 0.2
      metadataJson: { conflictPenalty: 0.15 },
    });
    await store.insert({
      kind: "identity",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "persona" },
      validFrom: "2026-01-01T00:00:00.000Z",
      pinned: true,
      qualityScore: 0.5,
    });

    const summary = await runJanitorOnce({ store, bus, now: () => now });
    expect(summary.scanned).toBe(3);
    expect(summary.decayMarked).toBeGreaterThanOrEqual(1);

    // oldLow 应被标 decay_at
    const after = await store.findById(oldLow.id);
    expect(after?.decayAt).not.toBeNull();
    const decayMs = after?.decayAt ? new Date(after.decayAt).getTime() : 0;
    expect(decayMs).toBeGreaterThan(now.getTime());

    // pinned 那条无 decay
    const pinned = await store.query({ pinnedOnly: true });
    expect(pinned[0]?.decayAt).toBeNull();

    // op_log 含 decay
    const ops = await store.listOps(oldLow.id);
    expect(ops.some((o) => o.op === "decay")).toBe(true);
  });

  test("已 decay 到期 → 归档 + 写 archive op_log + maintenance_run", async () => {
    const expiredDecay = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    const exp = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "to archive" },
      validFrom: "2026-04-01T00:00:00.000Z",
      decayAt: expiredDecay,
    });
    let maintenanceEvents = 0;
    bus.subscribe("maintenance_run", () => {
      maintenanceEvents += 1;
    });

    const summary = await runJanitorOnce({ store, bus, now: () => now });
    expect(summary.archived).toBe(1);

    const after = await store.findById(exp.id);
    expect(after?.validTo).toBeTruthy();
    const ops = await store.listOps(exp.id);
    expect(ops.some((o) => o.op === "archive")).toBe(true);

    expect(maintenanceEvents).toBe(1);
  });
});
