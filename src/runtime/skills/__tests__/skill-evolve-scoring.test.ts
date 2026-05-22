/**
 * scoreSkillBody — 纯函数评分测试。
 * 关键：越好的 skill body 得分越高；带"this run"/"PR #123"等当次性指代会被扣分。
 */
import { describe, expect, test } from "bun:test";
import { scoreSkillBody, scoreSkillBodyDetailed } from "../skill-evolve";

describe("scoreSkillBody — structural quality signals", () => {
  test("空 body 得 0", () => {
    expect(scoreSkillBody({ description: "", bodyMd: "" })).toBe(0);
  });

  test("有步骤 + 验收 + 失败处理 → 高分", () => {
    const good = `# Skill X
## 适用场景
当目标是 A 并且包含 B 时使用。

## 步骤
1. 拉数据
2. 分析
3. 验收：RankIC > 0.02

## 常见失败 fallback
- 数据缺 → 改用另一源
- LLM 输出异常 → 重试 + 加强 system_prompt
`;
    const score = scoreSkillBody({ description: "完整描述清晰的复杂流程，需要 5 步以上工具调用", bodyMd: good });
    expect(score).toBeGreaterThan(0.6);
  });

  test("仅一行文本 → 低分", () => {
    const score = scoreSkillBody({ description: "x", bodyMd: "just one line" });
    expect(score).toBeLessThan(0.5);
  });

  test("含 'this run' / commit SHA → 被扣分", () => {
    const dirty = `# Skill\n## 步骤\n1. 用了 commit 6f2a3b9d 跑了一次\n2. this run 成功`;
    const clean = `# Skill\n## 步骤\n1. 拉数据\n2. 分析`;
    const dirtyScore = scoreSkillBodyDetailed({ description: "好的描述至少 60 字以保证检索能命中", bodyMd: dirty });
    const cleanScore = scoreSkillBodyDetailed({ description: "好的描述至少 60 字以保证检索能命中", bodyMd: clean });
    expect(cleanScore.score).toBeGreaterThan(dirtyScore.score);
    expect(dirtyScore.breakdown.cleanlinessPenalty).toBeLessThan(0);
  });

  test("description 含 '可能/也许' 扣分", () => {
    const body = `## 步骤\n1. a\n2. b\n3. c\n4. d\n5. e`;
    const vague = scoreSkillBodyDetailed({ description: "可能用于某些场景吧", bodyMd: body });
    const sharp = scoreSkillBodyDetailed({
      description: "当 goal 是因子盘点且 universe ≥ 50 时使用，跑 5-step factor-discovery-promote-backtest 链",
      bodyMd: body,
    });
    expect(sharp.breakdown.description).toBeGreaterThan(vague.breakdown.description!);
  });
});
