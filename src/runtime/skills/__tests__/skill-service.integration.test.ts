/**
 * SkillService 集成测试 — 跑真实 SQLite（in-memory via bun test），验证：
 *   - create / findByName / patch / archive 全链路
 *   - search 软排序：pinned > active.recent > useCount
 *   - recordUsage 自动从 stale 复活到 active
 *   - 同名重复 create 抛错
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { skillService } from "../skill-service";
import { proposeSkillCandidate } from "../../memory/memory-consolidation";

const NOW = "2026-01-01T00:00:00.000Z";

let projectId: string;
let workspaceId: string;

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "skill_ws",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "skill_proj",
    marketScope: "CN-A",
    createdAt: NOW,
  });
});

describe("SkillService basic CRUD", () => {
  test("create + findByName 幂等检查", async () => {
    const skill = await skillService.create({
      projectId,
      name: "factor-discovery-loop",
      description: "因子盘点 → 挖掘 → promote → 评估 的闭环（≥5 步）",
      bodyMd: "# Factor Discovery Loop\n\n## 步骤\n1. factor.list\n2. discovery.run\n3. discovery.promote\n4. factor.autoEvaluate",
    });
    expect(skill.id).toBeTruthy();
    expect(skill.name).toBe("factor-discovery-loop");
    expect(skill.useCount).toBe(0);

    const dup = skillService.create({
      projectId,
      name: "factor-discovery-loop",
      description: "another desc",
      bodyMd: "# dup body",
    });
    await expect(dup).rejects.toThrow(/already exists/);

    const found = await skillService.findByName(projectId, "factor-discovery-loop");
    expect(found?.id).toBe(skill.id);
  });

  test("patch bumps version when bumpVersion=true + merges metadata", async () => {
    const before = await skillService.findByName(projectId, "factor-discovery-loop");
    expect(before).not.toBeNull();
    // 不传 bumpVersion 时版本号保留
    const stay = await skillService.patch({
      skillId: before!.id,
      description: "(stable) 同步描述",
    });
    expect(stay.version).toBe(before!.version);
    // 显式 bumpVersion 时升级
    const patched = await skillService.patch({
      skillId: before!.id,
      description: "更新的描述：在 universe≥30 的 CN-A 项目下使用",
      pinned: true,
      metadata: { tags: ["alpha101", "promote"] },
      bumpVersion: true,
    });
    expect(patched.version).not.toBe(before!.version);
    expect(patched.pinned).toBe(true);
    expect((patched.metadataJson as { tags?: string[] }).tags).toEqual(["alpha101", "promote"]);
  });

  test("recordUsage 增加 useCount 并把 stale 复活到 active", async () => {
    const skill = await skillService.findByName(projectId, "factor-discovery-loop");
    expect(skill).not.toBeNull();
    // 把它人工置为 stale
    await skillService.patch({ skillId: skill!.id, state: "stale" });

    await skillService.recordUsage({
      skillId: skill!.id,
      outcome: "success",
      notes: "test usage",
    });
    const after = await skillService.findById(skill!.id);
    expect(after?.useCount).toBe(1);
    expect(after?.successCount).toBe(1);
    expect(after?.state).toBe("active"); // 自动复活
  });

  test("search: pinned > active > stale 软排序", async () => {
    await skillService.create({
      projectId,
      name: "tail-skill",
      description: "无关 skill 用于排序对照",
      bodyMd: "# tail\n\n## 步骤\n1. nothing",
    });
    const top = await skillService.search({ projectId, query: "因子 discovery", topK: 5 });
    expect(top.length).toBeGreaterThan(0);
    // pinned 的 factor-discovery-loop 应该在第一位
    expect(top[0]?.name).toBe("factor-discovery-loop");
  });

  test("archive 后默认不出现在 search 结果中，include 时才出现", async () => {
    const archCreated = await skillService.create({
      projectId,
      name: "to-archive",
      description: "测试归档",
      bodyMd: "# x\n\n## 步骤\n1. a",
    });
    await skillService.archive(archCreated.id, "test");
    const def = await skillService.search({ projectId, query: "测试归档", topK: 10 });
    expect(def.find((s) => s.id === archCreated.id)).toBeUndefined();
    const inc = await skillService.list(projectId, { includeArchived: true });
    expect(inc.find((s) => s.id === archCreated.id)).toBeTruthy();
  });
});

describe("proposeSkillCandidate", () => {
  test("门槛不满足时不创建", async () => {
    const ok = await proposeSkillCandidate({
      projectId,
      definitionId: null,
      role: "research",
      goal: "tiny task",
      steps: [
        {
          id: "s1",
          agentInstanceId: "i1",
          stepIndex: 0,
          phase: "act",
          thought: null,
          actionType: "tool_call",
          actionJson: { tool: "factor.list" },
          observationJson: null,
          createdAt: NOW,
        },
      ],
      summary: {
        text: "irrelevant",
        finalAnswer: "",
        toolsUsed: { "factor.list": 1 },
      },
    });
    expect(ok).toBe(false);
  });

  test("满足门槛（≥5 tool / ≥3 distinct / 有 final_answer）→ 创建 pending_review skill", async () => {
    const steps = ["factor.list", "factor.list", "discovery.run", "discovery.promote", "factor.autoEvaluate", "backtest.run"].map(
      (tool, idx) => ({
        id: `step_${idx}`,
        agentInstanceId: "i1",
        stepIndex: idx,
        phase: "act",
        thought: null,
        actionType: "tool_call",
        actionJson: { tool },
        observationJson: null,
        createdAt: NOW,
      })
    );
    const ok = await proposeSkillCandidate({
      projectId,
      definitionId: null,
      role: "researcher_bull",
      goal: "测试自动候选 skill：研究 universe=CN-A300 上的 momentum + value 组合",
      steps,
      summary: {
        text: "ran 6 steps end-to-end",
        finalAnswer: "best combo: mom_20d + ep_ttm",
        toolsUsed: {
          "factor.list": 2,
          "discovery.run": 1,
          "discovery.promote": 1,
          "factor.autoEvaluate": 1,
          "backtest.run": 1,
        },
      },
    });
    expect(ok).toBe(true);

    // 验证：表里多了一条 pending_review、source=agent_created、category=auto_candidate
    const db = await getDb();
    const rows = await db
      .select()
      .from(schema.agentSkill)
      .where(eq(schema.agentSkill.projectId, projectId));
    const candidate = rows.find((r) => r.category === "auto_candidate");
    expect(candidate).toBeTruthy();
    expect(candidate?.state).toBe("pending_review");
    expect(candidate?.source).toBe("agent_created");
  });
});
