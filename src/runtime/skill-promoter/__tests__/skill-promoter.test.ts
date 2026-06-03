/**
 * P5 SkillPromoter 集成测：experience.procedural → 评分 → 写 agent_skill(pending_review)。
 *
 * Fixture：
 *   workspace → project → 2 个 procedural workflow_play experience（一好一差）
 *
 * 覆盖：
 *   1) dry_run 不动 agent_skill；only summary
 *   2) live：合格候选写 pending_review；不合格 skip
 *   3) signature 已存在 agent_skill.bodyMd → skipped_duplicate
 *   4) signature 已被 reject 反馈记录 → skipped_rejected（不再骚扰）
 *   5) approveSkillPromotion → state='active'，写 promotionReviewAt/lastPromotedAt
 *   6) rejectSkillPromotion → state='archived'，写 reflective(skill_reject_feedback)
 *   7) emitMetrics=true → 收到 maintenance_run/skill_promoter event
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  agentSkill as agentSkillTable,
  experience as experienceTable,
  project,
  skillPromotionRun as skillPromotionRunTable,
  workspace,
} from "../../../db/sqlite/schema";
import type { ExperienceBus } from "../../experience/experience-bus";
import { getExperienceStore } from "../../experience/experience-store";
import {
  approveSkillPromotion,
  rejectSkillPromotion,
} from "../promoter-review";
import { SkillPromoter, parseSignatureFromBody } from "../skill-promoter";

interface Fixture {
  workspaceId: string;
  projectId: string;
  goodSig: string;
  badSig: string;
  goodExpId?: string;
  badExpId?: string;
}

let fixture: Fixture;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p5-promoter-${Date.now()}`);
  await runMigrations();
  const db = await getDb();
  const f: Fixture = {
    workspaceId: `ws_${randomUUID()}`,
    projectId: `prj_${randomUUID()}`,
    goodSig: "screener>fundamental>news",
    badSig: "ping>echo",
  };
  await db.insert(workspace).values({ id: f.workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: f.projectId, workspaceId: f.workspaceId, name: "p", marketScope: "US" })
    .run();
  fixture = f;
});

beforeEach(async () => {
  const db = await getDb();
  // 清空 P5 相关行
  await db.delete(skillPromotionRunTable).where(eq(skillPromotionRunTable.projectId, fixture.projectId));
  await db.delete(agentSkillTable).where(eq(agentSkillTable.projectId, fixture.projectId));

  // hard delete 本 project 所有 experience（包括 reflective 反馈，避免跨用例污染）
  await db.delete(experienceTable).where(eq(experienceTable.scopeId, fixture.projectId));
  const store = getExperienceStore();
  const good = await store.insert({
    kind: "procedural",
    subKind: "workflow_play",
    scope: "project",
    scopeId: fixture.projectId,
    definitionId: null,
    visibility: "project_shared",
    contentJson: {
      summary: "auto-play(analyst): screener → fundamental → news",
      body: "## Steps\n1. screener\n2. fundamental\n3. news\n",
    },
    tagsJson: ["rule:R2"],
    metadataJson: { signature: fixture.goodSig },
    validFrom: new Date().toISOString(),
    qualityScore: 0.7,
  });
  const bad = await store.insert({
    kind: "procedural",
    subKind: "workflow_play",
    scope: "project",
    scopeId: fixture.projectId,
    definitionId: null,
    visibility: "project_shared",
    contentJson: { summary: "auto-play: ping → echo", body: "trivial" },
    tagsJson: ["rule:R2"],
    metadataJson: { signature: fixture.badSig },
    validFrom: new Date().toISOString(),
    qualityScore: 0.4, // 触发 low_quality
  });
  // 给 good 灌满 useCount/successCount；给 bad 留 0
  await store.update(good.id, { useCount: 6, successCount: 5, failCount: 1 });
  fixture.goodExpId = good.id;
  fixture.badExpId = bad.id;

});

describe("SkillPromoter.runOnce", () => {
  test("dry_run：不写 agent_skill，只产 summary", async () => {
    const p = new SkillPromoter();
    const r = await p.runOnce({
      projectId: fixture.projectId,
      mode: "dry_run",
      emitMetrics: false,
    });
    expect(r.status).toBe("completed");
    expect(r.totalScanned).toBe(2);
    expect(r.totalQualified).toBe(1);
    expect(r.totalPromoted).toBe(0);
    const db = await getDb();
    const skills = await db
      .select()
      .from(agentSkillTable)
      .where(eq(agentSkillTable.projectId, fixture.projectId));
    expect(skills.length).toBe(0);
  });

  test("live：合格写 pending_review，bodyMd 末尾打 signature marker", async () => {
    const p = new SkillPromoter();
    const r = await p.runOnce({
      projectId: fixture.projectId,
      mode: "live",
      emitMetrics: false,
    });
    expect(r.totalPromoted).toBe(1);
    const db = await getDb();
    const skills = await db
      .select()
      .from(agentSkillTable)
      .where(eq(agentSkillTable.projectId, fixture.projectId));
    expect(skills.length).toBe(1);
    const s = skills[0]!;
    expect(s.state).toBe("pending_review");
    expect(s.promotionRunId).toBe(r.runId);
    expect(s.promotionScore).toBeGreaterThan(0);
    expect(s.lastPromotedAt).toBeTruthy();
    expect(parseSignatureFromBody(s.bodyMd)).toBe(fixture.goodSig);
  });

  test("duplicate：第二次 live 跑 → skipped_duplicate（同 signature 已 active）", async () => {
    const p = new SkillPromoter();
    const r1 = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });
    expect(r1.totalPromoted).toBe(1);

    const r2 = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });
    expect(r2.totalPromoted).toBe(0);
    expect(r2.totalSkippedDuplicate).toBe(1);
  });

  test("rejected：reject 后再跑 → skipped_rejected", async () => {
    const p = new SkillPromoter();
    const r1 = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });
    expect(r1.totalPromoted).toBe(1);
    const promotedId = r1.actions.find((a) => a.status === "promoted")!.promotedSkillId!;
    const rej = await rejectSkillPromotion(promotedId, { actor: "user", reason: "误判" });
    expect(rej.nextState).toBe("archived");
    expect(rej.reflectiveExperienceId).toBeTruthy();

    // archived 不再算 duplicate；reject 反馈算 rejected
    const r2 = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });
    expect(r2.totalPromoted).toBe(0);
    const rejectedAction = r2.actions.find((a) => a.status === "skipped_rejected");
    expect(rejectedAction).toBeTruthy();
  });

  test("approveSkillPromotion：pending_review → active + 时间戳", async () => {
    const p = new SkillPromoter();
    const r = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });
    const promotedId = r.actions.find((a) => a.status === "promoted")!.promotedSkillId!;
    const before = Date.now();
    const ap = await approveSkillPromotion(promotedId, { actor: "user", description: "OK" });
    expect(ap.nextState).toBe("active");
    expect(ap.prevState).toBe("pending_review");
    expect(ap.signature).toBe(fixture.goodSig);

    const db = await getDb();
    const [row] = await db
      .select()
      .from(agentSkillTable)
      .where(eq(agentSkillTable.id, promotedId));
    expect(row.state).toBe("active");
    expect(row.description).toBe("OK");
    expect(new Date(row.promotionReviewAt!).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("rejectSkillPromotion 后 reflective 反馈带 signature；下次 promoter 跳过", async () => {
    const p = new SkillPromoter();
    const r = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });
    const promotedId = r.actions.find((a) => a.status === "promoted")!.promotedSkillId!;
    const rej = await rejectSkillPromotion(promotedId, { actor: "user", reason: "签名过于宽泛" });
    expect(rej.nextState).toBe("archived");
    expect(rej.signature).toBe(fixture.goodSig);

    const store = getExperienceStore();
    const reflects = await store.query({
      kind: "reflective",
      subKind: "skill_reject_feedback",
      scope: "project",
      scopeId: fixture.projectId,
      archivalMode: "all",
      limit: 10,
    });
    expect(reflects.length).toBe(1);
    expect(reflects[0]!.metadataJson.signature).toBe(fixture.goodSig);
  });

  test("emitMetrics=true：触发 maintenance_run/skill_promoter event", async () => {
    const captured: { kind: string; summary: Record<string, unknown> }[] = [];
    const handlers = new Set<(ev: { kind: string; summary: Record<string, number | string> }) => void>();
    const bus: ExperienceBus = {
      emit: (ev) => {
        if (ev.type === "maintenance_run") {
          for (const h of handlers) h(ev);
        }
      },
      subscribe: (_type, handler) => {
        const h = handler as unknown as (ev: { kind: string; summary: Record<string, number | string> }) => void;
        handlers.add(h);
        return () => handlers.delete(h);
      },
      handlerCount: () => handlers.size,
      clearAllForTesting: () => handlers.clear(),
    };
    bus.subscribe("maintenance_run", (ev) => {
      captured.push({ kind: ev.kind, summary: ev.summary });
    });
    const p = new SkillPromoter({ bus });
    await p.runOnce({ projectId: fixture.projectId, mode: "dry_run", emitMetrics: true });
    await new Promise((r) => setTimeout(r, 10));
    const evs = captured.filter((e) => e.kind === "skill_promoter");
    expect(evs.length).toBe(1);
    expect(Number(evs[0]!.summary.scanned)).toBe(2);
    expect(Number(evs[0]!.summary.qualified)).toBe(1);
    expect(String(evs[0]!.summary.mode)).toBe("dry_run");
  });

  test("写 skill_promotion_run 一行，actionsJson 含每候选明细", async () => {
    const p = new SkillPromoter();
    const r = await p.runOnce({ projectId: fixture.projectId, mode: "live", emitMetrics: false });

    const db = await getDb();
    const [run] = await db
      .select()
      .from(skillPromotionRunTable)
      .where(eq(skillPromotionRunTable.id, r.runId));
    expect(run.status).toBe("completed");
    expect(run.totalScanned).toBe(2);
    expect(run.totalQualified).toBe(1);
    expect(run.totalPromoted).toBe(1);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(0);
    const actions = run.actionsJson as Array<{ signature: string; status: string }>;
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThanOrEqual(2);
  });
});

afterAll(async () => {
  // cleanup
  const db = await getDb();
  await db.delete(skillPromotionRunTable).where(eq(skillPromotionRunTable.projectId, fixture.projectId));
  await db.delete(agentSkillTable).where(eq(agentSkillTable.projectId, fixture.projectId));
});
