import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { runMigrations } from "../db/sqlite/migrate";
import { closeDb, getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";

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

    const list = await app.request(new Request(`http://test/api/v1/chat/sessions/${sessionId}/strategy-scripts`));
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

    const del = await app.request(new Request(`http://test/api/v1/chat/strategy-scripts/${scriptId}`, { method: "DELETE" }));
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

    const detailRes = await app.request(new Request(`http://test/api/v1/monitor/workflows/${workflowId}/detail`));
    expect(detailRes.status).toBe(200);
    const detail = await jsonOf(detailRes);
    expect(((detail.data as Record<string, unknown>).workflow as Record<string, unknown>).id).toBe(workflowId);
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
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "secret" },
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

  test("market: klines returns OHLCV array", async () => {
    const bad = await app.request(new Request("http://test/api/v1/market/klines"));
    expect(bad.status).toBe(400);

    const res = await app.request(
      new Request("http://test/api/v1/market/klines?symbol=600000&exchange=SH&timeframe=1d&limit=10")
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

  test("agents: agent-groups list and create", async () => {
    const listRes = await app.request(new Request("http://test/api/v1/agents/agent-groups"));
    expect(listRes.status).toBe(200);
    const listJson = await jsonOf(listRes);
    expect(Array.isArray(listJson.data)).toBeTrue();

    const createRes = await app.request(
      new Request("http://test/api/v1/agents/agent-groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `g-${Date.now()}`, description: "integration" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await jsonOf(createRes);
    const gid = String((created.data as Record<string, unknown>).id ?? "");
    expect(gid.length).toBeGreaterThan(4);

    const detailRes = await app.request(new Request(`http://test/api/v1/agents/agent-groups/${gid}`));
    expect(detailRes.status).toBe(200);
    const detailJson = await jsonOf(detailRes);
    const data = detailJson.data as Record<string, unknown>;
    expect(Array.isArray(data.members)).toBeTrue();
    expect((data.members as unknown[]).length).toBe(0);
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
