/**
 * ToolCapabilityGate — single authorize entry for builtin/connector/mcp/team.
 * See docs/agent-contracts/02-capability-gate.md
 */

import type { AgentControlMode } from "../../types/loop";
import { isAgentControlPlaneTool, isToolAllowedInAgentControlMode } from "../agent-control-mode";
import { FINANCEX_FALLBACK_TOOLS, resolveFinancexFallbackToolName } from "../mcp/financex-fallback";
import {
  type EnabledMcpServerInfo,
  filterMcpToolsByAvailability,
  resolveEnabledMcpServers,
} from "../mcp/resolve-enabled-mcp-servers";
import { resolveEffectiveAgentTools } from "../orchestration/resolve-effective-tools";
import {
  isTopologyTeamTool,
  loadOrchestratorTopologyForWorkflow,
  resolveTopologyToolTimeoutMs,
} from "../orchestration/topology-dispatch";
import {
  type LoadedSandboxPolicy,
  isConnectorAuthorized,
  isMcpAuthorized,
  isToolAuthorized,
  sandboxExecutor,
} from "../sandbox-executor";
import type { RuntimeAgentDefinition } from "../types";
import { isToolContractEnabled, timeoutMsForClass } from "./tool-contract";
import { getToolContract } from "./tool-contract-registry";
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
    | "ask_mode_blocked"
    | "topology_role_blocked"
    | "lifecycle_hidden";
  message: string;
  hint: string;
  allowlist?: string[];
  retryable: false;
};

export type CapabilityDecision = CapabilityAllow | CapabilityDeny;

export function isCapabilityGateEnabled(): boolean {
  return process.env.CAPABILITY_GATE_ENABLED !== "0";
}

export type AuthorizedCapabilitySurface = {
  tools: string[];
  mcpServerNames: string[];
  mcpServers: Array<{ name: string; tools?: Array<{ name: string; desc?: string }> }>;
};

function financexFallbackPromptServer(): EnabledMcpServerInfo {
  return {
    name: "mcp-financex",
    tools: [...FINANCEX_FALLBACK_TOOLS].sort().map((name) => ({
      name,
      desc: "financex 不可用时自动降级到内置只读行情/新闻数据源",
    })),
  };
}

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
  const policy = await sandboxExecutor.loadPolicy(input.agentDefinition);
  const financexFallbackEnabled =
    input.agentDefinition.mcpServers.includes("mcp-financex") &&
    isMcpAuthorized(policy, "mcp-financex") &&
    !enabledMcpServers.some((server) => server.name === "mcp-financex");
  // A disabled financex process is not exposed as a remote MCP.  Its four
  // documented read-only operations are virtualized by dispatcher fallback,
  // so include that narrow surface in the prompt and avoid wasted retry turns.
  const availableMcpServers = financexFallbackEnabled
    ? [...enabledMcpServers, financexFallbackPromptServer()]
    : enabledMcpServers;
  const authorized = await sandboxExecutor.filterAuthorizedTools(
    input.agentDefinition,
    effective.tools,
    availableMcpServers.map((s) => s.name)
  );
  let tools = filterMcpToolsByAvailability(authorized.tools, authorized.mcpServers);
  const allowedMcpNames = new Set(authorized.mcpServers);
  let mcpServers = availableMcpServers.filter((s) => allowedMcpNames.has(s.name));

  if (input.agentMode === "plan") {
    tools = tools.filter((tool) => tool === "update_plan" || isAgentControlPlaneTool(tool));
    mcpServers = [];
  } else if (input.agentMode === "ask") {
    tools = tools.filter(
      (tool) =>
        tool === "update_plan" ||
        tool === "workspace.read" ||
        tool === "workspace.list" ||
        tool === "session.diagnose" ||
        isAgentControlPlaneTool(tool)
    );
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
  if (agentMode && !isToolAllowedInAgentControlMode(agentMode as AgentControlMode, toolName)) {
    const askBlocked = agentMode === "ask";
    return deny(
      askBlocked ? "ask_mode_blocked" : "plan_mode_blocked",
      askBlocked ? `Ask 模式不允许工具 ${toolName}` : `Plan 模式不允许工具 ${toolName}`,
      askBlocked
        ? "Ask 仅允许只读控制面工具，或切换到 Agent/Goal 后再执行。"
        : "改用 update_plan 保存计划，或退出 Plan 模式后再执行。",
      askBlocked
        ? ["update_plan", "workspace.read", "workspace.list", "session.diagnose"]
        : ["update_plan"]
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

  // Prompt visibility alone is not a security boundary: a provider can still
  // emit a stale or hand-written builtin call. Enforce the same workflow
  // surface here so scoped Harness tools (notably math-audit) cannot bypass
  // their lease at execution time.
  const effective = await resolveEffectiveAgentTools(def, call.workflowId);
  if (!effective.tools.includes(route.effectiveName)) {
    return deny(
      "tool_not_allowed",
      `工具 \"${route.effectiveName}\" 未在当前 workflow 的能力租约中启用`,
      "请在工作流配置中显式启用所需 Harness，或改用当前工具面中的工具。",
      effective.tools
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
  // `call_mcp` is the native entry point.  Checking only the target server
  // would let a hand-written tool call bypass the prompt surface, which
  // already filters this name through the normal tool allowlist.
  if (!isToolAuthorized(policy, call.name)) {
    return deny(
      "tool_not_allowed",
      `工具 \"${call.name}\" 不在沙箱白名单`,
      "请只调用当前可用工具列表中的 call_mcp，或调整 sandbox 策略。"
    );
  }

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
    // financex 的这组工具会在 dispatcher 中被改写为内置、只读的行情/新闻查询。
    // 允许它们穿过“远端 server 当前不可用”的可用性检查，才能进入该 fallback；
    // sandbox MCP 白名单和工具入口白名单已在上方校验，未映射的 financex 工具及其他
    // MCP 仍照常拒绝，绝不把冷却 server 本身重新启用。
    if (serverName === "mcp-financex" && resolveFinancexFallbackToolName(call.mcpTool ?? "")) {
      return {
        ok: true,
        canonicalName: `${serverName}/${call.mcpTool}`,
        kind: "mcp",
        serverName,
        timeoutMs: timeoutMsForClass("mcp", policy.maxToolCallMs),
      };
    }
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

async function authorizeTeam(
  toolName: string,
  policy: LoadedSandboxPolicy
): Promise<CapabilityDecision> {
  if (!isToolAuthorized(policy, toolName)) {
    return deny(
      "tool_not_allowed",
      `team 工具 ${toolName} 不在沙箱白名单`,
      "将 call_team_* 加入 sandbox allowedTools 或 agent definition.tools。"
    );
  }

  // The sandbox can authorize a historical/dangling tool name.  It must still
  // map to an enabled specialist before it is advertised as executable.
  const topology = await loadOrchestratorTopologyForWorkflow();
  if (!topology.toolNames.includes(toolName)) {
    return deny(
      "topology_role_blocked",
      `team 工具 ${toolName} 没有对应的已启用专家角色`,
      "请从当前拓扑提供的 call_team_<role> 工具中选择目标。",
      topology.toolNames
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
