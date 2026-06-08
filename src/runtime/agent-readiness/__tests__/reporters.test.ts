/**
 * reporters 是纯函数，输入 (snapshot, grade) → 输出文本（JSON / Markdown）。
 * 这里只验证关键字段都出现，不死磕格式细节。
 */
import { describe, expect, test } from "bun:test";
import { renderJsonReport, renderMarkdownReport } from "../reporters";
import type { ReadinessSnapshot } from "../grader";

const snapshot: ReadinessSnapshot = {
  workflowRunId: "wf-rep-1",
  scenario: "research",
  capturedAt: "2026-06-05T08:00:00.000Z",
  workflowStatus: "completed",
  metrics: {
    "O-1": 1,
    "T-1": 0.02,
    "T-3": 0,
    "T-6": 12345,
    "S-1": 0.4,
    "M-1": 1,
  },
};

describe("renderJsonReport", () => {
  test("输出 JSON 包含 snapshot + grade 两个 section", () => {
    const out = renderJsonReport(snapshot);
    const parsed = JSON.parse(out);
    expect(parsed.snapshot.workflowRunId).toBe("wf-rep-1");
    expect(parsed.grade.overall).toBe("A");
    expect(parsed.grade.metricGrades["O-1"]).toBe("green");
  });

  test("JSON 是 pretty-printed（包含换行）", () => {
    const out = renderJsonReport(snapshot);
    expect(out.split("\n").length).toBeGreaterThan(5);
  });
});

describe("renderMarkdownReport", () => {
  test("Markdown 包含场景 / workflowRunId / 总分 / 6 个指标行", () => {
    const md = renderMarkdownReport(snapshot);
    expect(md).toContain("research");
    expect(md).toContain("wf-rep-1");
    expect(md).toMatch(/总分.*A/);
    // 6 个指标都出现
    for (const id of ["O-1", "T-1", "T-3", "T-6", "S-1", "M-1"]) {
      expect(md).toContain(id);
    }
  });

  test("红灯指标用 ❌ 黄灯 ⚠️ 绿灯 ✅ 标识", () => {
    const redSnapshot: ReadinessSnapshot = {
      ...snapshot,
      metrics: { ...snapshot.metrics, "O-1": 0, "T-1": 0.5, "M-1": 0 },
    };
    const md = renderMarkdownReport(redSnapshot);
    expect(md).toContain("❌");
  });

  test("Markdown 提示 next-step 调优建议", () => {
    const redSnapshot: ReadinessSnapshot = {
      ...snapshot,
      metrics: { ...snapshot.metrics, "O-1": 0 },
    };
    const md = renderMarkdownReport(redSnapshot);
    // 至少在文末有"下一步"或"建议"小节
    expect(md).toMatch(/下一步|next.step|建议/i);
  });
});
