/**
 * grader 纯函数：输入 metric snapshot → 输出每指标 grade + 整体 A-F + 各类小分。
 *
 * v2（2026-06-08）: AQM 加权聚合（A=40%/B=30%/C=20%/D=10%）；LEGACY 不进聚合。
 */
import { describe, expect, test } from "bun:test";
import { gradeSnapshot, type ReadinessSnapshot } from "../grader";

function makeSnap(
  metrics: Record<string, number | null>,
  overrides: Partial<ReadinessSnapshot> = {}
): ReadinessSnapshot {
  return {
    workflowRunId: "wf-test",
    scenario: "research",
    capturedAt: "2026-06-08T00:00:00.000Z",
    workflowStatus: "completed",
    metrics,
    ...overrides,
  };
}

const ALL_GREEN: Record<string, number> = {
  // A 类：4 个全绿
  "A-1": 1.0,
  "A-2": 0.8,
  "A-3": 4.0,
  "A-4": 1.0,
  // B 类：4 个全绿
  "B-1": 1.0,
  "B-2": 1.0,
  "B-3": 0.0,
  "B-7": 1,
  // C 类：5 个全绿
  "C-1": 1.0,
  "C-2": 0.0,
  "C-3-total": 50_000,
  "C-3-p95": 10_000,
  "C-5": 0.0,
  // D 类：3 个全绿
  "D-1": 1.0,
  "D-2": 0.3,
  "D-3": 0.8,
};

describe("gradeSnapshot v2 (AQM)", () => {
  test("全绿 16 指标 → A，weightedScore = 1.0", () => {
    const r = gradeSnapshot(makeSnap(ALL_GREEN));
    expect(r.overall).toBe("A");
    expect(r.weightedScore).toBeCloseTo(1.0, 2);
    expect(r.categoryScores.A).toBe(1);
    expect(r.categoryScores.B).toBe(1);
    expect(r.categoryScores.C).toBe(1);
    expect(r.categoryScores.D).toBe(1);
  });

  test("仅黄灯 → B", () => {
    // A-2 = 0.4 落在 yellow 区间（0.3 ~ 0.6）
    const r = gradeSnapshot(makeSnap({ ...ALL_GREEN, "A-2": 0.4 }));
    expect(r.metricGrades["A-2"]).toBe("yellow");
    expect(r.overall).toBe("B");
  });

  test("A 类全红 → 总分明显下降，跌到 D", () => {
    const r = gradeSnapshot(
      makeSnap({
        ...ALL_GREEN,
        "A-1": 0,
        "A-2": 0,
        "A-3": 1,
        "A-4": 0,
      })
    );
    expect(r.metricGrades["A-1"]).toBe("red");
    expect(r.categoryScores.A).toBe(0);
    // 加权分 = 0*0.4 + 1*0.3 + 1*0.2 + 1*0.1 = 0.6
    expect(r.weightedScore).toBeCloseTo(0.6, 2);
    // 红比 = 4/16 = 0.25 → D（红比 > 0.1）
    expect(r.overall).toBe("D");
  });

  test("一个指标缺值（A-3=null，nullGrade=null）不计入聚合", () => {
    const r = gradeSnapshot(makeSnap({ ...ALL_GREEN, "A-3": null }));
    expect(r.metricGrades["A-3"]).toBeNull();
    // A 类还有 3 个绿；categoryScores.A 仍是 1（3 绿 / 3 = 1）
    expect(r.categoryScores.A).toBe(1);
    expect(r.overall).toBe("A");
  });

  test("LEGACY 6 指标即使存在，也不进入主聚合（仅在 metricGrades 中可见）", () => {
    const r = gradeSnapshot(
      makeSnap({
        ...ALL_GREEN,
        "O-1": 0,
        "T-1": 0.5,
        "T-3": 0.5,
        "T-6": 9_999_999,
        "S-1": 0,
        "M-1": 0,
      })
    );
    // 主聚合还是 A（全绿）
    expect(r.overall).toBe("A");
    expect(r.metricCategories["O-1"]).toBe("LEGACY");
    expect(r.metricGrades["O-1"]).toBe("red"); // grade 仍计算了
  });

  test("B 全红 + A 全黄 → 加权分跌到 D", () => {
    const r = gradeSnapshot(
      makeSnap({
        ...ALL_GREEN,
        "A-1": 0.5,
        "A-2": 0.4,
        "A-3": 3.0,
        "A-4": 0.8,
        "B-1": 0,
        "B-2": 0,
        "B-3": 0.5,
        "B-7": 5,
      })
    );
    // A 全黄 → A 分 = 0.5；B 全红 → B 分 = 0；C/D 全绿
    // 加权 = 0.5*0.4 + 0*0.3 + 1*0.2 + 1*0.1 = 0.5 → D
    expect(r.weightedScore).toBeCloseTo(0.5, 2);
    expect(r.overall).toBe("D");
  });

  test("结果包含描述与类别用于 reporter", () => {
    const r = gradeSnapshot(makeSnap(ALL_GREEN));
    expect(r.metricDescriptions["A-1"]).toMatch(/产物完整性/);
    expect(r.metricCategories["A-1"]).toBe("A");
    expect(r.metricCategories["B-1"]).toBe("B");
  });
});
