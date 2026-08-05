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
 *   - market.* + memory.* + research/portfolio tools + workspace.context.snapshot (static allowlist)
 *   - MCP via `mcp:<server>:<tool>` / `call_mcp` → dispatchMcpToolCall
 */

import { Hono } from "hono";
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
import { dispatchMcpToolCall } from "../runtime/mcp/dispatcher";
import { dispatchBuiltinTool, isBuiltinTool } from "../runtime/tools/builtin-tools";
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
  "workspace.memory.search",
  "run_screener",
  "research.thesis.write",
  "research.forecast_book.get",
  "portfolio.construct",
  "recommendation.record",
  "workspace.context.snapshot",
] as const;

const BRIDGED_SET = new Set<string>(BRIDGED_TOOLS);

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
  activity: { workflowId: string; runId: string; traceId: string }
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

  return {
    workflowId: activity.workflowId,
    runId: activity.runId,
    traceId: activity.traceId,
    agentInstanceId: "inst-prime-bridge",
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
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            ...BRIDGED_TOOLS.map((name) => ({
              name,
              description: `Legacy Bun builtin (bridged): ${name}`,
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
      const args =
        params.args && typeof params.args === "object"
          ? (params.args as Record<string, unknown>)
          : {};
      const activity = resolveBridgeActivity(params, callId);

      if (isMcpBridgeToolName(name)) {
        return invokeMcpViaBridge({
          rpcId: body.id,
          callId,
          name,
          args,
          activity,
        });
      }

      if (!BRIDGED_SET.has(name)) {
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
          bridgeContext(callId, activity),
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
  return c.json({
    ok: true,
    bridgedTools: [...BRIDGED_TOOLS],
    mcpToolCount: mcpTools.length,
    mcpTools: mcpTools.map((t) => t.name).slice(0, 50),
  });
});
