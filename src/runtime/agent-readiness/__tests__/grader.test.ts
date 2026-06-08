/**
 * grader 纯函数：输入 metric snapshot → 输出每指标 grade + 整体 A-F。
 *
 * 这里不接触 DB，只验证打分逻辑，方便快速迭代阈值。
 */
import { describe, expect, test } from "bun:test";
import { gradeSnapshot, type ReadinessSnapshot } from "../grader";

function baseSnapshot(overrides: Partial<ReadinessSnapshot["metrics"]> = {}): ReadinessSnapshot {
  return {
    workflowRunId: "wf-test",
    scenario: "research",
    capturedAt: "2026-06-05T00:00:00.000Z",
    workflowStatus: "completed",
    metrics: {
      "O-1": 1.0,
      "T-1": 0.0,
      "T-3": 0.0,
      "T-6": 50_000,
      "S-1": 0.5,
      "M-1": 1,
      ...overrides,
    },
  };
}

describe("gradeSnapshot", () => {
  test("全绿 → A", () => {
    const r = gradeSnapshot(baseSnapshot());
    expect(r.overall).toBe("A");
    expect(r.metricGrades["O-1"]).toBe("green");
    expect(r.metricGrades["T-1"]).toBe("green");
    expect(r.metricGrades["S-1"]).toBe("green");
    expect(r.metricGrades["M-1"]).toBe("green");
  });

  test("仅黄灯 → B", () => {
    // T-1 = 0.10 落在 yellow 区间（≤ 0.15）
    const r = gradeSnapshot(baseSnapshot({ "T-1": 0.1 }));
    expect(r.metricGrades["T-1"]).toBe("yellow");
    expect(r.overall).toBe("B");
  });

  test("1 个红灯 / 6 个指标 → C", () => {
    // O-1 = 0.4 → red
    const r = gradeSnapshot(baseSnapshot({ "O-1": 0.4 }));
    expect(r.metricGrades["O-1"]).toBe("red");
    expect(r.overall).toBe("C");
  });

  test("3 个红灯 / 6 个指标 → D（≤ 半数）", () => {
    const r = gradeSnapshot(
      baseSnapshot({
        "O-1": 0.4, // red
        "T-1": 0.5, // red
        "M-1": 0, // red
      })
    );
    expect(r.overall).toBe("D");
  });

  test("4 个红灯 / 6 个指标 → F（>半数）", () => {
    const r = gradeSnapshot(
      baseSnapshot({
        "O-1": 0.4,
        "T-1": 0.5,
        "T-3": 0.5,
        "M-1": 0,
      })
    );
    expect(r.overall).toBe("F");
  });

  test("缺失指标按 0 处理 → 触发对应红灯", () => {
    // M-1 缺失：0 写入次数 → red
    const r = gradeSnapshot(baseSnapshot({ "M-1": null }));
    expect(r.metricGrades["M-1"]).toBe("red");
  });

  test("结果包含简短 description 给人读 reporter 用", () => {
    const r = gradeSnapshot(baseSnapshot());
    expect(r.metricDescriptions["O-1"]).toMatch(/工作流/);
    expect(r.metricDescriptions["S-1"]).toMatch(/skill/i);
  });
});
