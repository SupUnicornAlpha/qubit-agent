import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import {
  COMMUNICATION_CHANNEL_KINDS,
  type CommunicationChannelKind,
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  communicationChannel,
  communicationMessageLog,
  project,
  workflowRun,
  workspace,
} from "../db/sqlite/schema";
import { dispatchTaskToRole } from "../runtime/agent-pool";
import {
  getIntegrationAdapter,
  isSupportedIntegrationKind,
  listIntegrationAdapters,
  logInboundForChannel,
  parseInboundFor,
  sendByChannel,
} from "../runtime/integrations/dispatcher";

export const integrationsRouter = new Hono();

function bad(c: import("hono").Context, status: number, error: string) {
  // Hono 类型对 status 较严，使用 any 通道避免维护一个 ContentfulStatusCode union。
  return c.json({ ok: false, error }, status as any);
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** GET /catalog: 前端用来渲染 provider 选择控件。 */
integrationsRouter.get("/catalog", (c) => {
  return c.json({ ok: true, data: listIntegrationAdapters() });
});

/** GET /channels?kind=xxx */
integrationsRouter.get("/channels", async (c) => {
  const db = await getDb();
  const kind = c.req.query("kind") as CommunicationChannelKind | undefined;
  const rows = await db
    .select()
    .from(communicationChannel)
    .orderBy(desc(communicationChannel.updatedAt));
  const data = kind ? rows.filter((row) => row.kind === kind) : rows;
  return c.json({ ok: true, data });
});

/** POST /channels/upsert */
integrationsRouter.post("/channels/upsert", async (c) => {
  const body = await c.req.json<{
    id?: string;
    workspaceId?: string;
    projectId?: string | null;
    kind?: string;
    name?: string;
    externalChatId?: string;
    secretRef?: string;
    metaJson?: Record<string, unknown> | string | null;
    enabled?: boolean;
  }>();
  if (!body.workspaceId || !body.kind || !body.name || !body.externalChatId) {
    return bad(c, 400, "workspaceId/kind/name/externalChatId are required");
  }
  if (!isSupportedIntegrationKind(body.kind)) {
    return bad(
      c,
      400,
      `unsupported kind: ${body.kind}. allowed: ${COMMUNICATION_CHANNEL_KINDS.join(", ")}`
    );
  }
  const db = await getDb();
  const id = body.id ?? crypto.randomUUID();
  const existed = await db
    .select()
    .from(communicationChannel)
    .where(eq(communicationChannel.id, id))
    .limit(1);
  const meta = parseMeta(body.metaJson);
  if (existed[0]) {
    await db
      .update(communicationChannel)
      .set({
        projectId: body.projectId ?? existed[0].projectId,
        name: body.name,
        kind: body.kind,
        externalChatId: body.externalChatId,
        secretRef: body.secretRef ?? existed[0].secretRef,
        metaJson: meta as unknown as object,
        enabled: body.enabled ?? existed[0].enabled,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(communicationChannel.id, id));
  } else {
    await db.insert(communicationChannel).values({
      id,
      workspaceId: body.workspaceId,
      projectId: body.projectId ?? null,
      kind: body.kind,
      name: body.name,
      externalChatId: body.externalChatId,
      secretRef: body.secretRef ?? "",
      metaJson: meta as unknown as object,
      enabled: body.enabled ?? true,
    });
  }
  const row = await db
    .select()
    .from(communicationChannel)
    .where(eq(communicationChannel.id, id))
    .limit(1);
  return c.json({ ok: true, data: row[0] });
});

/** DELETE /channels/:id */
integrationsRouter.delete("/channels/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const existed = await db
    .select()
    .from(communicationChannel)
    .where(eq(communicationChannel.id, id))
    .limit(1);
  if (!existed[0]) return bad(c, 404, "channel not found");
  await db.delete(communicationChannel).where(eq(communicationChannel.id, id));
  return c.json({ ok: true, id });
});

/** POST /channels/:id/send */
integrationsRouter.post("/channels/:id/send", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req
    .json<{ text?: string; extra?: Record<string, unknown> }>()
    .catch(() => ({}))) as { text?: string; extra?: Record<string, unknown> };
  const text = (body.text ?? "").toString();
  if (!text.trim()) return bad(c, 400, "text is required");
  const db = await getDb();
  const rows = await db
    .select()
    .from(communicationChannel)
    .where(eq(communicationChannel.id, id))
    .limit(1);
  if (!rows[0]) return bad(c, 404, "channel not found");
  const result = await sendByChannel({
    channel: rows[0],
    text,
    ...(body.extra ? { extra: body.extra } : {}),
  });
  return c.json({ ok: result.ok, data: { ...result } }, (result.ok ? 200 : 502) as any);
});

/** GET /logs?kind=xxx&channelId=...&limit=... */
integrationsRouter.get("/logs", async (c) => {
  const db = await getDb();
  const kind = c.req.query("kind") as CommunicationChannelKind | undefined;
  const channelId = c.req.query("channelId") ?? undefined;
  const limit = Number(c.req.query("limit") ?? 100);
  const rows = await db
    .select()
    .from(communicationMessageLog)
    .orderBy(desc(communicationMessageLog.createdAt))
    .limit(Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100);
  const data = rows.filter((row) => {
    if (kind && row.channelKind !== kind) return false;
    if (channelId && row.channelId !== channelId) return false;
    return true;
  });
  return c.json({ ok: true, data });
});

// ─── Telegram (back-compat) ──────────────────────────────────────────────────

integrationsRouter.post("/telegram/send", async (c) => {
  const body = await c.req.json<{
    channelId?: string;
    chatId?: string;
    text?: string;
  }>();
  const text = (body.text ?? "").toString();
  if (!text.trim()) return bad(c, 400, "text is required");
  const db = await getDb();
  if (body.channelId) {
    const rows = await db
      .select()
      .from(communicationChannel)
      .where(
        and(eq(communicationChannel.id, body.channelId), eq(communicationChannel.kind, "telegram"))
      )
      .limit(1);
    if (!rows[0]) return bad(c, 404, "telegram channel not found");
    const result = await sendByChannel({ channel: rows[0], text });
    return c.json({ ok: result.ok, data: result.payload }, (result.ok ? 200 : 502) as any);
  }
  if (!body.chatId) return bad(c, 400, "missing chatId");
  const adapter = getIntegrationAdapter("telegram");
  const result = await adapter.send({
    ctx: {
      externalChatId: body.chatId,
      meta: {},
      secret: process.env.QUBIT_TELEGRAM_BOT_TOKEN ?? "",
    },
    text,
  });
  await db.insert(communicationMessageLog).values({
    id: crypto.randomUUID(),
    direction: "outbound",
    channelKind: "telegram",
    channelId: null,
    externalChatId: body.chatId,
    externalMessageId: result.externalMessageId ?? null,
    payloadJson: (result.payload ?? { text }) as unknown as object,
    status: result.ok ? "success" : "failed",
    errorMessage: result.ok ? null : (result.errorMessage ?? "send failed"),
  });
  return c.json({ ok: result.ok, data: result.payload }, (result.ok ? 200 : 502) as any);
});

// ─── 通用 webhook 入口：/:kind/webhook ───────────────────────────────────────
// 既支持 /telegram/webhook（保持向后兼容），也支持 feishu/wecom/whatsapp/dingtalk。

async function ensureWorkspaceProject(): Promise<{
  workspaceId: string;
  projectId?: string;
} | null> {
  const db = await getDb();
  const workspaceRows = await db
    .select()
    .from(workspace)
    .orderBy(desc(workspace.createdAt))
    .limit(1);
  if (!workspaceRows[0]) return null;
  const projectRows = await db
    .select()
    .from(project)
    .where(eq(project.workspaceId, workspaceRows[0].id))
    .orderBy(desc(project.createdAt))
    .limit(1);
  const out: { workspaceId: string; projectId?: string } = { workspaceId: workspaceRows[0].id };
  if (projectRows[0]?.id) out.projectId = projectRows[0].id;
  return out;
}

async function getOrCreateChannel(
  kind: CommunicationChannelKind,
  chatId: string,
  fallbackSecret = ""
): Promise<typeof communicationChannel.$inferSelect | null> {
  const db = await getDb();
  const existed = (
    await db
      .select()
      .from(communicationChannel)
      .where(
        and(eq(communicationChannel.kind, kind), eq(communicationChannel.externalChatId, chatId))
      )
      .limit(1)
  )[0];
  if (existed) return existed;
  const wp = await ensureWorkspaceProject();
  if (!wp) return null;
  const row: typeof communicationChannel.$inferSelect = {
    id: crypto.randomUUID(),
    workspaceId: wp.workspaceId,
    projectId: wp.projectId ?? null,
    kind,
    name: `${kind}-${chatId}`,
    externalChatId: chatId,
    secretRef: fallbackSecret,
    metaJson: {} as unknown as object,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await db.insert(communicationChannel).values(row);
  return row;
}

async function dispatchInboundAsResearch(
  channel: typeof communicationChannel.$inferSelect,
  text: string
): Promise<{ sessionId: string; workflowId: string; userMessageId: string } | { error: string }> {
  const db = await getDb();
  const projectId =
    channel.projectId ??
    (
      await db.select().from(project).where(eq(project.workspaceId, channel.workspaceId)).limit(1)
    )[0]?.id;
  if (!projectId) return { error: "no project available for channel" };
  let session = (
    await db
      .select()
      .from(chatSession)
      .where(
        and(eq(chatSession.workspaceId, channel.workspaceId), eq(chatSession.projectId, projectId))
      )
      .orderBy(desc(chatSession.lastActivityAt))
      .limit(1)
  )[0];
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      workspaceId: channel.workspaceId,
      projectId,
      title: `${channel.kind} ${channel.externalChatId}`,
      status: "active",
      lastActivityAt: new Date().toISOString(),
      createdBy: "system",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.insert(chatSession).values(session);
  }
  const userMessageId = crypto.randomUUID();
  await db.insert(chatMessage).values({
    id: userMessageId,
    sessionId: session.id,
    role: "user",
    sender: "user",
    content: text,
    status: "running",
  });
  const workflowId = crypto.randomUUID();
  await db.insert(workflowRun).values({
    id: workflowId,
    projectId,
    sessionId: session.id,
    goal: text,
    mode: "research",
    source: "chat",
    status: "pending",
  });
  await db.insert(chatMessageWorkflowLink).values({
    id: crypto.randomUUID(),
    chatMessageId: userMessageId,
    workflowRunId: workflowId,
    traceId: crypto.randomUUID(),
  });
  await dispatchTaskToRole({
    workflowId,
    role: "orchestrator",
    payload: {
      taskId: crypto.randomUUID(),
      taskType: "workflow_start",
      params: { workflowRunId: workflowId, goal: text, mode: "research" },
      assignedRole: "orchestrator",
    },
  });
  return { sessionId: session.id, workflowId, userMessageId };
}

integrationsRouter.post("/:kind/webhook", async (c) => {
  const rawKind = c.req.param("kind");
  if (!isSupportedIntegrationKind(rawKind)) {
    return bad(c, 400, `unsupported kind: ${rawKind}`);
  }
  const kind = rawKind;
  const rawBody = await c.req.text();
  let body: unknown = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return bad(c, 400, "invalid JSON body");
  }
  const headers: Record<string, string> = {};
  // 仅复制本次请求声明过的 headers（Hono Web API）
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // 选择校验 secret：优先环境变量（按 kind 命名），其次按渠道配置
  const envSecretMap: Record<CommunicationChannelKind, string | undefined> = {
    telegram: process.env.QUBIT_TELEGRAM_WEBHOOK_SECRET,
    feishu: process.env.QUBIT_FEISHU_WEBHOOK_SECRET,
    wecom: process.env.QUBIT_WECOM_WEBHOOK_SECRET,
    whatsapp: process.env.QUBIT_WHATSAPP_WEBHOOK_SECRET,
    dingtalk: process.env.QUBIT_DINGTALK_WEBHOOK_SECRET,
    webhook: process.env.QUBIT_GENERIC_WEBHOOK_SECRET,
  };
  const envSecret = envSecretMap[kind];

  const adapter = getIntegrationAdapter(kind);
  const verify = await adapter.verifyWebhook({
    headers,
    rawBody,
    body,
    ...(envSecret ? { secret: envSecret } : {}),
  });
  if (!verify.ok) {
    return c.json({ ok: false, error: verify.reason ?? "invalid webhook" }, 401);
  }
  if (verify.challengeResponse != null) {
    if (typeof verify.challengeResponse === "string") {
      return new Response(verify.challengeResponse, { status: 200 });
    }
    return c.json(verify.challengeResponse);
  }

  const parsed = parseInboundFor(kind, body);
  if (!parsed) {
    // 没有文本就只落日志，避免误派发
    const wp = await ensureWorkspaceProject();
    if (wp) {
      const db = await getDb();
      await db.insert(communicationMessageLog).values({
        id: crypto.randomUUID(),
        direction: "inbound",
        channelKind: kind,
        channelId: null,
        externalChatId: "unknown",
        payloadJson: body as unknown as object,
        status: "success",
      });
    }
    return c.json({ ok: true, skipped: "no parsable text message" });
  }

  // 自动建/取渠道并落入站日志
  const channel = await getOrCreateChannel(
    kind,
    parsed.externalChatId,
    kind === "telegram" ? (process.env.QUBIT_TELEGRAM_BOT_TOKEN ?? "") : ""
  );
  if (!channel) return bad(c, 400, "no workspace available for inbound message");
  await logInboundForChannel(channel, body, parsed);

  const dispatched = await dispatchInboundAsResearch(channel, parsed.text);
  if ("error" in dispatched) return bad(c, 400, dispatched.error);
  return c.json({ ok: true, data: dispatched });
});
