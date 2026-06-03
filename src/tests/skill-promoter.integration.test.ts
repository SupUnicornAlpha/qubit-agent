/**
 * P5 后端路由集成测：
 *   GET  /api/v1/monitor/memory/skill-promotions?projectId=&state=         — 列表
 *   GET  /api/v1/monitor/memory/skill-promotions/runs?projectId=&limit=    — 跑批 summary
 *   POST /api/v1/monitor/memory/skill-promotions/:skillId/approve          — pending_review → active
 *   POST /api/v1/monitor/memory/skill-promotions/:skillId/reject           — pending_review → archived
 *
 * Fixture：1 project + 1 procedural workflow_play experience（合格）；跑一次 SkillPromoter
 * 落 pending_review；前端走 4 个端点验。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import { agentSkill, project, workspace } from "../db/sqlite/schema";
import { eq } from "drizzle-orm";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

let app: { request: (req: Request) => Promise<Response> };
let projectId = "";
let workspaceId = "";

beforeAll(async () => {
  // 2026-06-03 P7：同 P6 修法。config 是 singleton；monkey-patch dataDir 到 tmp。
  const tmp = join("/tmp", `qubit-p5-routes-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
  const server = await import("../server");
  app = server.app;

  const db = await getDb();
  workspaceId = `ws_${randomUUID()}`;
  projectId = `prj_${randomUUID()}`;
  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "p", marketScope: "US" })
    .run();

  // 一条合格 procedural experience
  const { getExperienceStore } = await import("../runtime/experience/experience-store");
  const store = getExperienceStore();
  const exp = await store.insert({
    kind: "procedural",
    subKind: "workflow_play",
    scope: "project",
    scopeId: projectId,
    definitionId: null,
    visibility: "project_shared",
    contentJson: {
      summary: "auto-play(analyst): scan → fundamental → news",
      body: "1. scan\n2. fundamental\n3. news\n",
    },
    tagsJson: ["rule:R2"],
    metadataJson: { signature: "scan>fundamental>news" },
    validFrom: new Date().toISOString(),
    qualityScore: 0.8,
  });
  await store.update(exp.id, { useCount: 8, successCount: 6, failCount: 1 });

  // 跑一次 live 让 pending_review 落库
  const { SkillPromoter } = await import("../runtime/skill-promoter/skill-promoter");
  const promoter = new SkillPromoter();
  const r = await promoter.runOnce({
    projectId,
    mode: "live",
    triggeredBy: "test",
    emitMetrics: false,
  });
  if (r.totalPromoted !== 1) {
    throw new Error(`fixture setup failed: expected 1 promoted, got ${r.totalPromoted}`);
  }
});

describe("GET /api/v1/monitor/memory/skill-promotions", () => {
  test("缺 projectId → 400", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-promotions")
    );
    expect(res.status).toBe(400);
  });

  test("默认 state=pending_review 列出候选", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-promotions?projectId=${projectId}`)
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    const data = j.data as { items: Array<Record<string, unknown>>; total: number };
    expect(data.total).toBe(1);
    const item = data.items[0];
    if (!item) throw new Error("missing item");
    expect(item.state).toBe("pending_review");
    expect(typeof item.promotionScore).toBe("number");
    expect((item.promotionScore as number) > 0).toBe(true);
  });

  test("state=all 列全部状态", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/memory/skill-promotions?projectId=${projectId}&state=all`
      )
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    const data = j.data as { items: unknown[] };
    expect(data.items.length).toBeGreaterThanOrEqual(1);
  });

  test("非法 state → 400", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/memory/skill-promotions?projectId=${projectId}&state=banana`
      )
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/monitor/memory/skill-promotions/runs", () => {
  test("列最近 N 次跑批 summary", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-promotions/runs?projectId=${projectId}`)
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    const data = j.data as { items: Array<Record<string, unknown>> };
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    const run = data.items[0];
    if (!run) throw new Error("missing run");
    expect(run.status).toBe("completed");
    expect(run.mode).toBe("live");
    expect(run.totalPromoted).toBe(1);
  });

  test("缺 projectId → 400", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-promotions/runs")
    );
    expect(res.status).toBe(400);
  });
});

describe("POST approve/reject", () => {
  async function findPendingSkillId(): Promise<string | null> {
    const db = await getDb();
    const rows = await db
      .select({ id: agentSkill.id })
      .from(agentSkill)
      .where(eq(agentSkill.projectId, projectId));
    const pending = rows[0];
    return pending?.id ?? null;
  }

  test("approve：state → active", async () => {
    const skillId = await findPendingSkillId();
    if (!skillId) throw new Error("expected promoted skill");
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-promotions/${skillId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "通过 — 测试" }),
      })
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    const data = j.data as { nextState: string; prevState: string };
    expect(data.nextState).toBe("active");
    expect(data.prevState).toBe("pending_review");
  });

  test("approve 已 active → 400", async () => {
    const skillId = await findPendingSkillId();
    if (!skillId) throw new Error("expected promoted skill");
    // 上一个测试已经把它 approve 了
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-promotions/${skillId}/approve`, {
        method: "POST",
      })
    );
    expect(res.status).toBe(400);
  });

  test("不存在的 skillId reject → 400", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-promotions/sk_does_not_exist/reject`, {
        method: "POST",
      })
    );
    expect(res.status).toBe(400);
  });
});
