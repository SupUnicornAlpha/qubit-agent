/**
 * 工具执行路由单一事实源（runtime 4.5 收敛 · A 类冗余治理）。
 *
 * 合并 resolveToolAlias + connector 映射 + builtin 注册表，统一决定
 * mcp | connector | builtin。规则：别名解析后，若目标已在 builtin 注册，
 * **优先 builtin**，避免 TOOL_CONNECTOR_ROUTES 与 BUILTIN_HANDLERS 双栈并存时
 * 仍走旧 connector 路径。
 */

import { isBuiltinTool } from "./builtin-tools";
import { resolveToolAlias } from "./tool-catalog";
import { resolveConnectorForTool } from "./tool-routes";

export type ToolExecutionRouteKind = "mcp" | "connector" | "builtin";

export type ToolExecutionRoute = {
  /** 别名解析后的工具名（dispatch 用这个） */
  effectiveName: string;
  originalName: string;
  aliased: boolean;
  replacedBy?: string;
  route: ToolExecutionRouteKind;
  connectorName?: string;
};

/**
 * 解析非 MCP 工具的执行路由（MCP connector 别名改写仍在 act 节点完成）。
 */
export function resolveToolExecutionRoute(toolName: string): ToolExecutionRoute {
  const alias = resolveToolAlias(toolName);
  const effectiveName = alias.resolved;

  if (isBuiltinTool(effectiveName)) {
    return {
      effectiveName,
      originalName: alias.originalName,
      aliased: alias.aliased,
      ...(alias.replacedBy ? { replacedBy: alias.replacedBy } : {}),
      route: "builtin",
    };
  }

  const connectorName = resolveConnectorForTool(effectiveName);
  if (connectorName) {
    return {
      effectiveName,
      originalName: alias.originalName,
      aliased: alias.aliased,
      ...(alias.replacedBy ? { replacedBy: alias.replacedBy } : {}),
      route: "connector",
      connectorName,
    };
  }

  return {
    effectiveName,
    originalName: alias.originalName,
    aliased: alias.aliased,
    ...(alias.replacedBy ? { replacedBy: alias.replacedBy } : {}),
    route: "builtin",
  };
}

/** act / reason 共用的 targetKind 标签 */
export function toolRouteToTargetKind(
  route: ToolExecutionRouteKind
): "mcp" | "tool" | "connector" {
  if (route === "mcp") return "mcp";
  if (route === "connector") return "connector";
  return "tool";
}

export function toolRouteToToolKind(
  route: ToolExecutionRouteKind
): "mcp" | "builtin" | "acp_connector" {
  if (route === "mcp") return "mcp";
  if (route === "connector") return "acp_connector";
  return "builtin";
}
