/**
 * P7 后端路由集成测：
 *   GET   /api/v1/monitor/memory/tool-gaps?projectId=&status=&kind=
 *   GET   /api/v1/monitor/memory/tool-gaps/runs?projectId=
 *   POST  /api/v1/monitor/memory/tool-gaps/:id/wont-fix    body={reason?}
 *   POST  /api/v1/monitor/memory/tool-gaps/:id/reopen      body={reason?}
 *   POST  /api/v1/monitor/memory/tool-gaps/report          body={projectId,...}
 *
 * Fixture：1 project + 跑一次 watcher 生成一条 open gap → 验列表 / 跑批 / 流转 / report 上报。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { config } from "../config";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  project,
  sandboxPolicy,
  toolCallLog,
  toolGapLog,
  workflowRun,
  workspace,
} from "../db/sqlite/schema";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

let app: { request: (req: Request) => Promise<Response> };
let projectId = "";
let workspaceId = "";
let definitionId = "";
let workflowRunId = "";
let agentStepId = "";
let openGapId = "";

beforeAll(async () => {
  // config 是 import-time singleton；本地 ~/.quant-agent core.sqlite 可能残留
  // 历史 __drizzle_migrations 行（开发期会跑 N 次 migration），与最新 journal 漂移。
  // 用 monkey-patch 把 config.dataDir 切到 unique tmp dir，再 closeDb 让 client 重建。
  const tmp = join("/tmp", `qubit-p7-routes-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
  const server = await import("../server");
  app = server.app;

  const db = await getDb();
  workspaceId = `ws_${randomUUID()}`;
  projectId = `prj_${randomUUID()}`;
  definitionId = `def_${randomUUID()}`;
  workflowRunId = `wf_${randomUUID()}`;
  agentStepId = `step_${randomUUID()}`;
  const instId = `inst_${randomUUID()}`;
  const polId = `pol_${randomUUID()}`;

  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "p", marketScope: "US" })
    .run();
  await db.insert(sandboxPolicy).values({ id: polId, name: "permissive" }).run();
  await db
    .insert(agentDefinition)
    .values({
      id: definitionId,
      role: "research",
      name: "a",
      systemPrompt: "x",
      llmProvider: "mock",
      sandboxPolicyId: polId,
    })
    .run();
  await db
    .insert(workflowRun)
    .values({ id: workflowRunId, projectId, goal: "g", mode: "research" })
    .run();
  await db
    .insert(agentInstance)
    .values({ id: instId, definitionId, workflowRunId })
    .run();
  await db
    .insert(agentStep)
    .values({
      id: agentStepId,
      agentInstanceId: instId,
      workflowRunId,
      stepIndex: 0,
      phase: "act",
      actionType: "tool_call",
      actionJson: {},
    })
    .run();

  // 1 条 unknown_tool 错误
  await db
    .insert(toolCallLog)
    .values({
      id: `tcl_${randomUUID()}`,
      agentStepId,
      workflowRunId,
      traceId: randomUUID(),
      retryCount: 0,
      toolName: "get_weather",
      toolKind: "builtin",
      requestJson: { reasonText: "x" },
      responseJson: null,
      status: "error",
      latencyMs: 5,
      errorMessage: "unknown tool: get_weather",
    })
    .run();

  // 跑一次 watcher 让 tool_gap_log 有 1 行
  const { ToolGapWatcher } = await import("../runtime/tool-gap-watcher/watcher");
  const w = new ToolGapWatcher();
  const r = await w.runOnce({ projectId, emitMetrics: false });
  if (r.gapsCreated !== 1) throw new Error(`fixture: expected 1 gap, got ${r.gapsCreated}`);
  const row = (
    await db
      .select()
      .from(toolGapLog)
      .where(and(eq(toolGapLog.projectId, projectId), eq(toolGapLog.gapSignature, "tool:get_weather")))
  )[0]!;
  openGapId = row.id;
});

describe("GET /api/v1/monitor/memory/tool-gaps", () => {
  test("缺 projectId → 400", async () => {
    const res = await app.request(new Request("http://t/api/v1/monitor/memory/tool-gaps"));
    expect(res.status).toBe(400);
  });

  test("默认 status=open → 1 行", async () => {
    const res = await app.request(
      new Request(`http://t/api/v1/monitor/memory/tool-gaps?projectId=${projectId}`)
    );
    expect(res.status).toBe(200);
    const data = (await jsonOf(res)).data as { items: Array<Record<string, unknown>> };
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    const found = data.items.find((r) => r.gapSignature === "tool:get_weather");
    expect(found).toBeTruthy();
    expect(found!.status).toBe("open");
    expect(found!.detectionKind).toBe("unknown_tool");
  });

  test("kind=reflective_mention 过滤 → 列表空（fixture 中无）", async () => {
    const res = await app.request(
      new Request(
        `http://t/api/v1/monitor/memory/tool-gaps?projectId=${projectId}&kind=reflective_mention`
      )
    );
    expect(res.status).toBe(200);
    const data = (await jsonOf(res)).data as { items: unknown[] };
    expect(data.items.length).toBe(0);
  });

  test("非法 status → 400", async () => {
    const res = await app.request(
      new Request(
        `http://t/api/v1/monitor/memory/tool-gaps?projectId=${projectId}&status=banana`
      )
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/monitor/memory/tool-gaps/runs", () => {
  test("返回 1 行（fixture 跑过 watcher）", async () => {
    const res = await app.request(
      new Request(`http://t/api/v1/monitor/memory/tool-gaps/runs?projectId=${projectId}`)
    );
    const data = (await jsonOf(res)).data as { items: Array<Record<string, unknown>> };
    expect(data.items.length).toBeGreaterThanOrEqual(1);
    const r = data.items[0]!;
    expect(r.status).toBe("completed");
    expect(r.gapsCreated).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/v1/monitor/memory/tool-gaps/:id/wont-fix → reopen", () => {
  test("open → wont_fix；再 reopen → open", async () => {
    // wont-fix
    const wf = await app.request(
      new Request(`http://t/api/v1/monitor/memory/tool-gaps/${openGapId}/wont-fix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "demo close", actor: "tester" }),
      })
    );
    expect(wf.status).toBe(200);
    const wfData = (await jsonOf(wf)).data as { prevStatus: string; nextStatus: string };
    expect(wfData.prevStatus).toBe("open");
    expect(wfData.nextStatus).toBe("wont_fix");

    // reopen
    const reop = await app.request(
      new Request(`http://t/api/v1/monitor/memory/tool-gaps/${openGapId}/reopen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "we'll handle it" }),
      })
    );
    expect(reop.status).toBe(200);
    const reopData = (await jsonOf(reop)).data as { prevStatus: string; nextStatus: string };
    expect(reopData.prevStatus).toBe("wont_fix");
    expect(reopData.nextStatus).toBe("open");
  });

  test("不存在的 id → 404", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/monitor/memory/tool-gaps/no_such/wont-fix", {
        method: "POST",
        body: "{}",
      })
    );
    expect(res.status).toBe(404);
  });

  test("已 open 不能再 reopen → 400", async () => {
    const res = await app.request(
      new Request(`http://t/api/v1/monitor/memory/tool-gaps/${openGapId}/reopen`, {
        method: "POST",
        body: "{}",
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/monitor/memory/tool-gaps/report", () => {
  test("toolName → 创建", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/monitor/memory/tool-gaps/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          toolName: "fetch_options_iv",
          reason: "需要期权 IV",
        }),
      })
    );
    expect(res.status).toBe(200);
    const d = (await jsonOf(res)).data as { action: string; signature: string };
    expect(d.signature).toBe("tool:fetch_options_iv");
    expect(["created", "incremented"]).toContain(d.action);
  });

  test("缺 projectId → 400", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/monitor/memory/tool-gaps/report", {
        method: "POST",
        body: JSON.stringify({ toolName: "x" }),
      })
    );
    expect(res.status).toBe(400);
  });

  test("既无 signature / toolName / reason → 400", async () => {
    const res = await app.request(
      new Request("http://t/api/v1/monitor/memory/tool-gaps/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId }),
      })
    );
    expect(res.status).toBe(400);
  });
});
