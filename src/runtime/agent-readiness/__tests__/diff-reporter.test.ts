import { describe, expect, test } from "bun:test";
import { renderDiffMarkdown, type DiffSnapshotPair } from "../diff-reporter";
import type { ReadinessSnapshot } from "../grader";

const ALL_GREEN_AQM = {
  "A-1": 1, "A-2": 0.8, "A-3": 4.0, "A-4": 1,
  "B-1": 1, "B-2": 1, "B-3": 0, "B-7": 1,
  "C-1": 1, "C-2": 0, "C-3-total": 50_000, "C-3-p95": 10_000, "C-5": 0,
  "D-1": 1, "D-2": 0.3, "D-3": 0.8,
};

const ALL_RED_AQM = {
  "A-1": 0, "A-2": 0, "A-3": 1.0, "A-4": 0,
  "B-1": 0, "B-2": 0.5, "B-3": 0.9, "B-7": 10,
  "C-1": 0.5, "C-2": 0.9, "C-3-total": 5_000_000, "C-3-p95": 100_000, "C-5": 0.5,
  "D-1": 0, "D-2": 1, "D-3": 0.1,
};

function makeSnap(metrics: Record<string, number | null>, tag: string): {
  schemaVersion: string;
  snapshot: ReadinessSnapshot;
} {
  return {
    schemaVersion: "2.0",
    snapshot: {
      workflowRunId: `wf-${tag}`,
      scenario: "research",
      capturedAt: "2026-06-08T00:00:00.000Z",
      workflowStatus: "completed",
      metrics,
    },
  };
}

describe("renderDiffMarkdown v2", () => {
  test("两份完全一样：表头 + 全部相同（出现 '无变化'）", () => {
    const a = makeSnap(ALL_GREEN_AQM, "a");
    const b = makeSnap(ALL_GREEN_AQM, "b");
    const md = renderDiffMarkdown({ base: a, target: b });
    expect(md).toContain("Diff Report");
    expect(md).toContain("wf-a");
    expect(md).toContain("wf-b");
    expect(md).toMatch(/无变化|no changes/i);
  });

  test("有指标变好：变化方向标注 ↑↓", () => {
    const a = makeSnap({ ...ALL_GREEN_AQM, "B-3": 0.9 /* red */ }, "a");
    const b = makeSnap({ ...ALL_GREEN_AQM, "B-3": 0.0 /* green */ }, "b");
    const md = renderDiffMarkdown({ base: a, target: b });
    expect(md).toContain("B-3");
    expect(md).toMatch(/[↑↓]/);
  });

  test("整体等级变化也展示（F → A）", () => {
    const a = makeSnap(ALL_RED_AQM, "a");
    const b = makeSnap(ALL_GREEN_AQM, "b");
    const md = renderDiffMarkdown({ base: a, target: b });
    expect(md).toMatch(/\bF\b.*->.*\bA\b|\bF\b.*→.*\bA\b/);
  });
});

const _typecheck: DiffSnapshotPair = {
  base: { schemaVersion: "2.0", snapshot: { workflowRunId: "x", scenario: "research", capturedAt: "", workflowStatus: "completed", metrics: {} } },
  target: { schemaVersion: "2.0", snapshot: { workflowRunId: "y", scenario: "research", capturedAt: "", workflowStatus: "completed", metrics: {} } },
};
void _typecheck;
