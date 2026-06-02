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
