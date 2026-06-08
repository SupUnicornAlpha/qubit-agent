import { describe, expect, test } from "bun:test";
import { renderDiffMarkdown, type DiffSnapshotPair } from "../diff-reporter";
import type { ReadinessSnapshot } from "../grader";

function makeSnap(metrics: Record<string, number | null>, tag: string): {
  schemaVersion: string;
  snapshot: ReadinessSnapshot;
} {
  const snap: ReadinessSnapshot = {
    workflowRunId: `wf-${tag}`,
    scenario: "research",
    capturedAt: "2026-06-05T00:00:00.000Z",
    workflowStatus: "completed",
    metrics,
  };
  return { schemaVersion: "1.0", snapshot: snap };
}

describe("renderDiffMarkdown", () => {
  test("两份完全一样：表头 + 全部相同", () => {
    const a = makeSnap({ "O-1": 1, "T-1": 0, "T-3": 0, "T-6": 100, "S-1": 0.5, "M-1": 1 }, "a");
    const b = makeSnap({ "O-1": 1, "T-1": 0, "T-3": 0, "T-6": 100, "S-1": 0.5, "M-1": 1 }, "b");
    const md = renderDiffMarkdown({ base: a, target: b });
    expect(md).toContain("Diff Report");
    expect(md).toContain("wf-a");
    expect(md).toContain("wf-b");
    // 全部一致 → 出现"无变化"小节
    expect(md).toMatch(/\u65e0\u53d8\u5316|no changes/i);
  });

  test("有指标变好：变化方向标注 ↑", () => {
    const a = makeSnap({ "O-1": 0, "T-1": 0.3, "T-3": 0, "T-6": 100, "S-1": 0.1, "M-1": 0 }, "a");
    const b = makeSnap({ "O-1": 1, "T-1": 0.0, "T-3": 0, "T-6": 100, "S-1": 0.5, "M-1": 1 }, "b");
    const md = renderDiffMarkdown({ base: a, target: b });
    expect(md).toContain("O-1");
    expect(md).toContain("T-1");
    // 至少有一个变化箭头
    expect(md).toMatch(/[↑↓]/);
  });

  test("整体等级变化也展示", () => {
    const a = makeSnap({ "O-1": 0, "T-1": 0.5, "T-3": 0.5, "T-6": 100, "S-1": 0.1, "M-1": 0 }, "a"); // F
    const b = makeSnap({ "O-1": 1, "T-1": 0.0, "T-3": 0, "T-6": 100, "S-1": 0.5, "M-1": 1 }, "b"); // A
    const md = renderDiffMarkdown({ base: a, target: b });
    expect(md).toMatch(/\bF\b.*->.*\bA\b|\bF\b.*→.*\bA\b/);
  });
});

// 类型对得上即可
const _typecheck: DiffSnapshotPair = {
  base: { schemaVersion: "1.0", snapshot: { workflowRunId: "x", scenario: "research", capturedAt: "", workflowStatus: "completed", metrics: {} } },
  target: { schemaVersion: "1.0", snapshot: { workflowRunId: "y", scenario: "research", capturedAt: "", workflowStatus: "completed", metrics: {} } },
};
void _typecheck;
