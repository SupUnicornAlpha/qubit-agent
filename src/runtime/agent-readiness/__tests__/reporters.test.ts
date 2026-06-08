/**
 * reporters 是纯函数，输入 (snapshot) → 输出文本（JSON / Markdown）。
 * v2（2026-06-08）按 A/B/C/D 类分块输出，schemaVersion = 2.0。
 */
import { describe, expect, test } from "bun:test";
import { renderJsonReport, renderMarkdownReport } from "../reporters";
import type { ReadinessSnapshot } from "../grader";

const FULL_AQM_GREEN: ReadinessSnapshot = {
  workflowRunId: "wf-rep-1",
  scenario: "research",
  capturedAt: "2026-06-08T08:00:00.000Z",
  workflowStatus: "completed",
  metrics: {
    "A-1": 1,
    "A-2": 0.8,
    "A-3": 4.0,
    "A-4": 1,
    "B-1": 1,
    "B-2": 1,
    "B-3": 0,
    "B-7": 1,
    "C-1": 1,
    "C-2": 0,
    "C-3-total": 50_000,
    "C-3-p95": 10_000,
    "C-5": 0,
    "D-1": 1,
    "D-2": 0.3,
    "D-3": 0.8,
    // LEGACY
    "O-1": 1,
    "T-1": 0.0,
    "T-3": 0,
    "T-6": 50_000,
    "S-1": 0.4,
    "M-1": 1,
  },
};

describe("renderJsonReport v2", () => {
  test("输出 schemaVersion=2.0 + snapshot + grade 三段", () => {
    const out = renderJsonReport(FULL_AQM_GREEN);
    const parsed = JSON.parse(out);
    expect(parsed.schemaVersion).toBe("2.0");
    expect(parsed.snapshot.workflowRunId).toBe("wf-rep-1");
    expect(parsed.grade.overall).toBe("A");
    expect(parsed.grade.categoryScores.A).toBe(1);
  });
});

describe("renderMarkdownReport v2", () => {
  test("Markdown 包含 4 个类标题 + AQM 总分 + 16 指标行", () => {
    const md = renderMarkdownReport(FULL_AQM_GREEN);
    expect(md).toContain("研究" === "research" ? "研究" : "research");
    expect(md).toContain("wf-rep-1");
    expect(md).toMatch(/总分.*A/);
    expect(md).toContain("A 类 · 内容质量");
    expect(md).toContain("B 类 · 工具/Skill 调用质量");
    expect(md).toContain("C 类 · LLM 调用质量");
    expect(md).toContain("D 类 · 编排质量");
    for (const id of [
      "A-1", "A-2", "A-3", "A-4",
      "B-1", "B-2", "B-3", "B-7",
      "C-1", "C-2", "C-3-total", "C-5",
      "D-1", "D-2", "D-3",
    ]) {
      expect(md).toContain(id);
    }
  });

  test("绿灯指标用 ✅ 标识", () => {
    const md = renderMarkdownReport(FULL_AQM_GREEN);
    expect(md).toContain("✅");
  });

  test("有红灯时给出 next-step 建议", () => {
    const red: ReadinessSnapshot = {
      ...FULL_AQM_GREEN,
      metrics: { ...FULL_AQM_GREEN.metrics, "A-1": 0, "B-1": 0 },
    };
    const md = renderMarkdownReport(red);
    expect(md).toContain("❌");
    expect(md).toMatch(/下一步|next.step|建议/i);
  });

  test("各类小分表显示 categoryScores", () => {
    const md = renderMarkdownReport(FULL_AQM_GREEN);
    expect(md).toContain("各类小分");
    expect(md).toContain("40%");
    expect(md).toContain("30%");
  });
});
