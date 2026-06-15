import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { ServerWebSocket } from "bun";
import { config } from "./config";
import { workspaceRouter } from "./routes/workspace.routes";
import { workflowRouter } from "./routes/workflow.routes";
import { agentRouter } from "./routes/agent.routes";
import { chatRouter } from "./routes/chat.routes";
import { monitorRouter } from "./routes/monitor.routes";
import { integrationsRouter } from "./routes/integrations.routes";
import { analystRouter } from "./routes/analyst.routes";
import { debateRouter } from "./routes/debate.routes";
import { riskRouter } from "./routes/risk.routes";
import { screenerRouter } from "./routes/screener.routes";
import { geneRouter } from "./routes/gene.routes";
import { reiaRouter } from "./routes/reia.routes";
import { executionRouter } from "./routes/execution.routes";
import { marketRouter } from "./routes/market.routes";
import { strategyRuntimeRouter } from "./routes/strategy-runtime.routes";
import { traderRouter } from "./routes/trader.routes";
import { fsiRouter } from "./routes/fsi.routes";
import { systemRouter } from "./routes/system.routes";
import { environmentRouter } from "./routes/environment.routes";
import { providerRouter } from "./routes/provider.routes";
import { researchScenarioRouter } from "./routes/research-scenario.routes";
import { factorRouter } from "./routes/factor.routes";
import { ruleRouter } from "./routes/rule.routes";
import { backtestJobRouter } from "./routes/backtest-job.routes";
import { discoveryRouter } from "./routes/discovery.routes";
import { strategyRouter } from "./routes/strategy.routes";
import { strategyCompositionRouter } from "./routes/strategy-composition.routes";
import { quantRouter } from "./routes/quant.routes";
import { llmProviderRouter } from "./routes/llm-provider.routes";
import { metaRouter } from "./routes/meta.routes";
import { registerBuiltinConnectors } from "./connectors/bootstrap";
import { stepStreamBus } from "./runtime/langgraph/event-stream";

void registerBuiltinConnectors();

// ─── HTTP API (Hono) ─────────────────────────────────────────────────────────

export const app = new Hono();

app.use("*", cors({ origin: "*" }));
app.use("*", logger());

app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", ts: new Date().toISOString() })
);

app.route("/api/v1/workspaces", workspaceRouter);
app.route("/api/v1/workflows", workflowRouter);
app.route("/api/v1/agents", agentRouter);
app.route("/api/v1/chat", chatRouter);
app.route("/api/v1/monitor", monitorRouter);
app.route("/api/v1/integrations", integrationsRouter);
app.route("/api/v1/analyst", analystRouter);
app.route("/api/v1/debate", debateRouter);
app.route("/api/v1/risk", riskRouter);
app.route("/api/v1/screener", screenerRouter);
app.route("/api/v1/gene", geneRouter);
app.route("/api/v1/reia", reiaRouter);
app.route("/api/v1/execution", executionRouter);
app.route("/api/v1/market", marketRouter);
app.route("/api/v1/strategy-runtimes", strategyRuntimeRouter);
app.route("/api/v1/trader", traderRouter);
app.route("/api/v1/fsi", fsiRouter);
app.route("/api/v1/system", systemRouter);
// M1 + M2：Provider 抽象层 / 研究场景 / 因子-规则-策略 三段式
app.route("/api/v1/providers", providerRouter);
app.route("/api/v1/environment", environmentRouter);
app.route("/api/v1/research-scenarios", researchScenarioRouter);
app.route("/api/v1/factors", factorRouter);
app.route("/api/v1/rules", ruleRouter);
app.route("/api/v1/backtest-jobs", backtestJobRouter);
app.route("/api/v1/discovery-jobs", discoveryRouter);
app.route("/api/v1/strategies", strategyRouter);
app.route("/api/v1/strategy-compositions", strategyCompositionRouter);
// 量化工作台聚合：lineage 查询 + agents/workflows 批量解析（migration 0080 配套）
app.route("/api/v1/quant", quantRouter);
// M10: LLM Provider 配置（per-Agent 模型路由 + 默认降级）
app.route("/api/v1/llm-providers", llmProviderRouter);
// 后端元信息：commit / startedAt / pid / watchMode，便于"代码到底有没有生效"快速排查
app.route("/api/v1/_meta", metaRouter);
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
/**
 * Workflow 级 firehose：订阅该 workflow 下所有 agent run 的事件（token / tool / final…）。
 * 研究团队页用它逐字渲染 Orchestrator 与各子 agent 的 LLM 输出（事件自带 role 供前端路由）。
 */
app.get("/api/v1/workflows/:id/events", (c) => {
  const workflowId = c.req.param("id");
  const stream = stepStreamBus.createWorkflowSseStream(workflowId);
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

// ─── Server startup ───────────────────────────────────────────────────────────

export function createServer() {
  return Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,
    /**
     * Bun.serve 默认 `idleTimeout = 10s`，对本平台两类长连接是致命的：
     *   1. SSE workflow stream（chat / 团队研究的实时事件流）一旦 10s 无数据就被切断，
     *      前端会看到 "request timed out after 10 seconds" + "一直在流式生成中" 卡死。
     *   2. 长 LLM 调用（多 agent 协同时单步 reason 走云端模型 30~60s 很常见）也会被砍。
     * Bun 上限是 255s；额外配合 `createSseStream` 内的 25s heartbeat，最大空闲连接也
     * 永远不会触达这个上限。
     */
    idleTimeout: 255,

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
