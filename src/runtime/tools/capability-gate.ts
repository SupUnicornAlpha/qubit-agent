/**
 * ToolCapabilityGate — single authorize entry for builtin/connector/mcp/team.
 * See docs/agent-contracts/02-capability-gate.md
 */

import {
  isAgentControlPlaneTool,
  isToolAllowedInAgentControlMode,
} from "../agent-control-mode";
import { resolveEnabledMcpServers, filterMcpToolsByAvailability } from "../mcp/resolve-enabled-mcp-servers";
import { resolveEffectiveAgentTools } from "../orchestration/resolve-effective-tools";
import {
  isTopologyTeamTool,
  resolveTopologyToolTimeoutMs,
} from "../orchestration/topology-dispatch";
import {
  isConnectorAuthorized,
  isMcpAuthorized,
  isToolAuthorized,
  sandboxExecutor,
  type LoadedSandboxPolicy,
} from "../sandbox-executor";
import type { AgentControlMode } from "../../types/loop";
import type { RuntimeAgentDefinition } from "../types";
import { getToolContract } from "./tool-contract-registry";
import { isToolContractEnabled, timeoutMsForClass } from "./tool-contract";
import { resolveToolExecutionRoute } from "./tool-dispatch-resolver";
import { resolveConnectorForTool } from "./tool-routes";

export type CapabilityCall = {
  name: string;
  serverName?: string;
  mcpTool?: string;
  agentDefinition: RuntimeAgentDefinition;
  workflowId: string;
  projectId?: string | null;
  agentMode?: AgentControlMode | string | null;
  isMcp?: boolean;
};

export type CapabilityAllow = {
  ok: true;
  canonicalName: string;
  kind: "builtin" | "connector" | "mcp" | "team";
  connectorName?: string;
  serverName?: string;
  timeoutMs: number;
  contractName?: string;
};

export type CapabilityDeny = {
  ok: false;
  code:
    | "tool_not_allowed"
    | "mcp_server_disabled"
    | "mcp_in_cooldown"
    | "plan_mode_blocked"
    | "topology_role_blocked"
    | "lifecycle_hidden";
  message: string;
  hint: string;
  allowlist?: string[];
  retryable: false;
};

export type CapabilityDecision = CapabilityAllow | CapabilityDeny;

export function isCapabilityGateEnabled(): boolean {
  return process.env["CAPABILITY_GATE_ENABLED"] !== "0";
}

export type AuthorizedCapabilitySurface = {
  tools: string[];
  mcpServerNames: string[];
  mcpServers: Array<{ name: string; tools?: Array<{ name: string; desc?: string }> }>;
};

/**
 * Prompt-facing projection — same rules as authorize where applicable.
 */
export async function listAuthorizedCapabilities(input: {
  agentDefinition: RuntimeAgentDefinition;
  workflowId: string;
  projectId?: string | null;
  agentMode?: AgentControlMode | string | null;
}): Promise<AuthorizedCapabilitySurface> {
  const effective = await resolveEffectiveAgentTools(input.agentDefinition, input.workflowId);
  const enabledMcpServers = await resolveEnabledMcpServers(
    input.agentDefinition.mcpServers ?? [],
    input.projectId ?? undefined
  );
  const authorized = await sandboxExecutor.filterAuthorizedTools(
    input.agentDefinition,
    effective.tools,
    enabledMcpServers.map((s) => s.name)
  );
  let tools = filterMcpToolsByAvailability(authorized.tools, authorized.mcpServers);
  const allowedMcpNames = new Set(authorized.mcpServers);
  let mcpServers = enabledMcpServers.filter((s) => allowedMcpNames.has(s.name));

  if (input.agentMode === "plan") {
    tools = tools.filter((tool) => tool === "update_plan" || isAgentControlPlaneTool(tool));
    mcpServers = [];
  }

  return {
    tools,
    mcpServerNames: mcpServers.map((s) => s.name),
    mcpServers,
  };
}

export async function authorizeCapability(call: CapabilityCall): Promise<CapabilityDecision> {
  const def = call.agentDefinition;
  const policy = await sandboxExecutor.loadPolicy(def);
  const agentMode = call.agentMode ?? null;

  if (call.isMcp || Boolean(call.serverName)) {
    return authorizeMcp(call, policy);
  }

  const toolName = call.name;
  if (
    agentMode &&
    !isToolAllowedInAgentControlMode(agentMode as AgentControlMode, toolName)
  ) {
    return deny(
      "plan_mode_blocked",
      `Plan 模式不允许工具 ${toolName}`,
      "改用 update_plan 保存计划，或退出 Plan 模式后再执行。",
      ["update_plan"]
    );
  }

  if (isTopologyTeamTool(toolName)) {
    return authorizeTeam(toolName, policy);
  }

  const route = resolveToolExecutionRoute(toolName);
  const contract = isToolContractEnabled() ? getToolContract(route.effectiveName) : undefined;
  if (contract?.lifecycle === "stub" || contract?.lifecycle === "deprecated") {
    return deny(
      "lifecycle_hidden",
      `工具 ${route.effectiveName} 已标记为 ${contract.lifecycle}`,
      "请改用 catalog 中的替代工具。"
    );
  }

  if (route.route === "connector") {
    const connectorName = route.connectorName ?? resolveConnectorForTool(route.effectiveName);
    if (!connectorName || !isConnectorAuthorized(policy, connectorName)) {
      return deny(
        "tool_not_allowed",
        `connector "${connectorName ?? route.effectiveName}" 不在沙箱白名单`,
        "请换已授权的 connector 工具，或调整 sandbox 策略。"
      );
    }
    return {
      ok: true,
      canonicalName: route.effectiveName,
      kind: "connector",
      connectorName,
      timeoutMs: resolveTimeoutMs(route.effectiveName, policy.maxToolCallMs),
      ...(contract ? { contractName: contract.name } : {}),
    };
  }

  if (!isToolAuthorized(policy, route.effectiveName)) {
    return deny(
      "tool_not_allowed",
      `工具 "${route.effectiveName}" 不在沙箱白名单`,
      "请改用可用工具列表中的工具。"
    );
  }

  return {
    ok: true,
    canonicalName: route.effectiveName,
    kind: "builtin",
    timeoutMs: resolveTimeoutMs(route.effectiveName, policy.maxToolCallMs),
    ...(contract ? { contractName: contract.name } : {}),
  };
}

async function authorizeMcp(
  call: CapabilityCall,
  policy: LoadedSandboxPolicy
): Promise<CapabilityDecision> {
  const serverName = (call.serverName ?? "").trim();
  if (!serverName) {
    return deny(
      "mcp_server_disabled",
      "call_mcp 缺少 serverName",
      "请传入 enabled MCP server 名称。",
      [...policy.allowedMcpServers].sort()
    );
  }

  if (!isMcpAuthorized(policy, serverName)) {
    return deny(
      "mcp_server_disabled",
      `mcp server "${serverName}" 不在沙箱 MCP 白名单`,
      "请改用 allowlist 中的 server。",
      [...policy.allowedMcpServers].sort()
    );
  }

  const enabled = await resolveEnabledMcpServers(
    call.agentDefinition.mcpServers ?? [],
    call.projectId ?? undefined
  );
  const allowlist = enabled.map((s) => s.name).sort();
  if (!enabled.some((s) => s.name === serverName)) {
    return deny(
      "mcp_server_disabled",
      `mcp server "${serverName}" is not enabled or in cooldown`,
      `请改用当前可用 MCP：allowed=[${allowlist.join(", ") || "(none)"}]`,
      allowlist
    );
  }

  return {
    ok: true,
    canonicalName: call.mcpTool ? `${serverName}/${call.mcpTool}` : serverName,
    kind: "mcp",
    serverName,
    timeoutMs: timeoutMsForClass("mcp", policy.maxToolCallMs),
  };
}

function authorizeTeam(toolName: string, policy: LoadedSandboxPolicy): CapabilityDecision {
  if (!isToolAuthorized(policy, toolName)) {
    return deny(
      "tool_not_allowed",
      `team 工具 ${toolName} 不在沙箱白名单`,
      "将 call_team_* 加入 sandbox allowedTools 或 agent definition.tools。"
    );
  }
  const timeoutMs =
    resolveTopologyToolTimeoutMs(toolName) ?? timeoutMsForClass("team", policy.maxToolCallMs);
  return {
    ok: true,
    canonicalName: toolName,
    kind: "team",
    timeoutMs,
  };
}

function resolveTimeoutMs(toolName: string, policyMax: number): number {
  const contract = isToolContractEnabled() ? getToolContract(toolName) : undefined;
  if (contract) return timeoutMsForClass(contract.timeoutClass, policyMax);
  const teamTimeout = resolveTopologyToolTimeoutMs(toolName);
  if (teamTimeout !== undefined) return teamTimeout;
  return policyMax;
}

function deny(
  code: CapabilityDeny["code"],
  message: string,
  hint: string,
  allowlist?: string[]
): CapabilityDeny {
  return {
    ok: false,
    code,
    message: `gate_denied:${code}: ${message}`,
    hint,
    ...(allowlist ? { allowlist } : {}),
    retryable: false,
  };
}
