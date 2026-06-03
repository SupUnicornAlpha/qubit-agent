/**
 * P6 后端路由集成测：
 *   GET  /api/v1/monitor/memory/skill-evolutions/runs?projectId=&limit=
 *   GET  /api/v1/monitor/memory/skill-evolutions/diff?skillId=
 *   POST /api/v1/monitor/memory/skill-evolutions/request body={...}
 *
 * Fixture：1 project + 1 base agent_skill + 1 evolved child skill（parentSkillId=base，state=pending_review）
 * 不真跑 SkillEvolver（避免 LLM 依赖），直接 seed 落库验路由读路径；POST 验请求会写入 reflective。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  agentSkill as agentSkillTable,
  experience as experienceTable,
  project,
  skillEvolutionRun,
  workspace,
} from "../db/sqlite/schema";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

let app: { request: (req: Request) => Promise<Response> };
let projectId = "";
let workspaceId = "";
let baseSkillId = "";
let evolvedSkillId = "";

beforeAll(async () => {
  const testHome = `${process.cwd()}/.tmp-test-home-p6`;
  await rm(testHome, { recursive: true, force: true });
  await mkdir(testHome, { recursive: true });
  process.env.HOME = testHome;
  process.env.QUBIT_DATA_DIR = testHome;
  closeDb();
  await runMigrations();
  const server = await import("../server");
  app = server.app;

  const db = await getDb();
  workspaceId = `ws_${randomUUID()}`;
  projectId = `prj_${randomUUID()}`;
  baseSkillId = `skill_${randomUUID()}`;
  evolvedSkillId = `skill_${randomUUID()}`;

  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "p", marketScope: "US" })
    .run();

  // base skill
  await db
    .insert(agentSkillTable)
    .values({
      id: baseSkillId,
      projectId,
      name: "base_skill_p6",
      description: "base skill for evolve",
      bodyMd: "## 步骤\n1. 调 tool A\n2. 调 tool B\n",
      state: "active",
      source: "user_authored",
    })
    .run();

  // evolved child skill（模拟 SkillEvolver 写出来的成果）
  await db
    .insert(agentSkillTable)
    .values({
      id: evolvedSkillId,
      projectId,
      name: "base_skill_p6-evo1",
      description: "(evolved from base_skill_p6) base skill for evolve",
      bodyMd:
        "## 步骤\n1. 调 tool A（带超时）\n2. 调 tool B\n3. 校验输出格式\n\n## 常见失败模式\n- tool A 超时 → 重试 1 次再 fallback\n",
      state: "pending_review",
      source: "evolved",
      parentSkillId: baseSkillId,
    })
    .run();

  // 一条 skill_evolution_run 模拟跑批
  await db
    .insert(skillEvolutionRun)
    .values({
      id: `run_${randomUUID()}`,
      projectId,
      baseSkillId,
      iterations: 3,
      candidatesEvaluated: 9,
      baselineScore: 0.5,
      bestScore: 0.75,
      winningSkillId: evolvedSkillId,
      status: "completed",
      triggeredBy: "test",
      endedAt: new Date().toISOString(),
    })
    .run();
});

describe("GET /api/v1/monitor/memory/skill-evolutions/runs", () => {
  test("缺 projectId → 400", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-evolutions/runs")
    );
    expect(res.status).toBe(400);
  });

  test("返回 skill_evolution_run 行（含 baselineScore / bestScore）", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-evolutions/runs?projectId=${projectId}`)
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    const data = body.data as { items: Array<Record<string, unknown>> };
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    const r = data.items[0]!;
    expect(r.baseSkillId).toBe(baseSkillId);
    expect(r.winningSkillId).toBe(evolvedSkillId);
    expect(r.status).toBe("completed");
    expect(typeof r.baselineScore).toBe("number");
    expect(typeof r.bestScore).toBe("number");
  });
});

describe("GET /api/v1/monitor/memory/skill-evolutions/diff", () => {
  test("缺 skillId → 400", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-evolutions/diff")
    );
    expect(res.status).toBe(400);
  });

  test("不存在 → 404", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-evolutions/diff?skillId=no_such")
    );
    expect(res.status).toBe(404);
  });

  test("evolved skill → 返回 child + parent bodyMd（供前端 diff）", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/memory/skill-evolutions/diff?skillId=${evolvedSkillId}`
      )
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const data = body.data as {
      child: Record<string, unknown>;
      parent: Record<string, unknown> | null;
    };
    expect(data.child.id).toBe(evolvedSkillId);
    expect(data.child.parentSkillId).toBe(baseSkillId);
    expect(data.child.source).toBe("evolved");
    expect(data.parent).toBeTruthy();
    expect(data.parent!.id).toBe(baseSkillId);
    expect(String(data.parent!.bodyMd)).toContain("调 tool A");
    expect(String(data.child.bodyMd)).toContain("常见失败模式");
  });

  test("非 evolved（无 parent）→ parent=null", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/memory/skill-evolutions/diff?skillId=${baseSkillId}`)
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const data = body.data as { child: Record<string, unknown>; parent: unknown };
    expect(data.child.id).toBe(baseSkillId);
    expect(data.parent).toBeNull();
  });
});

describe("POST /api/v1/monitor/memory/skill-evolutions/request", () => {
  test("缺 projectId / baseSkillId → 400", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-evolutions/request", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(400);
  });

  test("写入一条 reflective(skill_revision_request)；同 base 重复 → deduped", async () => {
    // 清掉历史 reflective request 防止跨用例干扰
    const db = await getDb();
    await db.delete(experienceTable).where(eq(experienceTable.scopeId, projectId));

    const res1 = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-evolutions/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          baseSkillId,
          reason: "前端手动触发",
          requestedBy: "api",
        }),
      })
    );
    expect(res1.status).toBe(200);
    const b1 = await jsonOf(res1);
    const d1 = b1.data as { status: string; experienceId: string };
    expect(d1.status).toBe("created");
    expect(d1.experienceId).toBeTruthy();

    const res2 = await app.request(
      new Request("http://test/api/v1/monitor/memory/skill-evolutions/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          baseSkillId,
          requestedBy: "api",
        }),
      })
    );
    expect(res2.status).toBe(200);
    const d2 = (await jsonOf(res2)).data as { status: string; experienceId: string };
    expect(d2.status).toBe("deduped");
    expect(d2.experienceId).toBe(d1.experienceId);
  });
});

describe("GET /api/v1/monitor/memory/skill-promotions（P6 字段增强）", () => {
  test("列表项包含 source + parentSkillId（用于前端区分 promoted vs evolved）", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/memory/skill-promotions?projectId=${projectId}&state=pending_review`
      )
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const data = body.data as { items: Array<Record<string, unknown>> };
    const evolved = data.items.find((r) => r.id === evolvedSkillId);
    expect(evolved).toBeTruthy();
    expect(evolved!.source).toBe("evolved");
    expect(evolved!.parentSkillId).toBe(baseSkillId);
  });
});
