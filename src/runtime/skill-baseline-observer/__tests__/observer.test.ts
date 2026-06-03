/**
 * P9 SkillBaselineObserver 单测：
 *   1) SELF_EVOLVE_ENABLED=false → status='disabled'，不扫
 *   2) 无 evolved pending_review skill → scanned=0
 *   3) 召回数 < min → not_ready，保持 pending_review
 *   4) 召回数 ≥ min 但 signaled<min → not_ready
 *   5) 召回数+signaled OK 但 success rate 不达标 → not_ready
 *   6) 全部达标 → approve（state→active + lastPromotedAt 写入）
 *   7) source≠'evolved' / state≠'pending_review' → 不扫
 *   8) outcome='unknown' 的 run 不参与 success rate
 *   9) maxApprovesPerRun 截断
 *  10) emit summary 含 status / approved
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../../../config";
import { closeDb, getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  agentDefinition,
  agentInstance,
  agentSkill,
  agentSkillRun,
  project,
  sandboxPolicy,
  skillRecallLog,
  workflowRun,
  workspace,
} from "../../../db/sqlite/schema";
import { setSelfEvolveConfigForTest } from "../../config/self-evolve-config";
import { getExperienceBus, type ExperienceEvent } from "../../experience/experience-bus";
import { SkillBaselineObserver } from "../observer";

interface Fx {
  projectId: string;
  definitionId: string;
  workflowRunId: string;
  agentInstanceId: string;
}

let fx: Fx;

async function seedSkill(props: {
  state?: "active" | "pending_review" | "archived" | "stale";
  source?: "agent_created" | "user_authored" | "open_skill_market" | "evolved";
  name?: string;
}): Promise<string> {
  const db = await getDb();
  const id = `skill_${randomUUID()}`;
  await db
    .insert(agentSkill)
    .values({
      id,
      projectId: fx.projectId,
      definitionId: fx.definitionId,
      name: props.name ?? `n_${id.slice(-6)}`,
      state: props.state ?? "pending_review",
      source: props.source ?? "evolved",
    })
    .run();
  return id;
}

async function seedRecall(skillId: string, executed = true): Promise<void> {
  const db = await getDb();
  await db
    .insert(skillRecallLog)
    .values({
      id: `srl_${randomUUID()}`,
      workflowRunId: fx.workflowRunId,
      definitionId: fx.definitionId,
      skillId,
      executed,
    })
    .run();
}

async function seedRun(skillId: string, outcome: "success" | "fail" | "partial" | "unknown"): Promise<void> {
  const db = await getDb();
  await db
    .insert(agentSkillRun)
    .values({
      id: `asr_${randomUUID()}`,
      skillId,
      workflowRunId: fx.workflowRunId,
      agentInstanceId: fx.agentInstanceId,
      definitionId: fx.definitionId,
      outcome,
    })
    .run();
}

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p9-observer-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();

  const db = await getDb();
  const workspaceId = `ws_${randomUUID()}`;
  const sandboxPolicyId = `sp_${randomUUID()}`;
  fx = {
    projectId: `prj_${randomUUID()}`,
    definitionId: `def_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    agentInstanceId: `ai_${randomUUID()}`,
  };
  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: fx.projectId, workspaceId, name: "p", marketScope: "US" })
    .run();
  await db.insert(sandboxPolicy).values({ id: sandboxPolicyId, name: "permissive-test" }).run();
  await db
    .insert(agentDefinition)
    .values({
      id: fx.definitionId,
      role: "r",
      name: "t",
      systemPrompt: "sp",
      llmProvider: "mock",
      sandboxPolicyId,
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
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(agentSkillRun).run();
  await db.delete(skillRecallLog).run();
  await db.delete(agentSkill).where(eq(agentSkill.projectId, fx.projectId));
  setSelfEvolveConfigForTest({ enabled: true });
});

afterEach(() => {
  setSelfEvolveConfigForTest(null);
});

describe("SkillBaselineObserver", () => {
  test("总闸关 → status='disabled'，不扫", async () => {
    setSelfEvolveConfigForTest({ enabled: false });
    const s = await new SkillBaselineObserver().runOnce({ projectId: fx.projectId, emitMetrics: false });
    expect(s.status).toBe("disabled");
    expect(s.reason).toContain("SELF_EVOLVE_ENABLED=false");
    expect(s.scanned).toBe(0);
  });

  test("无候选 skill → scanned=0", async () => {
    const s = await new SkillBaselineObserver().runOnce({ projectId: fx.projectId, emitMetrics: false });
    expect(s.scanned).toBe(0);
    expect(s.approved).toBe(0);
  });

  test("召回数不足 → not_ready", async () => {
    const id = await seedSkill({});
    await seedRecall(id);
    await seedRun(id, "success");
    const s = await new SkillBaselineObserver().runOnce({
      projectId: fx.projectId,
      minRecallCount: 3,
      minSignaledRuns: 2,
      minSuccessRate: 0.6,
      emitMetrics: false,
    });
    expect(s.scanned).toBe(1);
    expect(s.approved).toBe(0);
    expect(s.notReady).toBe(1);
    expect(s.results[0]!.action).toBe("not_ready");
    expect(s.results[0]!.reason).toContain("recall=1<3");
    const db = await getDb();
    const [row] = await db.select().from(agentSkill).where(eq(agentSkill.id, id));
    expect(row!.state).toBe("pending_review");
  });

  test("recall 够但 signaled 不够 → not_ready", async () => {
    const id = await seedSkill({});
    await seedRecall(id);
    await seedRecall(id);
    await seedRecall(id);
    await seedRun(id, "success"); // 仅 1 个 signaled
    const s = await new SkillBaselineObserver().runOnce({
      projectId: fx.projectId,
      minRecallCount: 3,
      minSignaledRuns: 2,
      minSuccessRate: 0.6,
      emitMetrics: false,
    });
    expect(s.notReady).toBe(1);
    expect(s.results[0]!.reason).toContain("signaled=1<2");
  });

  test("recall+signaled 够但 success rate 不够 → not_ready", async () => {
    const id = await seedSkill({});
    await seedRecall(id);
    await seedRecall(id);
    await seedRecall(id);
    await seedRun(id, "success");
    await seedRun(id, "fail");
    await seedRun(id, "fail"); // 1/3 = 33% < 60%
    const s = await new SkillBaselineObserver().runOnce({
      projectId: fx.projectId,
      minRecallCount: 3,
      minSignaledRuns: 2,
      minSuccessRate: 0.6,
      emitMetrics: false,
    });
    expect(s.notReady).toBe(1);
    expect(s.results[0]!.reason).toMatch(/successRate=33%/);
  });

  test("全部达标 → approve（state→active）", async () => {
    const id = await seedSkill({});
    for (let i = 0; i < 4; i++) await seedRecall(id);
    await seedRun(id, "success");
    await seedRun(id, "success");
    await seedRun(id, "fail"); // 2/3 ≈ 67% ≥ 60%
    const s = await new SkillBaselineObserver().runOnce({
      projectId: fx.projectId,
      minRecallCount: 3,
      minSignaledRuns: 2,
      minSuccessRate: 0.6,
      emitMetrics: false,
    });
    expect(s.approved).toBe(1);
    expect(s.results[0]!.action).toBe("approved");
    const db = await getDb();
    const [row] = await db.select().from(agentSkill).where(eq(agentSkill.id, id));
    expect(row!.state).toBe("active");
    expect(row!.lastPromotedAt).toBeTruthy();
    expect(row!.promotionReviewAt).toBeTruthy();
  });

  test("source!='evolved' 不扫", async () => {
    await seedSkill({ source: "agent_created" });
    await seedSkill({ source: "user_authored" });
    const s = await new SkillBaselineObserver().runOnce({ projectId: fx.projectId, emitMetrics: false });
    expect(s.scanned).toBe(0);
  });

  test("outcome=unknown 不计入 success rate", async () => {
    const id = await seedSkill({});
    for (let i = 0; i < 3; i++) await seedRecall(id);
    for (let i = 0; i < 5; i++) await seedRun(id, "unknown"); // 全 unknown
    await seedRun(id, "success");
    await seedRun(id, "success"); // 信号是 2，全 success → 100%
    const s = await new SkillBaselineObserver().runOnce({
      projectId: fx.projectId,
      minRecallCount: 3,
      minSignaledRuns: 2,
      minSuccessRate: 0.6,
      emitMetrics: false,
    });
    expect(s.approved).toBe(1);
    expect(s.results[0]!.signaledRunCount).toBe(2); // unknown 不计
    expect(s.results[0]!.successRate).toBe(1);
  });

  test("maxApprovesPerRun 截断", async () => {
    const a = await seedSkill({});
    const b = await seedSkill({});
    for (const id of [a, b]) {
      for (let i = 0; i < 3; i++) await seedRecall(id);
      await seedRun(id, "success");
      await seedRun(id, "success");
    }
    const s = await new SkillBaselineObserver().runOnce({
      projectId: fx.projectId,
      minRecallCount: 3,
      minSignaledRuns: 2,
      minSuccessRate: 0.6,
      maxApprovesPerRun: 1,
      emitMetrics: false,
    });
    expect(s.approved).toBe(1);
  });

  test("emit summary 含 status / approved", async () => {
    const id = await seedSkill({});
    for (let i = 0; i < 3; i++) await seedRecall(id);
    await seedRun(id, "success");
    await seedRun(id, "success");
    const bus = getExperienceBus();
    const evs: ExperienceEvent[] = [];
    const off = bus.subscribe("maintenance_run", (e) => evs.push(e));
    try {
      await new SkillBaselineObserver().runOnce({
        projectId: fx.projectId,
        minRecallCount: 3,
        minSignaledRuns: 2,
        minSuccessRate: 0.6,
      });
      await bus.awaitIdle();
    } finally {
      off();
    }
    const ev = evs.find((e) => e.type === "maintenance_run" && e.kind === "skill_baseline_observer");
    expect(ev).toBeDefined();
    const s = (ev as { summary: Record<string, unknown> }).summary;
    expect(s["status"]).toBe("completed");
    expect(s["approved"]).toBe(1);
  });
});
