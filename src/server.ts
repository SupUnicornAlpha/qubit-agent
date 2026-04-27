import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ServerWebSocket } from "bun";
import { config } from "./config";
import { workspaceRouter } from "./routes/workspace.routes";
import { workflowRouter } from "./routes/workflow.routes";
import { agentRouter } from "./routes/agent.routes";
import { stepStreamBus } from "./runtime/langgraph/event-stream";

// ─── HTTP API (Hono) ─────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", ts: new Date().toISOString() })
);

app.route("/api/v1/workspaces", workspaceRouter);
app.route("/api/v1/workflows", workflowRouter);
app.route("/api/v1/agents", agentRouter);
app.get("/api/v1/workflows/:id/stream", (c) => {
  const runId = c.req.query("runId");
  if (!runId) return c.json({ error: "runId is required" }, 400);
  const stream = stepStreamBus.createSseStream(runId);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
app.get("/api/v1/workflows/:id/stream/:runId", (c) => {
  const runId = c.req.param("runId");
  const stream = stepStreamBus.createSseStream(runId);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("[Server] Unhandled error:", err);
  return c.json({ error: err.message }, 500);
});

// ─── WebSocket hub ────────────────────────────────────────────────────────────

interface WsData {
  id: string;
  topic?: string;
}

const wsClients = new Map<string, ServerWebSocket<WsData>>();

export function broadcastWs(topic: string, payload: unknown): void {
  const message = JSON.stringify({ topic, payload, ts: Date.now() });
  for (const client of wsClients.values()) {
    if (!client.data.topic || client.data.topic === topic) {
      try {
        client.send(message);
      } catch {
        // client disconnected
      }
    }
  }
}

// ─── Server startup ───────────────────────────────────────────────────────────

export function createServer() {
  return Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,

    async fetch(req, server) {
      // Upgrade WebSocket connections
      if (req.headers.get("upgrade") === "websocket") {
        const url = new URL(req.url);
        const topic = url.searchParams.get("topic") ?? undefined;
        const id = crypto.randomUUID();
        const upgraded = server.upgrade(req, { data: { id, topic } });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // Delegate to Hono for HTTP
      return app.fetch(req);
    },

    websocket: {
      open(ws) {
        wsClients.set(ws.data.id, ws);
        ws.send(JSON.stringify({ topic: "connected", payload: { id: ws.data.id } }));
      },
      message(ws, raw) {
        try {
          const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
          if (msg.subscribe) {
            ws.data.topic = msg.subscribe;
          }
        } catch {
          // ignore malformed
        }
      },
      close(ws) {
        wsClients.delete(ws.data.id);
      },
    },
  });
}
