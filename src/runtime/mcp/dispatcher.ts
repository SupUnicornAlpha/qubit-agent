import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerConfig, mcpToolBinding } from "../../db/sqlite/schema";
import { executeWithPolicy } from "../external-call/policy";
import { callMcpHttpTool, httpEndpointFromServer, httpHeadersFromCaps } from "./http-transport";
import { callMcpStdioTool, stdioArgvFromServer } from "./stdio-session";
import { callMcpWsTool } from "./ws-transport";

export interface McpDispatchInput {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  projectId?: string;
  /** When set, prefers `mcp_tool_binding` rows scoped to this agent definition; falls back to rows with null definition_id. */
  definitionId?: string;
}

export interface McpDispatchResult {
  serverName: string;
  toolName: string;
  transport: "stdio" | "http" | "ws";
  accepted: boolean;
  output: Record<string, unknown>;
}

type McpBindingRow = typeof mcpToolBinding.$inferSelect;

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function stringifyResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  return { value: result as string | number | boolean | null };
}

/** Higher = more specific for dispatch (definition → project → exact tool name). */
function bindingSpecificityScore(row: McpBindingRow, toolName: string, projectId: string | undefined, definitionId: string | undefined): number {
  let defS = 0;
  if (definitionId) {
    if (row.definitionId === definitionId) defS = 3;
    else if (row.definitionId == null) defS = 1;
    else return -1;
  } else {
    if (row.definitionId != null) return -1;
    defS = 1;
  }

  let projS = 0;
  if (projectId) {
    if (row.projectId === projectId) projS = 3;
    else if (row.projectId == null) projS = 1;
    else return -1;
  } else {
    if (row.projectId != null) return -1;
    projS = 1;
  }

  let toolS = 0;
  if (row.toolName === toolName) toolS = 3;
  else if (row.toolName === "*") toolS = 1;
  else return -1;

  return defS * 100 + projS * 10 + toolS;
}

function pickBestBindingRow(
  rows: McpBindingRow[],
  toolName: string,
  projectId: string | undefined,
  definitionId: string | undefined,
  requireEnabled: boolean
): McpBindingRow | undefined {
  const candidates = rows
    .map((row) => ({ row, score: bindingSpecificityScore(row, toolName, projectId, definitionId) }))
    .filter((x) => x.score >= 0 && (!requireEnabled || x.row.enabled));
  if (!candidates.length) return undefined;
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.row.enabled !== b.row.enabled) return a.row.enabled ? -1 : 1;
    return 0;
  });
  return candidates[0]!.row;
}

async function resolveTimeoutMs(
  serverName: string,
  toolName: string,
  projectId?: string,
  definitionId?: string
): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.enabled, true),
        or(eq(mcpToolBinding.toolName, toolName), eq(mcpToolBinding.toolName, "*")),
        projectId ? or(eq(mcpToolBinding.projectId, projectId), isNull(mcpToolBinding.projectId)) : undefined
      )
    );
  const exact = pickBestBindingRow(rows, toolName, projectId, definitionId, true);
  if (exact?.timeoutMs) return exact.timeoutMs;
  return 60_000;
}

async function assertToolBindingNotDisabled(
  serverName: string,
  toolName: string,
  projectId?: string,
  definitionId?: string
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        projectId ? or(eq(mcpToolBinding.projectId, projectId), isNull(mcpToolBinding.projectId)) : undefined
      )
    );
  const best = pickBestBindingRow(rows, toolName, projectId, definitionId, false);
  if (best && !best.enabled) {
    throw new Error(`mcp tool binding disabled: ${serverName}/${toolName}`);
  }
}

export async function dispatchMcpToolCall(input: McpDispatchInput): Promise<McpDispatchResult> {
  return executeWithPolicy(
    {
      scopeKey: `mcp:${input.serverName}:${input.toolName}`,
      retry: { maxAttempts: 2, backoffMs: 150, backoffMultiplier: 2 },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
      idempotency: {
        enabled: true,
        key: `mcp:${input.serverName}:${input.toolName}:${JSON.stringify(input.arguments ?? {})}`,
        ttlMs: 10_000,
      },
    },
    async () => {
      const db = await getDb();
      const rows = await db
        .select()
        .from(mcpServerConfig)
        .where(
          and(
            eq(mcpServerConfig.name, input.serverName),
            eq(mcpServerConfig.enabled, true),
            input.projectId
              ? or(eq(mcpServerConfig.projectId, input.projectId), eq(mcpServerConfig.projectId, null))
              : undefined
          )
        );
      const server =
        rows.find((row) => row.projectId === input.projectId) ?? rows.find((row) => row.projectId == null);
      if (!server) {
        throw new Error(`mcp server "${input.serverName}" not found or disabled`);
      }

      await assertToolBindingNotDisabled(input.serverName, input.toolName, input.projectId, input.definitionId);
      const timeoutMs = await resolveTimeoutMs(
        input.serverName,
        input.toolName,
        input.projectId,
        input.definitionId
      );
      const caps = server.capabilitiesJson;

      let result: unknown;
      if (server.transport === "stdio") {
        const argv = stdioArgvFromServer(server.command, caps);
        const envObj = asRecord(asRecord(caps).env);
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(envObj)) {
          if (typeof v === "string") env[k] = v;
        }
        const cwd = typeof asRecord(caps).cwd === "string" ? (asRecord(caps).cwd as string) : undefined;
        result = await callMcpStdioTool({
          serverKey: input.serverName,
          argv,
          env,
          cwd,
          requestTimeoutMs: timeoutMs,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
        });
      } else if (server.transport === "http") {
        const url = httpEndpointFromServer(server.url, caps);
        const headers = httpHeadersFromCaps(caps);
        result = await callMcpHttpTool({
          postUrl: url,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          headers,
          timeoutMs,
        });
      } else if (server.transport === "ws") {
        if (!server.url) throw new Error("MCP ws: mcp_server_config.url is required");
        result = await callMcpWsTool({
          wsUrl: server.url,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          timeoutMs,
        });
      } else {
        throw new Error(`unsupported mcp transport: ${server.transport}`);
      }

      return {
        serverName: input.serverName,
        toolName: input.toolName,
        transport: server.transport,
        accepted: true,
        output: stringifyResult(result),
      };
    }
  );
}
