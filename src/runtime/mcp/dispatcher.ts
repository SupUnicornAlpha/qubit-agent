import { and, eq, or } from "drizzle-orm";
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
}

export interface McpDispatchResult {
  serverName: string;
  toolName: string;
  transport: "stdio" | "http" | "ws";
  accepted: boolean;
  output: Record<string, unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function stringifyResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  return { value: result as string | number | boolean | null };
}

async function resolveTimeoutMs(serverName: string, toolName: string): Promise<number> {
  const db = await getDb();
  const exact = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.toolName, toolName),
        eq(mcpToolBinding.enabled, true)
      )
    )
    .limit(1);
  if (exact[0]?.timeoutMs) return exact[0].timeoutMs;
  const wildcard = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.toolName, "*"),
        eq(mcpToolBinding.enabled, true)
      )
    )
    .limit(1);
  if (wildcard[0]?.timeoutMs) return wildcard[0].timeoutMs;
  return 60_000;
}

async function assertToolBindingNotDisabled(serverName: string, toolName: string) {
  const db = await getDb();
  const rows = await db.select().from(mcpToolBinding).where(eq(mcpToolBinding.serverName, serverName));
  for (const row of rows) {
    if (row.toolName !== toolName && row.toolName !== "*") continue;
    if (!row.enabled) throw new Error(`mcp tool binding disabled: ${serverName}/${toolName}`);
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
        .where(and(eq(mcpServerConfig.name, input.serverName), eq(mcpServerConfig.enabled, true)))
        .limit(1);
      const server = rows[0];
      if (!server) {
        throw new Error(`mcp server "${input.serverName}" not found or disabled`);
      }

      await assertToolBindingNotDisabled(input.serverName, input.toolName);
      const timeoutMs = await resolveTimeoutMs(input.serverName, input.toolName);
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
