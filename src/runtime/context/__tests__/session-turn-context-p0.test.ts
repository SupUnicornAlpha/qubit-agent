/**
 * Session/Turn + ClientEvent + Context 硬门禁 + P2 回归
 */

import { describe, expect, test } from "bun:test";
import { assembleContextEnvelope } from "../assemble-context-prompt";
import { brierContribution, applyDecisionOutcome } from "../decision-outcome";
import { InMemoryExperienceStore } from "../../experience/experience-store";
import {
  projectStepStreamToClientEvent,
  publishTurnStarted,
} from "../../conversation/client-event-bus";
import { resolveTurnMode } from "../../conversation/turn-mode";
import { registerTurnRunBinding, getTurnBindingByWorkflow } from "../../conversation/turn-binding";
import type { StepStreamEvent } from "../../react/state";

describe("resolveTurnMode", () => {
  test("显式 turnMode 优先", () => {
    expect(resolveTurnMode({ turnMode: "new_goal", reuseSessionWorkflow: true })).toBe("new_goal");
  });
  test("reuseSessionWorkflow=false → new_goal", () => {
    expect(resolveTurnMode({ reuseSessionWorkflow: false })).toBe("new_goal");
  });
  test("preserveGoal → continue_goal", () => {
    expect(resolveTurnMode({ preserveGoal: true })).toBe("continue_goal");
  });
  test("缺省 continue_goal", () => {
    expect(resolveTurnMode({})).toBe("continue_goal");
  });
});

describe("ClientEvent projection", () => {
  test("hitl_request → approval.requested", () => {
    const step: StepStreamEvent = {
      runId: "r1",
      workflowId: "wf1",
      traceId: "t1",
      role: "orchestrator",
      type: "hitl_request",
      stepIndex: 1,
      ts: 1,
      payload: { requestId: "hitl-1", title: "approve" },
    };
    const ev = projectStepStreamToClientEvent(step, {
      sessionId: "s1",
      turnId: "turn-1",
    });
    expect(ev?.type).toBe("approval.requested");
    expect(ev?.item?.id).toBe("hitl-1");
  });

  test("token → item.delta", () => {
    const step: StepStreamEvent = {
      runId: "r1",
      workflowId: "wf1",
      traceId: "t1",
      role: "orchestrator",
      type: "token",
      stepIndex: 0,
      ts: 1,
      payload: { token: "hi" },
    };
    const ev = projectStepStreamToClientEvent(step, { sessionId: "s1", turnId: "t1" });
    expect(ev?.type).toBe("item.delta");
  });

  test("turn binding registry", () => {
    registerTurnRunBinding({
      sessionId: "s",
      turnId: "t",
      workflowRunId: "wf-x",
      turnMode: "continue_goal",
    });
    expect(getTurnBindingByWorkflow("wf-x")?.turnId).toBe("t");
    publishTurnStarted({
      sessionId: "s",
      turnId: "t",
      runId: "wf-x",
      turnMode: "continue_goal",
    });
  });
});

describe("assemble hard omit", () => {
  test("超硬限时 omit 低优槽，保留 goal/slot/recall_finance", () => {
    const env = assembleContextEnvelope({
      workflowRunId: "wf",
      definitionId: "def",
      role: "orchestrator",
      sessionId: "sess",
      turnId: "turn",
      hardMaxUserChars: 80,
      slots: {
        goal: "GOAL_TEXT",
        slot: "SLOT_STRUCTURED",
        recall_finance: "FINANCE_RECALL",
        recall_general: "G".repeat(200),
        session: "S".repeat(200),
        control: "CTRL",
      },
    });
    expect(env.sessionId).toBe("sess");
    expect(env.turnId).toBe("turn");
    expect(env.slots.goal?.text).toContain("GOAL");
    expect(env.slots.slot?.text).toContain("SLOT");
    expect(env.slots.recall_finance?.text).toContain("FINANCE");
    expect(env.slots.recall_general).toBeUndefined();
  });
});

describe("DecisionRecord outcome P2", () => {
  test("brierContribution", () => {
    expect(brierContribution(0.8, "success")).toBeCloseTo(0.04);
    expect(brierContribution(0.8, "fail")).toBeCloseTo(0.64);
    expect(brierContribution(0.5, "partial")).toBeUndefined();
  });

  test("applyDecisionOutcome 写 metadata + successCount", async () => {
    const store = new InMemoryExperienceStore();
    const created = await store.insert({
      kind: "semantic",
      subKind: "research_conclusion",
      scope: "project",
      scopeId: "p1",
      contentJson: { thesis: "bull" },
      metadataJson: {
        decisionRecord: { confidence: 0.7, asof: "2026-07-01", symbols: ["AAPL"] },
      },
      tagsJson: [],
      validFrom: "2026-07-01T00:00:00.000Z",
    });
    const r = await applyDecisionOutcome({
      store,
      experienceId: created.id,
      outcome: {
        label: "success",
        scoredAt: "2026-07-30T00:00:00.000Z",
        brierContribution: brierContribution(0.7, "success"),
      },
    });
    expect(r.ok).toBe(true);
    const row = await store.findById(created.id);
    expect(row?.successCount).toBe(1);
    const dr = (row?.metadataJson as { decisionRecord?: { outcome?: { label: string } } })
      ?.decisionRecord;
    expect(dr?.outcome?.label).toBe("success");
  });

  test("computeOutcomeWeight 优先真实后验", async () => {
    const { computeOutcomeWeight } = await import("../finance-recall");
    const base = {
      id: "e1",
      kind: "semantic" as const,
      subKind: "research_conclusion",
      scope: "project" as const,
      scopeId: "p1",
      definitionId: null,
      visibility: "project_shared" as const,
      contentJson: {},
      tagsJson: [],
      validFrom: "2026-07-01T00:00:00.000Z",
      validTo: null,
      sourceRunId: null,
      qualityScore: 0.5,
      useCount: 10,
      successCount: 1,
      failCount: 0,
      supersedesId: null,
      archivedAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      metadataJson: {
        decisionRecord: {
          confidence: 0.9,
          outcome: { label: "success", brierContribution: 0.01 },
        },
      },
    };
    const wSuccess = computeOutcomeWeight(base, 0.1);
    expect(wSuccess).toBeGreaterThan(0.8);
    const wFail = computeOutcomeWeight(
      {
        ...base,
        metadataJson: {
          decisionRecord: {
            confidence: 0.9,
            outcome: { label: "fail", brierContribution: 0.81 },
          },
        },
      },
      0.9
    );
    expect(wFail).toBeLessThan(0.4);
  });

  test("applyRecommendationOutcomeToExperiences 按 symbol 写回", async () => {
    const { applyRecommendationOutcomeToExperiences } = await import("../decision-outcome");
    const store = new InMemoryExperienceStore();
    await store.insert({
      kind: "semantic",
      subKind: "research_conclusion",
      scope: "project",
      scopeId: "p1",
      contentJson: { thesis: "bull" },
      metadataJson: {
        symbols: ["AAPL"],
        workflowRunId: "wf1",
        decisionRecord: { confidence: 0.7, asof: "2026-07-01", symbols: ["AAPL"] },
      },
      tagsJson: ["symbol:AAPL"],
      validFrom: "2026-07-01T00:00:00.000Z",
      sourceRunId: "wf1",
    });
    const n = await applyRecommendationOutcomeToExperiences({
      store,
      projectId: "p1",
      workflowRunId: "wf1",
      symbol: "AAPL",
      confidence: 0.7,
      tradeOutcome: "win",
      returnPct: 5,
      scoredAt: "2026-07-30T00:00:00.000Z",
    });
    expect(n).toBe(1);
  });
});

describe("P2 finance writers + working fold", () => {
  test("strategy_eval / pnl_episode / market_snapshot(默认关)", async () => {
    const store = new InMemoryExperienceStore();
    const {
      upsertStrategyEvalExperience,
      upsertPnlEpisodeExperience,
      upsertMarketSnapshotExperience,
    } = await import("../finance-memory-writer");

    const evalExp = await upsertStrategyEvalExperience({
      store,
      projectId: "p1",
      meta: {
        backtestRunId: "bt1",
        compositionId: "c1",
        evalKind: "backtest",
        metrics: { sharpe: 1.2 },
        pass: true,
        qualityScore: 1,
        asof: "2026-07-01",
        memoryTier: "intermediate",
      },
    });
    expect(evalExp?.subKind).toBe("strategy_eval");

    const pnl = await upsertPnlEpisodeExperience({
      store,
      projectId: "p1",
      meta: {
        strategyRuntimeId: "rt1",
        tradingDay: "2026-07-01",
        symbol: "AAPL",
        realized: 12.5,
        asof: "2026-07-01",
        memoryTier: "intermediate",
      },
    });
    expect(pnl?.subKind).toBe("pnl_episode");

    const off = await upsertMarketSnapshotExperience({
      store,
      projectId: "p1",
      meta: {
        symbols: ["AAPL"],
        asof: "2026-07-01T00:00:00.000Z",
        indicatorsBrief: "RSI 55",
        dataSource: "test",
        decayHours: 48,
        memoryTier: "shallow",
      },
    });
    expect(off).toBeNull();

    const on = await upsertMarketSnapshotExperience({
      store,
      projectId: "p1",
      forceWrite: true,
      meta: {
        symbols: ["AAPL"],
        asof: "2026-07-01T00:00:00.000Z",
        indicatorsBrief: "RSI 55",
        dataSource: "test",
        decayHours: 48,
        memoryTier: "shallow",
      },
    });
    expect(on?.subKind).toBe("market_snapshot");
  });

  test("maybeFoldWorkingMemory 默认关；force 可折叠", async () => {
    const { maybeFoldWorkingMemory, createEmptyWorkingMemory } = await import(
      "../working-memory"
    );
    const wm = createEmptyWorkingMemory();
    wm.trailStub = Array.from({ length: 20 }, (_, i) => ({
      step: i,
      tool: "t",
      ok: true,
      oneLiner: "x".repeat(200),
    }));
    wm.hypotheses = Array.from({ length: 8 }, (_, i) => ({
      id: `h${i}`,
      text: "hyp ".repeat(40),
      status: "open" as const,
    }));
    const unchanged = maybeFoldWorkingMemory(wm);
    expect(unchanged.trailStub.length).toBe(20);
    const folded = maybeFoldWorkingMemory(wm, { force: true });
    expect(folded.trailStub.length).toBeLessThanOrEqual(6);
    expect(folded.hypotheses.length).toBeLessThanOrEqual(4);
  });
});

describe("memory.md identity-only contract", () => {
  test("IDENTITY_TYPES 仅 execution_profile（与 sync 实现一致）", async () => {
    // 回归：冷镜像不得包含 finance subKind；实现见 memory-workspace-sync.ts
    const src = await Bun.file(
      new URL("../../memory/memory-workspace-sync.ts", import.meta.url)
    ).text();
    expect(src).toContain('IDENTITY_TYPES = new Set(["execution_profile"])');
    expect(src).toContain("midterm 不再写入冷镜像");
    expect(src).not.toMatch(/factor_archive.*memory\.md/);
  });
});
