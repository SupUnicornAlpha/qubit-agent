import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerConfig } from "../../db/sqlite/schema";
import { executeWithPolicy } from "../external-call/policy";

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

/**
 * 当前阶段先打通 Runtime -> MCP 的标准调度壳层。
 * 后续可在此接入真实 MCP 客户端（stdio/http/ws）。
 */
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

      // NOTE: runtime MCP transport adapter is intentionally lightweight in this milestone.
      return {
        serverName: input.serverName,
        toolName: input.toolName,
        transport: server.transport,
        accepted: true,
        output: {
          status: "accepted",
          message: "MCP runtime adapter placeholder accepted the request",
          arguments: input.arguments ?? {},
        },
      };
    }
  );
}
