/**
 * ToolPlan is the normalized, context-bound request that crosses from Reason
 * into Act. It deliberately performs no authorization, logging or execution.
 */
import { registerBuiltinConnectors } from "../../../connectors/bootstrap";
import { connectorRegistry } from "../../../connectors/registry";
import { injectContextParams } from "../../tools/context-params";
import type { ParsedToolCall } from "../../tools/tool-call-format";
import {
  type ToolExecutionRoute,
  resolveToolExecutionRoute,
  toolRouteToTargetKind,
  toolRouteToToolKind,
} from "../../tools/tool-dispatch-resolver";
import { resolveConnectorForServerAlias } from "../../tools/tool-routes";

type ParsedToolRequest = Extract<ParsedToolCall, { kind: "tool" }>;

export interface ToolPlan {
  requestedToolName: string;
  effectiveToolName: string;
  params: Record<string, unknown>;
  mcp: ParsedToolRequest["mcp"] | undefined;
  executionRoute: ToolExecutionRoute | null;
  connectorTarget: string | undefined;
  targetKind: "mcp" | "tool" | "connector";
  targetName: string;
  toolKind: "mcp" | "builtin" | "acp_connector";
}

export async function buildToolPlan(input: {
  parsed: ParsedToolRequest;
  workflowId: string;
  projectId: string | undefined;
}): Promise<ToolPlan> {
  const { parsed } = input;
  let params: Record<string, unknown> = { ...parsed.params };
  let mcp = parsed.mcp;
  let effectiveToolName = parsed.toolName;

  // Treat a connector server passed through call_mcp as a normal connector
  // request, so it follows the same admission and sandbox path.
  if (mcp) {
    await registerBuiltinConnectors();
    const connectorAlias = resolveConnectorForServerAlias(mcp.serverName);
    if (connectorAlias && connectorRegistry.get(connectorAlias)) {
      effectiveToolName = mcp.toolName;
      params = { ...params, operation: mcp.toolName, ...(mcp.arguments ?? {}) };
      mcp = undefined;
    }
  }

  const executionRoute = mcp ? null : resolveToolExecutionRoute(effectiveToolName);
  if (executionRoute) effectiveToolName = executionRoute.effectiveName;

  const connectorTarget =
    !mcp && executionRoute?.route === "connector" ? executionRoute.connectorName : undefined;
  const targetKind = mcp ? "mcp" : toolRouteToTargetKind(executionRoute?.route ?? "builtin");
  const targetName = mcp
    ? `${mcp.serverName}/${mcp.toolName}`
    : connectorTarget
      ? `${connectorTarget}/${effectiveToolName}`
      : effectiveToolName;

  return {
    requestedToolName: parsed.toolName,
    effectiveToolName,
    params: injectContextParams(params, {
      workflowRunId: input.workflowId,
      projectId: input.projectId,
    }),
    mcp,
    executionRoute,
    connectorTarget,
    targetKind,
    targetName,
    toolKind: mcp ? "mcp" : toolRouteToToolKind(executionRoute?.route ?? "builtin"),
  };
}
