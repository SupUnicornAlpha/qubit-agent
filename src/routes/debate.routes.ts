import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { debateSession, debateTurn, debateVerdict } from "../db/sqlite/schema";
import { debateStreamBus } from "../runtime/debate/debate-stream";
import { loadDebateConfig, saveDebateConfig } from "../runtime/config/debate-config";

export const debateRouter = new Hono();

debateRouter.get("/stream/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");
  const stream = debateStreamBus.createSseStream(workflowId);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

debateRouter.get("/sessions/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");
  const db = await getDb();
  const sessions = await db
    .select()
    .from(debateSession)
    .where(eq(debateSession.workflowRunId, workflowId))
    .orderBy(desc(debateSession.createdAt));
  return c.json({ ok: true, data: sessions });
});

debateRouter.get("/config", async (c) => {
  const data = await loadDebateConfig();
  return c.json({ ok: true, data });
});

debateRouter.put("/config", async (c) => {
  const body = await c.req.json<{ confidenceThreshold?: number; maxRounds?: number }>();
  const data = await saveDebateConfig(body);
  return c.json({ ok: true, data });
});

debateRouter.get("/sessions/:sessionId/turns", async (c) => {
  const sessionId = c.req.param("sessionId");
  const db = await getDb();
  const turns = await db
    .select()
    .from(debateTurn)
    .where(eq(debateTurn.debateSessionId, sessionId))
    .orderBy(debateTurn.roundNumber);
  return c.json({ ok: true, data: turns });
});

debateRouter.get("/sessions/:sessionId/verdict", async (c) => {
  const sessionId = c.req.param("sessionId");
  const db = await getDb();
  const verdict = await db
    .select()
    .from(debateVerdict)
    .where(eq(debateVerdict.debateSessionId, sessionId))
    .limit(1);
  return c.json({ ok: true, data: verdict[0] ?? null });
});
