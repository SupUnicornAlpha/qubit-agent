import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  chatSession,
  project,
  researchTeamInteraction,
  workflowRun,
  workspace,
} from "../db/sqlite/schema";
import {
  completeWorkflowConversationAssistant,
  projectWorkflowUserMessage,
} from "../runtime/conversation/conversation-projection";
import { projectWorkflowFinalAnswer } from "../runtime/research-team/interaction-log";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("api minimal integration", () => {
  let app: { request: (req: Request) => Promise<Response> };
  let workspaceId = "";
  let projectId = "";
  let sessionId = "";

  beforeAll(async () => {
    const testHome = `${process.cwd()}/.tmp-test-home`;
    await rm(testHome, { recursive: true, force: true });
    await mkdir(testHome, { recursive: true });
    process.env.HOME = testHome;
    closeDb();
    await runMigrations();
    const server = await import("../server");
    app = server.app;
  });

  test("chat: create session and patch message", async () => {
    const wsRes = await app.request(
      new Request("http://test/api/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `ws-${Date.now()}`, owner: "test" }),
      })
    );
    expect(wsRes.status).toBe(201);
    const ws = await jsonOf(wsRes);
    workspaceId = ((ws.data as Record<string, unknown>).id as string) || "";

    const projectRes = await app.request(
      new Request(`http://test/api/v1/workspaces/${workspaceId}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "p", marketScope: "CN-A", status: "active" }),
      })
    );
    expect(projectRes.status).toBe(201);
    const project = await jsonOf(projectRes);
    projectId = ((project.data as Record<string, unknown>).id as string) || "";

    const sessionRes = await app.request(
      new Request("http://test/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, projectId, title: "s1" }),
      })
    );
    expect(sessionRes.status).toBe(201);
    const session = await jsonOf(sessionRes);
    sessionId = ((session.data as Record<string, unknown>).id as string) || "";

    const messageRes = await app.request(
      new Request(`http://test/api/v1/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "assistant", content: "", status: "running" }),
      })
    );
    expect(messageRes.status).toBe(201);
    const message = await jsonOf(messageRes);
    const messageId = ((message.data as Record<string, unknown>).id as string) || "";

    const patchRes = await app.request(
      new Request(`http://test/api/v1/chat/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello stream", status: "completed" }),
      })
    );
    expect(patchRes.status).toBe(200);
    const patched = await jsonOf(patchRes);
    expect((patched.data as Record<string, unknown>).content).toBe("hello stream");
  });

  test("chat: indicator strategy scripts", async () => {
    const post = await app.request(
      new Request(`http://test/api/v1/chat/sessions/${sessionId}/strategy-scripts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "demo-strat",
          ideCode: "def on_bar(b,c): return None",
          signalCode: "output={}",
          purpose: "both",
          chartSnapshotJson: { symbol: "TSLA", timeframe: "1d" },
        }),
      })
    );
    expect(post.status).toBe(201);
    const postJson = await jsonOf(post);
    const scriptId = (postJson.data as Record<string, unknown>).id as string;
    expect(scriptId.length).toBeGreaterThan(10);

    const list = await app.request(
      new Request(`http://test/api/v1/chat/sessions/${sessionId}/strategy-scripts`)
    );
    expect(list.status).toBe(200);
    const listJson = await jsonOf(list);
    const rows = listJson.data as unknown[];
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const patch = await app.request(
      new Request(`http://test/api/v1/chat/strategy-scripts/${scriptId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ideCode: "x=1" }),
      })
    );
    expect(patch.status).toBe(200);

    const del = await app.request(
      new Request(`http://test/api/v1/chat/strategy-scripts/${scriptId}`, { method: "DELETE" })
    );
    expect(del.status).toBe(200);
  });

  test("monitor: workflows filter and detail", async () => {
    const db = await getDb();
    const workflowId = crypto.randomUUID();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId,
      sessionId,
      goal: "test",
      mode: "research",
      source: "api",
      status: "completed",
    });

    const listRes = await app.request(
      new Request(`http://test/api/v1/monitor/workflows?sessionId=${sessionId}&status=completed`)
    );
    expect(listRes.status).toBe(200);
    const listJson = await jsonOf(listRes);
    expect(Array.isArray(listJson.data)).toBeTrue();

    const detailRes = await app.request(
      new Request(`http://test/api/v1/monitor/workflows/${workflowId}/detail`)
    );
    expect(detailRes.status).toBe(200);
    const detail = await jsonOf(detailRes);
    expect(((detail.data as Record<string, unknown>).workflow as Record<string, unknown>).id).toBe(
      workflowId
    );
  });

  test("workflow conversation projects into the same chat session", async () => {
    const db = await getDb();
    const workflowId = crypto.randomUUID();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId,
      sessionId,
      goal: "unified conversation",
      mode: "research",
      source: "manual",
      status: "running",
    });
    await projectWorkflowUserMessage({
      workflowRunId: workflowId,
      content: "按 SOP 分析这个标的",
    });
    await completeWorkflowConversationAssistant({
      workflowRunId: workflowId,
      content: "已完成证据验证。",
    });
    await projectWorkflowUserMessage({
      workflowRunId: workflowId,
      content: "按 SOP 分析这个标的",
    });
    await completeWorkflowConversationAssistant({
      workflowRunId: workflowId,
      content: "已按相同要求完成第二轮验证。",
    });

    const response = await app.request(
      new Request(`http://test/api/v1/chat/sessions/${sessionId}/messages`)
    );
    expect(response.status).toBe(200);
    const payload = await jsonOf(response);
    const messages = payload.data as Array<Record<string, unknown>>;
    const workflowMessages = messages.filter((message) =>
      (message.workflowRunIds as string[] | undefined)?.includes(workflowId)
    );
    expect(workflowMessages.map((message) => message.content)).toEqual([
      "按 SOP 分析这个标的",
      "已完成证据验证。",
      "按 SOP 分析这个标的",
      "已按相同要求完成第二轮验证。",
    ]);
  });

  test("orchestrator final answers are idempotent per conversation turn", async () => {
    const db = await getDb();
    const testWorkspaceId = workspaceId || crypto.randomUUID();
    const testProjectId = projectId || crypto.randomUUID();
    const testSessionId = sessionId || crypto.randomUUID();
    if (!workspaceId) {
      await db.insert(workspace).values({
        id: testWorkspaceId,
        name: "projection-test",
        owner: "test",
      });
      await db.insert(project).values({
        id: testProjectId,
        workspaceId: testWorkspaceId,
        name: "projection-test",
        marketScope: "US",
      });
      await db.insert(chatSession).values({
        id: testSessionId,
        workspaceId: testWorkspaceId,
        projectId: testProjectId,
        title: "projection-test",
      });
    }
    const workflowId = crypto.randomUUID();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId: testProjectId,
      sessionId: testSessionId,
      goal: "multi-turn orchestrator chat",
      mode: "research",
      source: "chat",
      status: "running",
    });

    expect(
      await projectWorkflowFinalAnswer({
        workflowRunId: workflowId,
        conversationTurnId: "turn-1",
        contentText: "第一轮分析结论",
        sourceTaskType: "orchestrator_chat",
      })
    ).toBeTrue();
    expect(
      await projectWorkflowFinalAnswer({
        workflowRunId: workflowId,
        conversationTurnId: "turn-2",
        contentText: "第二轮分析结论",
        sourceTaskType: "orchestrator_chat",
      })
    ).toBeTrue();
    expect(
      await projectWorkflowFinalAnswer({
        workflowRunId: workflowId,
        conversationTurnId: "turn-2",
        contentText: "第二轮分析结论",
        sourceTaskType: "orchestrator_chat",
      })
    ).toBeFalse();

    const rows = await db
      .select()
      .from(researchTeamInteraction)
      .where(eq(researchTeamInteraction.workflowRunId, workflowId));
    expect(rows.map((row) => row.contentText)).toEqual(["第一轮分析结论", "第二轮分析结论"]);
    expect(
      rows.map(
        (row) => (row.payloadJson as Record<string, unknown> | null)?.conversationTurnId ?? null
      )
    ).toEqual(["turn-1", "turn-2"]);
  });

  test("monitor: summary endpoint", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/summary?sessionId=${sessionId}`)
    );
    expect(res.status).toBe(200);
    const json = await jsonOf(res);
    expect(json.ok).toBe(true);
    const data = json.data as Record<string, unknown>;
    expect(typeof data.workflowTotal).toBe("number");
    expect(typeof data.openAlerts).toBe("number");
  });

  test("telegram webhook: reject bad secret and skip non-text", async () => {
    process.env.QUBIT_TELEGRAM_WEBHOOK_SECRET = "secret";
    const unauthorized = await app.request(
      new Request("http://test/api/v1/integrations/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "bad" },
        body: JSON.stringify({ message: { text: "hello", chat: { id: 1 } } }),
      })
    );
    expect(unauthorized.status).toBe(401);

    const skip = await app.request(
      new Request("http://test/api/v1/integrations/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret",
        },
        body: JSON.stringify({ update_id: 1 }),
      })
    );
    expect(skip.status).toBe(200);
    const payload = await jsonOf(skip);
    expect(payload.ok).toBe(true);
  });

  test("chat health", async () => {
    const res = await app.request(new Request("http://test/api/v1/chat/health"));
    expect(res.status).toBe(200);
    const payload = await jsonOf(res);
    expect(payload.ok).toBe(true);
  });

  test("integrations: catalog lists all IM kinds", async () => {
    const res = await app.request(new Request("http://test/api/v1/integrations/catalog"));
    expect(res.status).toBe(200);
    const payload = await jsonOf(res);
    expect(payload.ok).toBe(true);
    const kinds = (payload.data as Array<{ kind: string }>).map((row) => row.kind);
    for (const required of ["telegram", "feishu", "wecom", "whatsapp", "dingtalk", "webhook"]) {
      expect(kinds).toContain(required);
    }
  });

  test("integrations: rejects unsupported kind on upsert", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/integrations/channels/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          kind: "not_a_real_kind",
          name: "x",
          externalChatId: "x",
        }),
      })
    );
    expect(res.status).toBe(400);
  });

  test("integrations: upsert/list/delete generic webhook channel", async () => {
    const created = await app.request(
      new Request("http://test/api/v1/integrations/channels/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          projectId,
          kind: "webhook",
          name: "ci-webhook",
          externalChatId: "https://example.com/sink",
          secretRef: "",
          metaJson: { url: "https://example.com/sink" },
          enabled: true,
        }),
      })
    );
    expect(created.status).toBe(200);
    const createdPayload = await jsonOf(created);
    expect(createdPayload.ok).toBe(true);
    const channel = createdPayload.data as { id: string; metaJson: Record<string, unknown> };
    expect(typeof channel.id).toBe("string");
    expect(channel.metaJson.url).toBe("https://example.com/sink");

    const list = await app.request(
      new Request("http://test/api/v1/integrations/channels?kind=webhook")
    );
    expect(list.status).toBe(200);
    const listPayload = await jsonOf(list);
    const rows = listPayload.data as Array<{ id: string }>;
    expect(rows.some((row) => row.id === channel.id)).toBe(true);

    const removed = await app.request(
      new Request(`http://test/api/v1/integrations/channels/${channel.id}`, { method: "DELETE" })
    );
    expect(removed.status).toBe(200);
  });

  test("workflow: hard delete cascades through derived rows", async () => {
    const db = await getDb();
    const wfId = crypto.randomUUID();
    await db.insert(workflowRun).values({
      id: wfId,
      projectId,
      sessionId,
      goal: "to-be-hard-deleted",
      mode: "research",
      source: "api",
      status: "completed",
    });

    // 写入一些常见的衍生数据（workflow_compensation_task 只依赖 workflow_run_id），验证级联清理。
    const { workflowCompensationTask } = await import("../db/sqlite/schema");
    await db.insert(workflowCompensationTask).values({
      id: crypto.randomUUID(),
      workflowRunId: wfId,
      actionType: "retry_from_start",
      reason: "test",
    });

    // 软删除（默认）
    const softRes = await app.request(
      new Request(`http://test/api/v1/workflows/${wfId}`, { method: "DELETE" })
    );
    expect(softRes.status).toBe(200);
    const softJson = await jsonOf(softRes);
    expect(softJson.hard).toBe(false);
    // 软删除后行还在
    const stillExists = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, wfId))
      .limit(1);
    expect(stillExists.length).toBe(1);

    // 硬删除
    const hardRes = await app.request(
      new Request(`http://test/api/v1/workflows/${wfId}?hard=true`, { method: "DELETE" })
    );
    expect(hardRes.status).toBe(200);
    const hardJson = await jsonOf(hardRes);
    expect(hardJson.hard).toBe(true);
    const details = (hardJson.details ?? {}) as Record<string, number>;
    expect(details.workflow_run).toBe(1);
    expect(details.workflow_compensation_task).toBeGreaterThanOrEqual(1);
    const gone = await db.select().from(workflowRun).where(eq(workflowRun.id, wfId)).limit(1);
    expect(gone.length).toBe(0);
  });

  test("chat session: hard delete removes session + workflows + messages", async () => {
    // 创建独立会话与挂载工作流/消息
    const sessRes = await app.request(
      new Request("http://test/api/v1/chat/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, projectId, title: "to-be-deleted" }),
      })
    );
    expect(sessRes.status).toBe(201);
    const sessJson = await jsonOf(sessRes);
    const sessId = ((sessJson.data as Record<string, unknown>).id as string) ?? "";

    const db = await getDb();
    const wfId = crypto.randomUUID();
    await db.insert(workflowRun).values({
      id: wfId,
      projectId,
      sessionId: sessId,
      goal: "session-hard-delete",
      mode: "research",
      source: "chat",
      status: "completed",
    });

    const msgRes = await app.request(
      new Request(`http://test/api/v1/chat/sessions/${sessId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "user", content: "hi", status: "completed" }),
      })
    );
    expect(msgRes.status).toBe(201);

    const del = await app.request(
      new Request(`http://test/api/v1/chat/sessions/${sessId}?hard=true`, { method: "DELETE" })
    );
    expect(del.status).toBe(200);
    const delJson = await jsonOf(del);
    expect(delJson.hard).toBe(true);
    expect((delJson.workflowRunIds as string[]).length).toBeGreaterThanOrEqual(1);

    // 验证会话/工作流/消息都没了
    const { chatSession: chatSessionTable, chatMessage } = await import("../db/sqlite/schema");
    const s = await db
      .select()
      .from(chatSessionTable)
      .where(eq(chatSessionTable.id, sessId))
      .limit(1);
    expect(s.length).toBe(0);
    const w = await db.select().from(workflowRun).where(eq(workflowRun.id, wfId)).limit(1);
    expect(w.length).toBe(0);
    const m = await db.select().from(chatMessage).where(eq(chatMessage.sessionId, sessId));
    expect(m.length).toBe(0);
  });

  test("monitor: workflows list respects limit/filter and excludes cancelled", async () => {
    // 创建一个 cancelled、一个 completed
    const db = await getDb();
    const wfA = crypto.randomUUID();
    const wfB = crypto.randomUUID();
    await db.insert(workflowRun).values([
      {
        id: wfA,
        projectId,
        sessionId,
        goal: "perf-A",
        mode: "research",
        source: "api",
        status: "cancelled",
      },
      {
        id: wfB,
        projectId,
        sessionId,
        goal: "perf-B",
        mode: "research",
        source: "api",
        status: "completed",
      },
    ]);

    const res = await app.request(
      new Request(`http://test/api/v1/monitor/workflows?sessionId=${sessionId}&limit=10`)
    );
    expect(res.status).toBe(200);
    const json = await jsonOf(res);
    const rows = json.data as Array<{ id: string; status: string; goal: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status !== "cancelled")).toBe(true);
    expect(rows.some((r) => r.id === wfB)).toBe(true);
    expect(rows.some((r) => r.id === wfA)).toBe(false);

    // includeCancelled=true 时能看到
    const allRes = await app.request(
      new Request(
        `http://test/api/v1/monitor/workflows?sessionId=${sessionId}&includeCancelled=true&limit=10`
      )
    );
    expect(allRes.status).toBe(200);
    const allRows = ((await jsonOf(allRes)).data as Array<{ id: string }>) ?? [];
    expect(allRows.some((r) => r.id === wfA)).toBe(true);
  });

  test("integrations: feishu webhook responds to url_verification challenge", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/integrations/feishu/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "abc-xyz" }),
      })
    );
    expect(res.status).toBe(200);
    const payload = await jsonOf(res);
    expect(payload.challenge).toBe("abc-xyz");
  });

  test("market: klines returns OHLCV array", async () => {
    const bad = await app.request(new Request("http://test/api/v1/market/klines"));
    expect(bad.status).toBe(400);

    const res = await app.request(
      new Request(
        "http://test/api/v1/market/klines?symbol=600000&exchange=SH&timeframe=1d&limit=10"
      )
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const bars = body.data as Record<string, unknown>[];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.length).toBeLessThanOrEqual(10);
    const b0 = bars[0] as Record<string, unknown>;
    expect(typeof b0.open).toBe("number");
    expect(typeof b0.high).toBe("number");
    expect(typeof b0.low).toBe("number");
    expect(typeof b0.close).toBe("number");
    expect(typeof b0.volume).toBe("number");
    expect(typeof b0.timestamp).toBe("string");
    const meta = body.meta as Record<string, unknown>;
    expect(meta.timeframe).toBe("1d");
    expect(meta.period).toBe("1d");
    expect(["tushare_daily", "synthetic", "yahoo_chart", "eastmoney", "akshare"]).toContain(
      meta.dataSource
    );
  });

  test("market: klines intraday resolves to Yahoo chart source", async () => {
    const res = await app.request(
      new Request("http://test/api/v1/market/klines?symbol=AAPL&exchange=US&timeframe=5m&limit=20")
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    const meta = body.meta as Record<string, unknown>;
    expect(meta.period).toBe("5m");
    expect(meta.dataSource).toBe("yahoo_chart");
  });

  test("agents: agent-groups routes are decommissioned", async () => {
    const listRes = await app.request(new Request("http://test/api/v1/agents/agent-groups"));
    expect(listRes.status).toBe(410);
    const listJson = await jsonOf(listRes);
    expect(listJson.ok).toBe(false);

    const createRes = await app.request(
      new Request("http://test/api/v1/agents/agent-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `g-${Date.now()}`, description: "integration" }),
      })
    );
    expect(createRes.status).toBe(410);

    const detailRes = await app.request(
      new Request("http://test/api/v1/agents/agent-groups/decommissioned")
    );
    expect(detailRes.status).toBe(410);
    const detailJson = await jsonOf(detailRes);
    expect(detailJson.ok).toBe(false);
  });

  test("reia: broker account upsert and health-check (mock)", async () => {
    const upsertRes = await app.request(
      new Request("http://test/api/v1/reia/broker/accounts/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "futu",
          accountRef: "test-default",
          mode: "mock",
          isDefault: true,
          providerConfig: { opendHost: "127.0.0.1", opendPort: 11111, market: "HK" },
        }),
      })
    );
    expect(upsertRes.status).toBe(200);
    const upsertJson = await jsonOf(upsertRes);
    expect(upsertJson.ok).toBe(true);
    const acc = upsertJson.data as Record<string, unknown>;
    expect(acc.provider).toBe("futu");
    expect(acc.accountRef).toBe("test-default");

    const healthRes = await app.request(
      new Request("http://test/api/v1/reia/broker/health-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "futu", accountRef: "test-default" }),
      })
    );
    expect(healthRes.status).toBe(200);
    const healthJson = await jsonOf(healthRes);
    expect(healthJson.ok).toBe(true);
    const health = healthJson.data as Record<string, unknown>;
    expect(health.status).toBe("healthy");
  });
});
