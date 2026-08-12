/**
 * Prime ↔ Bun Legacy Tool Bridge (01 §11.2).
 *
 * JSON-RPC over HTTP:
 *   POST /api/v1/prime-bridge/rpc
 *   methods: legacy.tools.list | legacy.tools.invoke
 *
 * Enable from Rust with QUBIT_LEGACY_BRIDGE_URL=http://127.0.0.1:<port>/api/v1/prime-bridge
 *
 * L2 surface (strangler):
 *   - market.* + memory.* + research/portfolio/factor/strategy tools + workspace.context.snapshot
 *   - MCP via `mcp:<server>:<tool>` / `call_mcp` → dispatchMcpToolCall
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { registerBuiltinConnectors } from "../connectors/bootstrap";
import { connectorRegistry } from "../connectors/registry";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import { dispatchMcpToolCall } from "../runtime/mcp/dispatcher";
import { loadOrchestratorTopologyForWorkflow } from "../runtime/orchestration/topology-dispatch";
import {
  isMcpBridgeToolName,
  isMcpToolQuarantined,
  listBridgedMcpTools,
  resolveMcpInvokeTarget,
} from "../runtime/prime/bridge-mcp";
import {
  getPrimeBridgeRunContext,
  workflowIdFromCoreWorkspace,
} from "../runtime/prime/bridge-run-context";
import { projectCoreBridgeToolCall } from "../runtime/prime/project-core-activity";
import { getCoreMonitorHandle } from "../runtime/prime/project-core-monitor";
import { classifyToolError } from "../runtime/react/nodes/tool-error-classifier";
import { dispatchBuiltinTool, isBuiltinTool } from "../runtime/tools/builtin-tools";
import { detectSemanticToolFailure } from "../runtime/tools/semantic-tool-result";
import { applyToolContract } from "../runtime/tools/tool-contract";
import { getToolContract } from "../runtime/tools/tool-contract-registry";
import { resolveConnectorForTool } from "../runtime/tools/tool-routes";
import type { BuiltinToolContext } from "../runtime/tools/types";
import type { RuntimeAgentDefinition } from "../runtime/types";

export const primeBridgeRouter = new Hono();

/** M4+ grayscale allowlist — keep in sync with qubit-tool-host DEFAULT_BRIDGED_TOOLS */
const BRIDGED_TOOLS = [
  "market.resolve_symbol",
  "market.readiness",
  "market.data_sources",
  "market.snapshot.get",
  "memory.recall",
  "skill.search",
  "workspace.memory.search",
  "run_screener",
  "research.thesis.write",
  "research.forecast_book.get",
  "portfolio.construct",
  "recommendation.record",
  "strategy.create_version",
  "strategy.compose",
  "strategy.compile",
  "strategy.contract_backtest",
  "strategy.paper_deploy",
  "strategy.paper_run",
  "strategy.sim_deploy",
  "factor.register",
  "factor.list",
  "factor.compute",
  "factor.autoEvaluate",
  "factor.mine.llm",
  "factor.promote_backtest",
  "backtest.run",
  "workspace.context.snapshot",
  "web.search",
  "web.fetch",
  // Specialist read/analysis tools. AgentSpec `tool_surface_ref` is not yet
  // resolved by Core, so every tool a child is expected to call must also be
  // advertised by the legacy bridge (and mirrored in qubit-tool-host).
  "fetch_klines",
  "fetch_fundamentals",
  "fetch_news",
  "fetch_news_sentiment",
  "compute_indicators",
  "detect_patterns",
  "compute_valuation",
  "compute_macro_indicators",
  /** Orchestrator dispatch uses Core agent.invoke + typed topology call_team_* only. */
  "order.create_intent",
  "evaluate_risk",
] as const;

const BRIDGED_SET = new Set<string>(BRIDGED_TOOLS);

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of ["message", "error", "summary", "errorMessage", "msg"] as const) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v;
    }
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

function observationOkFalse(observation: unknown): string | null {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return null;
  const record = observation as Record<string, unknown>;
  if (record.ok === false) {
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
    return "tool_returned_ok_false";
  }
  return null;
}

/** Static allowlist + typed topology `call_team_*`. */
export function isBridgedLegacyToolName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (BRIDGED_SET.has(n)) return true;
  return n.startsWith("call_team_");
}

/**
 * Models often nest real params under `arguments`; top-level wins on conflict.
 * Also normalizes common aliases so handlers that only look at one key still work.
 */
export function unwrapBridgeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const nested =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : null;
  const out: Record<string, unknown> = nested ? { ...nested, ...args } : { ...args };
  Reflect.deleteProperty(out, "arguments");

  if (out.projectId == null && typeof out.project_id === "string") {
    out.projectId = out.project_id;
  }
  if (out.project_id == null && typeof out.projectId === "string") {
    out.project_id = out.projectId;
  }
  if (out.name == null) {
    const strategyName =
      typeof out.strategyName === "string"
        ? out.strategyName
        : out.strategy &&
            typeof out.strategy === "object" &&
            !Array.isArray(out.strategy) &&
            typeof (out.strategy as { name?: unknown }).name === "string"
          ? String((out.strategy as { name: string }).name)
          : null;
    if (strategyName) out.name = strategyName;
  }
  if (out.symbols == null && Array.isArray(out.targets)) {
    out.symbols = out.targets;
  }
  if (out.snapshotId == null && typeof out.snapshot_id === "string") {
    out.snapshotId = out.snapshot_id;
  }
  if (out.symbol == null && typeof out.ticker === "string") {
    out.symbol = out.ticker;
  }
  if (out.ticker == null && typeof out.symbol === "string") {
    out.ticker = out.symbol;
  }
  if (out.entryId == null) {
    const bookId =
      typeof out.bookId === "string"
        ? out.bookId
        : typeof out.book_id === "string"
          ? out.book_id
          : typeof out.forecastBookId === "string"
            ? out.forecastBookId
            : null;
    if (bookId) out.entryId = bookId;
  }
  if (out.candidates == null && Array.isArray(out.allocation)) {
    out.candidates = out.allocation;
  }
  return out;
}

/**
 * Normalize common model aliases before invoking Bun builtins/connectors.
 * Core's legacy tool list is intentionally compact and some providers do not
 * reliably follow array-shaped schemas, so the bridge must be tolerant at the
 * boundary instead of sending a guaranteed-empty request downstream.
 */
export function normalizeBridgeToolArgs(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args };

  if (toolName === "web.fetch") {
    const query = typeof next.query === "string" ? next.query.trim() : "";
    if (next.url == null && next.uri == null && /^https?:\/\//i.test(query)) {
      next.url = query;
    }
  }

  if (toolName === "fetch_news" || toolName === "fetch_news_sentiment") {
    if (!Array.isArray(next.symbols) || next.symbols.length === 0) {
      const symbol =
        (typeof next.symbol === "string" && next.symbol.trim()) ||
        (typeof next.ticker === "string" && next.ticker.trim()) ||
        "";
      if (symbol) next.symbols = [symbol];
    }
    if (!Array.isArray(next.keywords) || next.keywords.length === 0) {
      const query =
        (typeof next.query === "string" && next.query.trim()) ||
        (typeof next.keyword === "string" && next.keyword.trim()) ||
        "";
      if (query) next.keywords = [query];
    }
    const days = Number(next.days);
    if (Number.isFinite(days) && days > 0 && next.startDate == null) {
      const end = new Date();
      const start = new Date(end.getTime() - Math.min(Math.floor(days), 365) * 86_400_000);
      next.startDate = start.toISOString();
      if (next.endDate == null) next.endDate = end.toISOString();
    }
  }

  return next;
}

async function projectIdForWorkflow(workflowId: string): Promise<string | undefined> {
  if (!workflowId || workflowId === "prime-bridge") return undefined;
  try {
    const db = await getDb();
    const rows = await db
      .select({ projectId: workflowRun.projectId })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowId))
      .limit(1);
    const id = rows[0]?.projectId?.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

function resolveBridgeActivity(
  params: Record<string, unknown>,
  callId: string
): {
  workflowId: string;
  runId: string;
  traceId: string;
  role: string;
} {
  const active = getPrimeBridgeRunContext();
  const fromWorkspace = workflowIdFromCoreWorkspace(
    typeof params.workspace_id === "string" ? params.workspace_id : null
  );
  const workflowId =
    fromWorkspace ||
    active?.workflowId ||
    (typeof params.workflow_id === "string" ? params.workflow_id : "") ||
    "prime-bridge";
  return {
    workflowId,
    runId:
      active?.runId || (typeof params.run_id === "string" ? params.run_id : `bridge-${callId}`),
    traceId:
      active?.traceId ||
      (typeof params.trace_id === "string" ? params.trace_id : `bridge-${callId}`),
    role: active?.role || "orchestrator",
  };
}

function bridgeContext(
  callId: string,
  activity: { workflowId: string; runId: string; traceId: string },
  projectId?: string
): BuiltinToolContext {
  // Prefer the real Core monitor identity. Skills and tool health must be
  // attributed to the calling topology node, not to a synthetic bridge agent.
  const monitor = getCoreMonitorHandle(activity.workflowId, activity.runId);
  const definition = {
    id: monitor?.agentDefinitionId ?? "def-orchestrator",
    role: (monitor?.role ?? "orchestrator") as RuntimeAgentDefinition["role"],
    executionKind: "primary",
    name: "Prime Bridge",
    version: "0.1.0",
    systemPrompt: "",
    tools: [...BRIDGED_TOOLS],
    mcpServers: [],
    skills: [],
    outputs: [],
    subscriptions: [],
    llmProvider: "",
    maxIterations: 1,
    sandboxPolicyId: "default-policy",
    enabled: true,
  } as RuntimeAgentDefinition;

  // Prefer the real monitor agent_instance created for this Core turn.
  // Never invent "inst-prime-bridge" — audit_log FK would fail on recommendation.record.
  return {
    workflowId: activity.workflowId,
    runId: activity.runId,
    traceId: activity.traceId,
    agentInstanceId: monitor?.agentInstanceId ?? "",
    ...(projectId ? { projectId } : {}),
    definition,
    toolCallId: callId,
  };
}

type JsonRpcReq = {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
};

async function invokeMcpViaBridge(input: {
  rpcId: unknown;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  activity: ReturnType<typeof resolveBridgeActivity>;
}): Promise<Response> {
  const { rpcId, callId, name, args, activity } = input;
  const target = resolveMcpInvokeTarget(name, args);
  if (!target) {
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        call_id: callId,
        ok: false,
        observation: {
          summary:
            name === "call_mcp"
              ? "call_mcp requires serverName + toolName (or mcpTool)"
              : `invalid mcp tool name: ${name}`,
        },
        effects: [],
        retryable: false,
        error_code: "mcp_bad_args",
      },
    });
  }

  if (isMcpToolQuarantined(target.serverName, target.toolName)) {
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        call_id: callId,
        ok: false,
        observation: {
          summary: `MCP tool ${target.serverName}/${target.toolName} is quarantined from the global surface`,
          errorClass: "blocked",
          retryable: false,
        },
        effects: [],
        retryable: false,
        error_code: "mcp_tool_quarantined",
      },
    });
  }

  const normalizedArgs = normalizeInvestorAgentArgs(
    target.serverName,
    target.toolName,
    target.arguments
  );

  try {
    const result = await dispatchMcpToolCall({
      serverName: target.serverName,
      toolName: target.toolName,
      arguments: normalizedArgs,
    });
    const wireName = `mcp:${target.serverName}:${target.toolName}`;
    const semanticFailure = detectSemanticToolFailure(wireName, {
      mcpResult: {
        accepted: result.accepted,
        output: result.output,
      },
      ...result,
    });
    const outputIsError =
      result.output &&
      typeof result.output === "object" &&
      (result.output as { isError?: unknown }).isError === true;
    const ok = Boolean(result.accepted) && !outputIsError && !semanticFailure;
    const failureCode = semanticFailure
      ? `semantic_data_failure:${semanticFailure}`
      : outputIsError
        ? "mcp_is_error"
        : result.accepted
          ? null
          : "mcp_rejected";
    const observation = {
      summary: ok
        ? `mcp ${target.serverName}/${target.toolName} ok`
        : `mcp ${target.serverName}/${target.toolName} failed${semanticFailure ? ` (${semanticFailure})` : outputIsError ? " (isError)" : ""}`,
      serverName: result.serverName,
      toolName: result.toolName,
      transport: result.transport,
      accepted: result.accepted,
      output: result.output,
      ...(normalizedArgs !== target.arguments ? { normalizedArguments: normalizedArgs } : {}),
      ...(semanticFailure ? { semanticFailure } : {}),
    };
    if (activity.workflowId !== "prime-bridge") {
      await projectCoreBridgeToolCall({
        ctx: activity,
        toolCallId: callId,
        toolName: name,
        ok,
        args: normalizedArgs,
        observation,
        mcp: {
          serverName: target.serverName,
          toolName: target.toolName,
          arguments: normalizedArgs,
          transport: result.transport,
        },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        call_id: callId,
        ok,
        observation,
        effects: ok
          ? [
              {
                kind: "other",
                key: `mcp:${target.serverName}:${target.toolName}`,
                meta: { via: "prime-bridge", transport: result.transport },
              },
            ]
          : [],
        retryable: false,
        error_code: failureCode,
      },
    });
  } catch (err) {
    const message = formatUnknownError(err);
    const errorClass = classifyToolError(message);
    const retryable = errorClass === "transient";
    if (activity.workflowId !== "prime-bridge") {
      await projectCoreBridgeToolCall({
        ctx: activity,
        toolCallId: callId,
        toolName: name,
        ok: false,
        args: normalizedArgs,
        observation: { summary: message, errorClass, retryable },
        mcp: {
          serverName: target.serverName,
          toolName: target.toolName,
          arguments: normalizedArgs,
        },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        call_id: callId,
        ok: false,
        observation: { summary: message },
        effects: [],
        retryable,
        error_code: `mcp_${errorClass}`,
      },
    });
  }
}

/**
 * investor-agent get_stock_info requires `modules: string[]`.
 * Models often pass only symbol/ticker → MCP -32602 while transport still "accepted".
 */
export function normalizeInvestorAgentArgs(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (serverName !== "investor-agent") return args;
  const next: Record<string, unknown> = { ...args };
  let sym =
    (typeof next.symbol === "string" && next.symbol.trim()) ||
    (typeof next.ticker === "string" && next.ticker.trim()) ||
    "";
  if (sym) {
    // investor-agent is Yahoo-backed: Shanghai uses .SS, not the domestic .SH alias.
    if (/^\d{6}\.SH$/i.test(sym)) sym = `${sym.slice(0, 6)}.SS`;
    if (/^\d{6}$/.test(sym)) {
      sym = /^[569]/.test(sym) ? `${sym}.SS` : `${sym}.SZ`;
    }
    next.symbol = sym;
    next.ticker = sym;
  }
  if (toolName === "technical_indicator" && typeof next.indicator === "string") {
    const indicator = next.indicator.trim().toUpperCase().replace(/[ -]+/g, "_");
    next.indicator =
      indicator === "BOLLINGER" || indicator === "BOLLINGER_BANDS" ? "BBANDS" : indicator;
  }
  if (
    toolName === "get_stock_info" &&
    (!Array.isArray(next.modules) || next.modules.length === 0)
  ) {
    next.modules = ["price", "summaryDetail", "defaultKeyStatistics", "financialData"];
  }
  return next;
}

primeBridgeRouter.post("/rpc", async (c) => {
  const body = (await c.req.json().catch(() => null)) as JsonRpcReq | null;
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return c.json(
      {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: { code: -32600, message: "invalid request" },
      },
      400
    );
  }

  try {
    if (body.method === "legacy.tools.list") {
      const mcpTools = await listBridgedMcpTools();
      const topology = await loadOrchestratorTopologyForWorkflow().catch(() => null);
      const teamTools = (topology?.toolNames ?? []).filter((n) => n.startsWith("call_team_"));
      const names = [...new Set<string>([...BRIDGED_TOOLS, ...teamTools])];
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            ...names.map((name) => ({
              name,
              description: name.startsWith("call_team_")
                ? `Dispatch specialist subagent via A2A (${name}). Prefer for context-split research; pass {goal}.`
                : `Legacy Bun builtin (bridged): ${name}`,
            })),
            ...mcpTools.map((t) => ({
              name: t.name,
              description: t.description,
            })),
          ],
        },
      });
    }

    if (body.method === "legacy.tools.invoke") {
      const params = body.params ?? {};
      const name = String(params.name ?? "");
      const callId = String(params.call_id ?? crypto.randomUUID());
      const rawArgs =
        params.args && typeof params.args === "object"
          ? (params.args as Record<string, unknown>)
          : {};
      let args = normalizeBridgeToolArgs(name, unwrapBridgeToolArgs(rawArgs));
      const activity = resolveBridgeActivity(params, callId);
      const projectId = await projectIdForWorkflow(activity.workflowId);

      if (isMcpBridgeToolName(name)) {
        return invokeMcpViaBridge({
          rpcId: body.id,
          callId,
          name,
          args,
          activity,
        });
      }

      if (!isBridgedLegacyToolName(name)) {
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok: false,
            observation: { summary: `tool not in bridge allowlist: ${name}` },
            effects: [],
            retryable: false,
            error_code: "bridge_not_allowlisted",
          },
        });
      }

      if (!isBuiltinTool(name) && !resolveConnectorForTool(name)) {
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok: false,
            observation: { summary: `not a builtin/connector tool: ${name}` },
            effects: [],
            retryable: false,
            error_code: "not_builtin",
          },
        });
      }

      try {
        const contract = getToolContract(name);
        if (contract) args = applyToolContract(contract, args);
        let observation: unknown;
        if (isBuiltinTool(name)) {
          observation = await dispatchBuiltinTool(
            name,
            bridgeContext(callId, activity, projectId),
            args
          );
        } else {
          const connectorName = resolveConnectorForTool(name);
          if (!connectorName) throw new Error(`connector route not found: ${name}`);
          await registerBuiltinConnectors();
          const conn = connectorRegistry.get(connectorName);
          if (!conn) {
            throw new Error(`connector not registered: ${connectorName}`);
          }
          observation = await conn.execute(name, args);
        }
        const semanticFailure = detectSemanticToolFailure(name, {
          connectorResult: observation,
          ...(observation && typeof observation === "object"
            ? (observation as Record<string, unknown>)
            : {}),
        });
        const okFalseReason = observationOkFalse(observation);
        const failureReason = semanticFailure || okFalseReason;
        const ok = !failureReason;
        const summary = ok
          ? `connector/tool ${name} ok`
          : `connector/tool ${name} failed (${failureReason})`;
        const observationOut =
          observation && typeof observation === "object"
            ? {
                ...(observation as object),
                summary,
                ...(failureReason ? { semanticFailure: failureReason } : {}),
              }
            : { summary };
        if (activity.workflowId !== "prime-bridge") {
          await projectCoreBridgeToolCall({
            ctx: activity,
            toolCallId: callId,
            toolName: name,
            ok,
            args,
            observation: observationOut,
          });
        }
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok,
            observation: observationOut,
            effects: ok
              ? [
                  {
                    kind: "other",
                    key: name,
                    meta: { via: "prime-bridge" },
                  },
                ]
              : [],
            retryable: false,
            error_code: failureReason ? `semantic_data_failure:${failureReason}` : null,
          },
        });
      } catch (err) {
        const message = formatUnknownError(err);
        const errorClass = classifyToolError(message);
        const retryable = errorClass === "transient";
        if (activity.workflowId !== "prime-bridge") {
          await projectCoreBridgeToolCall({
            ctx: activity,
            toolCallId: callId,
            toolName: name,
            ok: false,
            args,
            observation: { summary: message, errorClass, retryable },
          });
        }
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok: false,
            observation: { summary: message, errorClass, retryable },
            effects: [],
            retryable,
            error_code: `builtin_${errorClass}`,
          },
        });
      }
    }

    return c.json({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: `method not found: ${body.method}` },
    });
  } catch (err) {
    return c.json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: {
        code: -32000,
        message: formatUnknownError(err),
      },
    });
  }
});

primeBridgeRouter.get("/health", async (c) => {
  const mcpTools = await listBridgedMcpTools().catch(() => []);
  const topology = await loadOrchestratorTopologyForWorkflow().catch(() => null);
  const teamTools = topology?.toolNames ?? [];
  return c.json({
    ok: true,
    bridgedTools: [...new Set([...BRIDGED_TOOLS, ...teamTools])],
    mcpToolCount: mcpTools.length,
    mcpTools: mcpTools.map((t) => t.name).slice(0, 50),
  });
});
