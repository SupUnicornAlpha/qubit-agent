/**
 * P9 reason 节点 PnL-aware skill 块单测：
 *   - 总闸 / pnlAwareReasonEnabled 关时返回空
 *   - 有 PnL 数据 → 输出 markdown，含 top-N 名次 / win/lose/胜率
 *   - 全是亏损（pnlSum ≤ 0）→ 不输出（避免引导 LLM 用 loser）
 *   - SkillAttributor 抛错 → 静默返空（不阻塞 reason）
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "../../../../config";
import { closeDb, getDb } from "../../../../db/sqlite/client";
import { runMigrations } from "../../../../db/sqlite/migrate";
import {
  agentDefinition,
  agentInstance,
  agentSkill,
  agentSkillRun,
  project,
  sandboxPolicy,
  workflowRun,
  workspace,
} from "../../../../db/sqlite/schema";
import { setSelfEvolveConfigForTest } from "../../../config/self-evolve-config";
import {
  buildPnlAwareSkillBlock,
  fetchPnlAwareTopSkills,
  renderPnlAwareSkillBlock,
} from "../pnl-aware-skill-block";

interface Fx {
  projectId: string;
  definitionId: string;
  workflowRunId: string;
  agentInstanceId: string;
  s1: string;
  s2: string;
  s3: string;
}

let fx: Fx;

async function seedRun(skillId: string, pnl: number): Promise<void> {
  const db = await getDb();
  await db
    .insert(agentSkillRun)
    .values({
      id: `asr_${randomUUID()}`,
      skillId,
      workflowRunId: fx.workflowRunId,
      agentInstanceId: fx.agentInstanceId,
      definitionId: fx.definitionId,
      outcome: pnl >= 0 ? "success" : "fail",
      pnlDelta: pnl,
      attributionConfidence: 1,
    })
    .run();
}

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p9-reason-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
  const db = await getDb();

  const workspaceId = `ws_${randomUUID()}`;
  fx = {
    projectId: `prj_${randomUUID()}`,
    definitionId: `def_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    agentInstanceId: `ai_${randomUUID()}`,
    s1: `skill_${randomUUID()}`,
    s2: `skill_${randomUUID()}`,
    s3: `skill_${randomUUID()}`,
  };
  const polId = `sp_${randomUUID()}`;
  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db.insert(project).values({ id: fx.projectId, workspaceId, name: "p", marketScope: "US" }).run();
  await db.insert(sandboxPolicy).values({ id: polId, name: "permissive-test" }).run();
  await db
    .insert(agentDefinition)
    .values({
      id: fx.definitionId,
      role: "research",
      name: "t",
      systemPrompt: "sp",
      llmProvider: "mock",
      sandboxPolicyId: polId,
    })
    .run();
  await db
    .insert(workflowRun)
    .values({ id: fx.workflowRunId, projectId: fx.projectId, goal: "g", mode: "live" })
    .run();
  await db
    .insert(agentInstance)
    .values({
      id: fx.agentInstanceId,
      definitionId: fx.definitionId,
      workflowRunId: fx.workflowRunId,
    })
    .run();
  for (const [id, name] of [
    [fx.s1, "skill_alpha"],
    [fx.s2, "skill_beta"],
    [fx.s3, "skill_gamma"],
  ] as const) {
    await db
      .insert(agentSkill)
      .values({ id, projectId: fx.projectId, name, definitionId: fx.definitionId })
      .run();
  }
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(agentSkillRun).run();
  setSelfEvolveConfigForTest(null);
});

afterEach(() => {
  setSelfEvolveConfigForTest(null);
});

describe("fetchPnlAwareTopSkills", () => {
  test("总闸关 → 返回空数组", async () => {
    setSelfEvolveConfigForTest({ enabled: false, pnlAwareReasonEnabled: true });
    await seedRun(fx.s1, 100);
    const db = await getDb();
    const r = await fetchPnlAwareTopSkills(db, fx.definitionId);
    expect(r).toHaveLength(0);
  });

  test("pnlAwareReasonEnabled=false → 空", async () => {
    setSelfEvolveConfigForTest({ enabled: true, pnlAwareReasonEnabled: false });
    await seedRun(fx.s1, 100);
    const db = await getDb();
    const r = await fetchPnlAwareTopSkills(db, fx.definitionId);
    expect(r).toHaveLength(0);
  });

  test("启用 + 有 PnL → 按 pnlSum desc top-N", async () => {
    setSelfEvolveConfigForTest({
      enabled: true,
      pnlAwareReasonEnabled: true,
      reasonPnlTopN: 3,
      reasonPnlWindowDays: 7,
    });
    await seedRun(fx.s1, 20);
    await seedRun(fx.s2, 50);
    await seedRun(fx.s3, 10);
    const db = await getDb();
    const r = await fetchPnlAwareTopSkills(db, fx.definitionId);
    expect(r).toHaveLength(3);
    expect(r[0]!.skillId).toBe(fx.s2);
    expect(r[1]!.skillId).toBe(fx.s1);
    expect(r[2]!.skillId).toBe(fx.s3);
  });

  test("全是 pnlSum ≤ 0 → 全过滤", async () => {
    setSelfEvolveConfigForTest({ enabled: true, pnlAwareReasonEnabled: true });
    await seedRun(fx.s1, -10);
    await seedRun(fx.s2, -50);
    const db = await getDb();
    const r = await fetchPnlAwareTopSkills(db, fx.definitionId);
    expect(r).toHaveLength(0);
  });

  test("有亏有赚 → 只返赚的", async () => {
    setSelfEvolveConfigForTest({ enabled: true, pnlAwareReasonEnabled: true });
    await seedRun(fx.s1, 30);
    await seedRun(fx.s2, -5);
    const db = await getDb();
    const r = await fetchPnlAwareTopSkills(db, fx.definitionId);
    expect(r).toHaveLength(1);
    expect(r[0]!.skillId).toBe(fx.s1);
  });
});

describe("renderPnlAwareSkillBlock", () => {
  test("empty → 空串", () => {
    setSelfEvolveConfigForTest({ enabled: true, pnlAwareReasonEnabled: true });
    expect(renderPnlAwareSkillBlock([])).toBe("");
  });

  test("非空 → markdown 含 top-N 名 + 胜率 + 引导语", () => {
    setSelfEvolveConfigForTest({
      enabled: true,
      pnlAwareReasonEnabled: true,
      reasonPnlTopN: 3,
      reasonPnlWindowDays: 7,
    });
    const out = renderPnlAwareSkillBlock([
      { skillId: "x", name: "skill_alpha", pnlSum: 25.5, winCount: 3, loseCount: 1, sampleCount: 4 },
      { skillId: "y", name: "skill_beta", pnlSum: 10, winCount: 1, loseCount: 0, sampleCount: 1 },
    ]);
    expect(out).toContain("最近 7 天最赚钱 top-2 skill");
    expect(out).toContain("skill_alpha");
    expect(out).toContain("+25.50");
    expect(out).toContain("胜率 75%");
    expect(out).toContain("不是命令");
  });
});

describe("buildPnlAwareSkillBlock 一站式", () => {
  test("end-to-end", async () => {
    setSelfEvolveConfigForTest({
      enabled: true,
      pnlAwareReasonEnabled: true,
      reasonPnlTopN: 2,
      reasonPnlWindowDays: 7,
    });
    await seedRun(fx.s1, 40);
    await seedRun(fx.s2, 10);
    const db = await getDb();
    const out = await buildPnlAwareSkillBlock(db, fx.definitionId);
    expect(out).toContain("skill_alpha");
    expect(out).toContain("+40.00");
    expect(out).toContain("top-2");
  });

  test("无数据 / 关闭时返回空", async () => {
    setSelfEvolveConfigForTest({ enabled: false });
    const db = await getDb();
    const out = await buildPnlAwareSkillBlock(db, fx.definitionId);
    expect(out).toBe("");
  });
});
