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
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import {
  getPrimeBridgeRunContext,
  workflowIdFromCoreWorkspace,
} from "../runtime/prime/bridge-run-context";
import {
  isMcpBridgeToolName,
  listBridgedMcpTools,
  resolveMcpInvokeTarget,
} from "../runtime/prime/bridge-mcp";
import { projectCoreBridgeToolCall } from "../runtime/prime/project-core-activity";
import { getCoreMonitorHandle } from "../runtime/prime/project-core-monitor";
import { dispatchMcpToolCall } from "../runtime/mcp/dispatcher";
import { dispatchBuiltinTool, isBuiltinTool } from "../runtime/tools/builtin-tools";
import type { BuiltinToolContext } from "../runtime/tools/types";
import type { RuntimeAgentDefinition } from "../runtime/types";
import { loadOrchestratorTopologyForWorkflow } from "../runtime/orchestration/topology-dispatch";

export const primeBridgeRouter = new Hono();

/** M4+ grayscale allowlist — keep in sync with qubit-tool-host DEFAULT_BRIDGED_TOOLS */
const BRIDGED_TOOLS = [
  "market.resolve_symbol",
  "market.readiness",
  "market.data_sources",
  "market.snapshot.get",
  "memory.recall",
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
  /** Orchestrator dispatch — list also injects dynamic call_team_* from topology. */
  "assign_task",
  "order.create_intent",
  "evaluate_risk",
] as const;

const BRIDGED_SET = new Set<string>(BRIDGED_TOOLS);

/** Static allowlist + topology `call_team_*` (and assign_task). */
export function isBridgedLegacyToolName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (BRIDGED_SET.has(n)) return true;
  if (n === "assign_task") return true;
  return n.startsWith("call_team_");
}

/**
 * Models often nest real params under `arguments`; top-level wins on conflict.
 * Also normalizes common aliases so handlers that only look at one key still work.
 */
export function unwrapBridgeToolArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  const nested =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : null;
  const out: Record<string, unknown> = nested ? { ...nested, ...args } : { ...args };
  delete out.arguments;

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

function resolveBridgeActivity(params: Record<string, unknown>, callId: string): {
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
      active?.runId ||
      (typeof params.run_id === "string" ? params.run_id : `bridge-${callId}`),
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
  const definition = {
    id: "def-prime-bridge",
    role: "orchestrator",
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
  const monitor = getCoreMonitorHandle(activity.workflowId, activity.runId);
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

  try {
    const result = await dispatchMcpToolCall({
      serverName: target.serverName,
      toolName: target.toolName,
      arguments: target.arguments,
    });
    const observation = {
      summary: result.accepted
        ? `mcp ${target.serverName}/${target.toolName} ok`
        : `mcp ${target.serverName}/${target.toolName} rejected`,
      serverName: result.serverName,
      toolName: result.toolName,
      transport: result.transport,
      accepted: result.accepted,
      output: result.output,
    };
    if (activity.workflowId !== "prime-bridge") {
      await projectCoreBridgeToolCall({
        ctx: activity,
        toolCallId: callId,
        toolName: name,
        ok: result.accepted,
        args,
        observation,
        mcp: {
          serverName: target.serverName,
          toolName: target.toolName,
          arguments: target.arguments,
          transport: result.transport,
        },
      });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: rpcId,
      result: {
        call_id: callId,
        ok: result.accepted,
        observation,
        effects: [
          {
            kind: "other",
            key: `mcp:${target.serverName}:${target.toolName}`,
            meta: { via: "prime-bridge", transport: result.transport },
          },
        ],
        retryable: false,
        error_code: result.accepted ? null : "mcp_rejected",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (activity.workflowId !== "prime-bridge") {
      await projectCoreBridgeToolCall({
        ctx: activity,
        toolCallId: callId,
        toolName: name,
        ok: false,
        args,
        observation: { summary: message },
        mcp: {
          serverName: target.serverName,
          toolName: target.toolName,
          arguments: target.arguments,
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
        retryable: true,
        error_code: "mcp_failed",
      },
    });
  }
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
      const teamTools = [
        "assign_task",
        ...((topology?.toolNames ?? []).filter((n) => n.startsWith("call_team_"))),
      ];
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
                : name === "assign_task"
                  ? "Assign a structured subagent task by role/goal (fallback when call_team_* unavailable)."
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
      const args = unwrapBridgeToolArgs(rawArgs);
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

      if (!isBuiltinTool(name)) {
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok: false,
            observation: { summary: `not a builtin tool: ${name}` },
            effects: [],
            retryable: false,
            error_code: "not_builtin",
          },
        });
      }

      try {
        const observation = await dispatchBuiltinTool(
          name,
          bridgeContext(callId, activity, projectId),
          args
        );
        if (activity.workflowId !== "prime-bridge") {
          await projectCoreBridgeToolCall({
            ctx: activity,
            toolCallId: callId,
            toolName: name,
            ok: true,
            args,
            observation:
              observation && typeof observation === "object"
                ? observation
                : { summary: String(observation) },
          });
        }
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok: true,
            observation:
              observation && typeof observation === "object"
                ? observation
                : { summary: String(observation) },
            effects: [
              {
                kind: "other",
                key: name,
                meta: { via: "prime-bridge" },
              },
            ],
            retryable: false,
            error_code: null,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (activity.workflowId !== "prime-bridge") {
          await projectCoreBridgeToolCall({
            ctx: activity,
            toolCallId: callId,
            toolName: name,
            ok: false,
            args,
            observation: { summary: message },
          });
        }
        return c.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            call_id: callId,
            ok: false,
            observation: { summary: message },
            effects: [],
            retryable: true,
            error_code: "builtin_failed",
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
        message: err instanceof Error ? err.message : String(err),
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
    bridgedTools: [...new Set([...BRIDGED_TOOLS, "assign_task", ...teamTools])],
    mcpToolCount: mcpTools.length,
    mcpTools: mcpTools.map((t) => t.name).slice(0, 50),
  });
});
