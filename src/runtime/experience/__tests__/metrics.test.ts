/**
 * Memory metrics 单测 — Memory V2 P1.5
 *
 * 覆盖：
 *   - InMemoryMetricsCollector：inc / snapshot / reset
 *   - attachMemoryMetrics：4 类事件正确翻译成计数
 *     - experience_recalled → memory.recall.hits.*
 *     - experience_executed → memory.execute.*
 *     - maintenance_run(kind=janitor) → memory.janitor.*
 *     - maintenance_run(kind=reflector_daily) → memory.reflector.runs.*
 *   - detach() 后再 emit 不再计数
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import {
  InMemoryMetricsCollector,
  attachMemoryMetrics,
  getMemoryMetricsSnapshot,
  resetMemoryMetricsForTesting,
  setMemoryMetricsCollectorForTesting,
} from "../metrics";

let bus: ReturnType<typeof getExperienceBus>;
let metrics: ReturnType<typeof attachMemoryMetrics>;

beforeEach(() => {
  setExperienceBusForTesting(null);
  bus = getExperienceBus();
  setMemoryMetricsCollectorForTesting(new InMemoryMetricsCollector());
  metrics = attachMemoryMetrics(bus);
});

afterEach(() => {
  metrics.detach();
  bus.clearAllForTesting();
  setExperienceBusForTesting(null);
  resetMemoryMetricsForTesting();
});

describe("InMemoryMetricsCollector — 基础语义", () => {
  test("inc + snapshot 累计计数；同 name 多次 inc 累加", () => {
    const c = new InMemoryMetricsCollector();
    c.inc("foo");
    c.inc("foo", 3);
    c.inc("bar", 1, { color: "red" });
    c.inc("bar", 2, { color: "red" });
    c.inc("bar", 1, { color: "blue" });
    const snap = c.snapshot();
    expect(snap.foo).toBe(4);
    expect(snap["bar|color=red"]).toBe(3);
    expect(snap["bar|color=blue"]).toBe(1);
  });

  test("reset 清空", () => {
    const c = new InMemoryMetricsCollector();
    c.inc("x", 5);
    c.reset();
    expect(c.snapshot()).toEqual({});
  });
});

describe("attachMemoryMetrics — Bus 事件 → 指标", () => {
  test("experience_recalled → recall.hits 累计 + rank/bucket tag", () => {
    bus.emit({
      type: "experience_recalled",
      experienceId: "e1",
      workflowRunId: "wf",
      agentStepId: null,
      rank: 0,
      score: 0.82,
    });
    bus.emit({
      type: "experience_recalled",
      experienceId: "e2",
      workflowRunId: "wf",
      agentStepId: null,
      rank: 1,
      score: 0.55,
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["memory.recall.hits.total"]).toBe(2);
    expect(snap["memory.recall.hits.by_rank|rank=0"]).toBe(1);
    expect(snap["memory.recall.hits.by_rank|rank=1"]).toBe(1);
    expect(snap["memory.recall.hits.by_score_bucket|bucket=8"]).toBe(1);
    expect(snap["memory.recall.hits.by_score_bucket|bucket=5"]).toBe(1);
  });

  test("experience_executed → execute.* + outcome tag", () => {
    bus.emit({
      type: "experience_executed",
      experienceId: "e1",
      workflowRunId: "wf",
      outcome: "success",
    });
    bus.emit({
      type: "experience_executed",
      experienceId: "e2",
      workflowRunId: "wf",
      outcome: "fail",
    });
    bus.emit({
      type: "experience_executed",
      experienceId: "e3",
      workflowRunId: "wf",
      outcome: "fail",
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["memory.execute.total"]).toBe(3);
    expect(snap["memory.execute.by_outcome|outcome=success"]).toBe(1);
    expect(snap["memory.execute.by_outcome|outcome=fail"]).toBe(2);
  });

  test("maintenance_run(kind=janitor) → janitor.* 汇总", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "janitor",
      actor: "janitor",
      summary: { scanned: 10, qualityUpdated: 3, decayMarked: 1, archived: 2 },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "janitor",
      actor: "janitor",
      summary: { scanned: 5, qualityUpdated: 0, decayMarked: 0, archived: 1 },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["memory.janitor.tick.total"]).toBe(2);
    expect(snap["memory.janitor.scanned"]).toBe(15);
    expect(snap["memory.janitor.archived"]).toBe(3);
    expect(snap["memory.janitor.decay_marked"]).toBe(1);
    expect(snap["memory.janitor.quality_updated"]).toBe(3);
  });

  test("maintenance_run(kind=reflector_daily) → reflector.runs.by_status", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "reflector_daily",
      actor: "reflector",
      summary: { status: "completed", producedCount: 2 },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "reflector_daily",
      actor: "reflector",
      summary: { status: "skipped_dedup", producedCount: 0 },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "reflector_daily",
      actor: "reflector",
      summary: { status: "completed", producedCount: 1 },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["memory.reflector.runs.total"]).toBe(3);
    expect(snap["memory.reflector.runs.by_status|status=completed"]).toBe(2);
    expect(snap["memory.reflector.runs.by_status|status=skipped_dedup"]).toBe(1);
  });

  test("kind=skill_curator 不参与指标（避免污染）", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "skill_curator",
      actor: "curator",
      summary: { whatever: 1 },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(Object.keys(snap).length).toBe(0);
  });

  test("maintenance_run(kind=embedder) → embedder.* 汇总", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "embedder",
      actor: "embedder",
      summary: { scanned: 100, picked: 20, succeeded: 18, failed: 2, tokensUsed: 1500 },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "embedder",
      actor: "embedder",
      summary: { scanned: 80, picked: 0, succeeded: 0, failed: 0, tokensUsed: 0 },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["memory.embedder.tick.total"]).toBe(2);
    expect(snap["memory.embedder.scanned"]).toBe(180);
    expect(snap["memory.embedder.picked"]).toBe(20);
    expect(snap["memory.embedder.succeeded"]).toBe(18);
    expect(snap["memory.embedder.failed"]).toBe(2);
    expect(snap["memory.embedder.tokens"]).toBe(1500);
  });

  // ───────────────────────── P4b 三组指标 ─────────────────────────

  test("maintenance_run(kind=pnl_attributor) → self_evolve.pnl_attributor.* 汇总", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "pnl_attributor",
      actor: "pnl_attributor",
      summary: {
        runtimesScanned: 5,
        runtimesProcessed: 3,
        runtimesSkipped: 2,
        fillsScanned: 100,
        snapshotsWritten: 15,
        errors: 1,
        skillAttributionRows: 3,
        skillRunsUpdated: 7,
      },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "pnl_attributor",
      actor: "pnl_attributor",
      summary: {
        runtimesScanned: 5,
        runtimesProcessed: 5,
        runtimesSkipped: 0,
        fillsScanned: 50,
        snapshotsWritten: 10,
        errors: 0,
        skillAttributionRows: 5,
        skillRunsUpdated: 10,
      },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["self_evolve.pnl_attributor.tick.total"]).toBe(2);
    expect(snap["self_evolve.pnl_attributor.runtimes_scanned"]).toBe(10);
    expect(snap["self_evolve.pnl_attributor.runtimes_processed"]).toBe(8);
    expect(snap["self_evolve.pnl_attributor.runtimes_skipped"]).toBe(2);
    expect(snap["self_evolve.pnl_attributor.fills_scanned"]).toBe(150);
    expect(snap["self_evolve.pnl_attributor.snapshots_written"]).toBe(25);
    expect(snap["self_evolve.pnl_attributor.errors"]).toBe(1);
    expect(snap["self_evolve.pnl_attributor.skill_attribution_rows"]).toBe(8);
    expect(snap["self_evolve.pnl_attributor.skill_runs_updated"]).toBe(17);
  });

  test("maintenance_run(kind=analyst_accuracy) → self_evolve.analyst_accuracy.* 汇总", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "analyst_accuracy",
      actor: "analyst_accuracy_writer",
      summary: {
        scannedSignals: 30,
        placeholdersInserted: 10,
        evaluated: 8,
        skippedNoMark: 1,
        skippedNoFutureMark: 1,
        failures: 0,
      },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["self_evolve.analyst_accuracy.tick.total"]).toBe(1);
    expect(snap["self_evolve.analyst_accuracy.scanned_signals"]).toBe(30);
    expect(snap["self_evolve.analyst_accuracy.placeholders_inserted"]).toBe(10);
    expect(snap["self_evolve.analyst_accuracy.evaluated"]).toBe(8);
    expect(snap["self_evolve.analyst_accuracy.skipped_no_mark"]).toBe(1);
    expect(snap["self_evolve.analyst_accuracy.skipped_no_future_mark"]).toBe(1);
    expect(snap["self_evolve.analyst_accuracy.failures"]).toBe(0);
  });

  test("maintenance_run(kind=mark_price_fetcher) → self_evolve.mark_price.* 汇总", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "mark_price_fetcher",
      actor: "mark_price_fetcher",
      summary: {
        targets: 20,
        inserted: 18,
        updated: 1,
        skipped: 1,
        failures: 0,
      },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "mark_price_fetcher",
      actor: "mark_price_fetcher",
      summary: { targets: 10, inserted: 5, updated: 5, skipped: 0, failures: 0 },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["self_evolve.mark_price.tick.total"]).toBe(2);
    expect(snap["self_evolve.mark_price.targets"]).toBe(30);
    expect(snap["self_evolve.mark_price.inserted"]).toBe(23);
    expect(snap["self_evolve.mark_price.updated"]).toBe(6);
    expect(snap["self_evolve.mark_price.skipped"]).toBe(1);
    expect(snap["self_evolve.mark_price.failures"]).toBe(0);
  });

  test("maintenance_run(kind=skill_promoter) → self_evolve.skill_promoter.* 汇总", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "skill_promoter",
      actor: "skill_promoter",
      summary: {
        scanned: 5,
        qualified: 2,
        promoted: 2,
        skippedDuplicate: 1,
        skippedInsufficient: 1,
        mode: "live",
        status: "completed",
      },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "skill_promoter",
      actor: "skill_promoter",
      summary: {
        scanned: 3,
        qualified: 0,
        promoted: 0,
        skippedDuplicate: 1,
        skippedInsufficient: 2,
        mode: "dry_run",
        status: "completed",
      },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["self_evolve.skill_promoter.tick.total"]).toBe(2);
    expect(snap["self_evolve.skill_promoter.scanned"]).toBe(8);
    expect(snap["self_evolve.skill_promoter.qualified"]).toBe(2);
    expect(snap["self_evolve.skill_promoter.promoted"]).toBe(2);
    expect(snap["self_evolve.skill_promoter.skipped_duplicate"]).toBe(2);
    expect(snap["self_evolve.skill_promoter.skipped_insufficient"]).toBe(3);
    expect(snap["self_evolve.skill_promoter.tick.by_mode|mode=live"]).toBe(1);
    expect(snap["self_evolve.skill_promoter.tick.by_mode|mode=dry_run"]).toBe(1);
    expect(snap["self_evolve.skill_promoter.tick.by_status|status=completed"]).toBe(2);
  });

  test("maintenance_run(kind=skill_evolver) → self_evolve.skill_evolver.* 汇总（P6）", () => {
    bus.emit({
      type: "maintenance_run",
      kind: "skill_evolver",
      actor: "skill_evolver_watcher",
      summary: {
        scanned: 5,
        processed: 2,
        skippedBaseMissing: 1,
        skippedBaseArchived: 1,
        failed: 1,
        elapsedMs: 123,
      },
    });
    bus.emit({
      type: "maintenance_run",
      kind: "skill_evolver",
      actor: "skill_evolver_watcher",
      summary: {
        scanned: 3,
        processed: 3,
        skippedBaseMissing: 0,
        skippedBaseArchived: 0,
        failed: 0,
        elapsedMs: 88,
      },
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["self_evolve.skill_evolver.tick.total"]).toBe(2);
    expect(snap["self_evolve.skill_evolver.scanned"]).toBe(8);
    expect(snap["self_evolve.skill_evolver.processed"]).toBe(5);
    expect(snap["self_evolve.skill_evolver.skipped_base_missing"]).toBe(1);
    expect(snap["self_evolve.skill_evolver.skipped_base_archived"]).toBe(1);
    expect(snap["self_evolve.skill_evolver.failed"]).toBe(1);
  });

  test("detach() 后停止计数", () => {
    metrics.detach();
    bus.emit({
      type: "experience_recalled",
      experienceId: "x",
      workflowRunId: "wf",
      agentStepId: null,
      rank: 0,
      score: 0.5,
    });
    const snap = getMemoryMetricsSnapshot();
    expect(snap["memory.recall.hits.total"]).toBeUndefined();
  });
});
