/**
 * MemoryWorkspaceSync 纯函数测试 — M10.A2 + Context Protocol 05
 *
 * 冷镜像仅 identity / execution_profile；金融结论走 FinanceRecall。
 */

import { describe, expect, test } from "bun:test";
import { renderMemoryMarkdown } from "../memory-workspace-sync";

describe("MemoryWorkspaceSync — renderMemoryMarkdown", () => {
  test("空记忆 → identity 占位 + FinanceRecall 提示", () => {
    const md = renderMemoryMarkdown({
      definitionName: "Research Lead",
      role: "research",
      longtermByType: new Map(),
      midtermRows: [],
    });
    expect(md).toContain("# Identity Memory · Research Lead (research)");
    expect(md).toContain("Finance Recall");
    expect(md).toContain("暂无执行画像");
    expect(md).toContain("execution_profile");
  });

  test("execution_profile 按类型分节；其它类型也可渲染（兼容传入）", () => {
    const longtermByType = new Map([
      [
        "execution_profile",
        [
          {
            id: "lt1",
            memoryType: "execution_profile",
            contentJson: { content: "riskTolerance=medium preferredUniverse=CN-A" },
            confidenceScore: 0.85,
            asofTime: "2026-05-21T10:00:00Z",
            validFrom: "2026-05-21T10:00:00Z",
            validTo: null,
          },
        ],
      ],
    ]);
    const md = renderMemoryMarkdown({
      definitionName: "Test",
      role: "research",
      longtermByType,
      midtermRows: [],
    });
    expect(md).toContain("### execution_profile (1)");
    expect(md).toContain("riskTolerance=medium");
    expect(md).toContain("conf=0.85");
  });

  test("legacy midterm 仍可渲染（兼容），但默认同步不再拉取", () => {
    const longText = "x".repeat(800);
    const md = renderMemoryMarkdown({
      definitionName: "Test",
      role: "backtest",
      longtermByType: new Map(),
      midtermRows: [
        {
          id: "m1",
          memoryType: "simulation_note",
          contentJson: { content: longText },
          asofTime: "2026-05-21T11:30:00Z",
          timeWindowStart: "2026-05-21T11:00:00Z",
          timeWindowEnd: "2026-05-21T11:30:00Z",
        },
      ],
    });
    expect(md).toContain("### 2026-05-21 11:30 · simulation_note");
    expect(md).toContain("(truncated)");
    expect(md).toContain("midterm · legacy");
  });

  test("contentJson 是 string 时直接当 content 用", () => {
    const md = renderMemoryMarkdown({
      definitionName: "Test",
      role: "risk",
      longtermByType: new Map(),
      midtermRows: [
        {
          id: "m1",
          memoryType: "risk_review",
          contentJson: "纯字符串内容也能渲染",
          asofTime: "2026-05-21T12:00:00Z",
          timeWindowStart: "2026-05-21T11:30:00Z",
          timeWindowEnd: "2026-05-21T12:00:00Z",
        },
      ],
    });
    expect(md).toContain("纯字符串内容也能渲染");
  });

  test("末尾应有自动同步说明", () => {
    const md = renderMemoryMarkdown({
      definitionName: "Test",
      role: "research",
      longtermByType: new Map(),
      midtermRows: [],
    });
    expect(md).toContain("此文件由系统自动同步");
    expect(md).toContain("execution_profile");
  });
});
