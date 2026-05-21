/**
 * MemoryWorkspaceSync 纯函数测试 — M10.A2
 *
 * 只测 renderMemoryMarkdown（不依赖 DB），DB 集成测试在 contract 测试里。
 */

import { describe, expect, test } from "bun:test";
import { renderMemoryMarkdown } from "../memory-workspace-sync";

describe("MemoryWorkspaceSync — renderMemoryMarkdown", () => {
  test("空记忆 → 输出占位 markdown，含 hint 信息", () => {
    const md = renderMemoryMarkdown({
      definitionName: "Research Lead",
      role: "research",
      longtermByType: new Map(),
      midtermRows: [],
    });
    expect(md).toContain("# Long-term Memory · Research Lead (research)");
    expect(md).toContain("由 MemoryConsolidationService 自动维护");
    expect(md).toContain("暂无长期记忆");
    expect(md).toContain("暂无中期记忆");
    expect(md).toContain("memory.consolidate_longterm");
  });

  test("长期记忆按类型分节", () => {
    const longtermByType = new Map([
      [
        "factor_archive",
        [
          {
            id: "lt1",
            memoryType: "factor_archive",
            contentJson: { content: "momentum_20d RankIC=0.045 IR=0.82 已上线" },
            confidenceScore: 0.85,
            asofTime: "2026-05-21T10:00:00Z",
            validFrom: "2026-05-21T10:00:00Z",
            validTo: null,
          },
        ],
      ],
      [
        "playbook",
        [
          {
            id: "lt2",
            memoryType: "playbook",
            contentJson: { content: "牛市行情下偏好动量因子" },
            confidenceScore: null,
            asofTime: "2026-05-20T08:00:00Z",
            validFrom: "2026-05-20T08:00:00Z",
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
    expect(md).toContain("### factor_archive (1)");
    expect(md).toContain("### playbook (1)");
    expect(md).toContain("momentum_20d RankIC=0.045");
    expect(md).toContain("conf=0.85");
    expect(md).toContain("牛市行情下偏好动量因子");
  });

  test("中期记忆按时间排列 + 截断", () => {
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
    expect(md).toContain("(truncated)"); // 长内容应被截断
    expect(md.length).toBeLessThan(2000);
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
    expect(md).toContain("write_memory");
  });
});
