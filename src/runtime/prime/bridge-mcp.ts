/**
 * Bridge helpers: expose Bun MCP servers to Prime Core as L2 tools (01 §8.2 / §11).
 *
 * Wire names:
 *   - `mcp:<server>:<tool>`  — advertised + preferred
 *   - `call_mcp`             — still invokable for back-compat, NOT listed on tools.list
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerConfig, mcpToolBinding } from "../../db/sqlite/schema";
import { isMcpServerInCooldown } from "../monitor/mcp-health-tracker";

export const MCP_META_TOOL = "call_mcp";
export const MCP_TOOL_PREFIX = "mcp:";

/**
 * Remote tools whose advertised schema/availability is not reliable enough for
 * the default model surface. Operators can replace the list with
 * QUBIT_MCP_QUARANTINED_TOOLS="server:tool,..." after validating a provider.
 */
export function quarantinedMcpToolKeys(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.QUBIT_MCP_QUARANTINED_TOOLS;
  const values = raw === undefined ? ["investor-agent:market_movers"] : raw.split(",");
  return new Set(values.map((value) => value.trim()).filter(Boolean));
}

export function isMcpToolQuarantined(
  serverName: string,
  toolName: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return quarantinedMcpToolKeys(env).has(`${serverName}:${toolName}`);
}

export type BridgedMcpToolSpec = {
  name: string;
  description: string;
  kind: "mcp";
  serverName: string;
  toolName: string;
};

export function parseMcpBridgeToolName(
  name: string
): { serverName: string; toolName: string } | null {
  const raw = name.trim();
  if (!raw.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = raw.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const serverName = rest.slice(0, idx).trim();
  const toolName = rest.slice(idx + 1).trim();
  if (!serverName || !toolName || toolName === "*") return null;
  return { serverName, toolName };
}

export function formatMcpBridgeToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}:${toolName}`;
}

export function isMcpBridgeToolName(name: string): boolean {
  return name === MCP_META_TOOL || Boolean(parseMcpBridgeToolName(name));
}

function parseCapabilityTools(raw: unknown): Array<{ name: string; desc?: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const toolsRaw = (raw as Record<string, unknown>).tools;
  if (!Array.isArray(toolsRaw)) return [];
  const out: Array<{ name: string; desc?: string }> = [];
  for (const item of toolsRaw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name || name === "*") continue;
    const desc = typeof obj.desc === "string" ? obj.desc : undefined;
    out.push(desc ? { name, desc } : { name });
  }
  return out;
}

/** List enabled MCP tools for Core advertisement via legacy.tools.list. */
export async function listBridgedMcpTools(): Promise<BridgedMcpToolSpec[]> {
  const db = await getDb();
  const servers = await db
    .select({
      name: mcpServerConfig.name,
      capabilitiesJson: mcpServerConfig.capabilitiesJson,
    })
    .from(mcpServerConfig)
    .where(and(eq(mcpServerConfig.enabled, true), isNull(mcpServerConfig.projectId)));

  const out: BridgedMcpToolSpec[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    if (await isMcpServerInCooldown(server.name)) continue;

    const fromCaps = parseCapabilityTools(server.capabilitiesJson);
    if (fromCaps.length > 0) {
      for (const t of fromCaps) {
        if (isMcpToolQuarantined(server.name, t.name)) continue;
        const wire = formatMcpBridgeToolName(server.name, t.name);
        if (seen.has(wire)) continue;
        seen.add(wire);
        out.push({
          name: wire,
          description: t.desc?.trim() || `MCP ${server.name}/${t.name} (bridged via Bun L2)`,
          kind: "mcp",
          serverName: server.name,
          toolName: t.name,
        });
      }
      continue;
    }

    const bindings = await db
      .select({
        toolName: mcpToolBinding.toolName,
      })
      .from(mcpToolBinding)
      .where(
        and(
          eq(mcpToolBinding.serverName, server.name),
          eq(mcpToolBinding.enabled, true),
          isNull(mcpToolBinding.projectId)
        )
      );
    for (const b of bindings) {
      const toolName = b.toolName?.trim();
      if (!toolName || toolName === "*") continue;
      if (isMcpToolQuarantined(server.name, toolName)) continue;
      const wire = formatMcpBridgeToolName(server.name, toolName);
      if (seen.has(wire)) continue;
      seen.add(wire);
      out.push({
        name: wire,
        description: `MCP ${server.name}/${toolName} (bridged via Bun L2)`,
        kind: "mcp",
        serverName: server.name,
        toolName,
      });
    }
  }

  // Do not advertise `call_mcp` — Core/models should use `mcp:<server>:<tool>` only.
  // Invoke path still accepts call_mcp for back-compat.
  return out;
}

export function resolveMcpInvokeTarget(
  name: string,
  args: Record<string, unknown>
): { serverName: string; toolName: string; arguments: Record<string, unknown> } | null {
  if (name === MCP_META_TOOL) {
    const serverName = String(args.serverName ?? args.server_name ?? "").trim();
    const toolName = String(
      args.toolName ?? args.tool_name ?? args.mcpTool ?? args.mcp_tool ?? ""
    ).trim();
    if (!serverName || !toolName) return null;
    const nested =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : args.params && typeof args.params === "object" && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : null;
    if (nested) {
      return { serverName, toolName, arguments: nested };
    }
    const rest: Record<string, unknown> = { ...args };
    for (const k of [
      "serverName",
      "server_name",
      "toolName",
      "tool_name",
      "mcpTool",
      "mcp_tool",
      "arguments",
      "params",
    ]) {
      delete rest[k];
    }
    return { serverName, toolName, arguments: rest };
  }
  const parsed = parseMcpBridgeToolName(name);
  if (!parsed) return null;
  return {
    serverName: parsed.serverName,
    toolName: parsed.toolName,
    arguments: args,
  };
}
