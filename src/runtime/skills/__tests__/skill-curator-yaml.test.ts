/**
 * Curator YAML parser tests — 纯函数，不需要 DB / LLM。
 */
import { describe, expect, test } from "bun:test";
import { parseCuratorYaml, buildCuratorReviewPrompt } from "../skill-curator";
import type { AgentSkill } from "../../../types/entities";

describe("parseCuratorYaml — fenced block", () => {
  test("strips ```yaml fence", () => {
    const yaml = [
      "```yaml",
      "actions:",
      "  - kind: archive",
      "    skill_id: sk_001",
      "    reason: 长期未使用",
      "```",
    ].join("\n");
    const actions = parseCuratorYaml(yaml);
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({ kind: "archive", skillId: "sk_001", reason: "长期未使用" });
  });

  test("plain yaml without fence", () => {
    const yaml = [
      "actions:",
      "  - kind: consolidate",
      "    primary_skill_id: sk_001",
      "    duplicate_skill_ids: [sk_002, sk_003]",
      "    reason: 已被 sk_001 覆盖",
    ].join("\n");
    const actions = parseCuratorYaml(yaml);
    expect(actions.length).toBe(1);
    expect(actions[0]?.kind).toBe("consolidate");
    expect(actions[0]?.primarySkillId).toBe("sk_001");
    expect(actions[0]?.duplicateSkillIds).toEqual(["sk_002", "sk_003"]);
  });

  test("multiple actions in one block", () => {
    const yaml = [
      "actions:",
      "  - kind: archive",
      "    skill_id: a",
      "    reason: 过时",
      "  - kind: archive",
      "    skill_id: b",
      "    reason: 重复",
    ].join("\n");
    const actions = parseCuratorYaml(yaml);
    expect(actions.length).toBe(2);
    expect(actions[0]?.skillId).toBe("a");
    expect(actions[1]?.skillId).toBe("b");
  });

  test("unknown kind is filtered out", () => {
    const yaml = ["actions:", "  - kind: explode", "    skill_id: a", "    reason: bad"].join("\n");
    const actions = parseCuratorYaml(yaml);
    expect(actions.length).toBe(0);
  });
});

describe("buildCuratorReviewPrompt — handles edge cases", () => {
  test("empty list still produces a header", () => {
    const out = buildCuratorReviewPrompt([]);
    expect(out).toContain("活跃 skill 列表");
  });

  test("includes use_count + success_rate + state", () => {
    const skill: AgentSkill = mkSkill({ useCount: 10, successCount: 7, state: "stale" });
    const out = buildCuratorReviewPrompt([skill]);
    expect(out).toContain("use_count: 10");
    expect(out).toContain("success_rate: 70%");
    expect(out).toContain("state: stale");
  });
});

function mkSkill(overrides: Partial<AgentSkill>): AgentSkill {
  return {
    id: "sk_" + Math.random().toString(36).slice(2, 8),
    projectId: "p1",
    definitionId: null,
    name: "test-skill",
    description: "do something",
    bodyMd: "# stub",
    category: "general",
    version: "v1",
    parentSkillId: null,
    source: "agent_created",
    externalInstallId: null,
    state: "active",
    pinned: false,
    useCount: 0,
    successCount: 0,
    failCount: 0,
    lastUsedAt: null,
    metadataJson: {},
    createdBy: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
