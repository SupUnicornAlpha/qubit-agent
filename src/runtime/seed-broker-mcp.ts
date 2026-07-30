import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { mcpServerConfig } from "../db/sqlite/schema";
import { syncServerDefaultStarBinding } from "./mcp/default-star-binding";

export const QUBIT_BROKER_MCP_NAME = "qubit-broker";

export async function seedBrokerMcpServer(): Promise<void> {
  const db = await getDb();
  const command = "bun run src/runtime/mcp/broker-mcp-server.ts";

  const existing = await db
    .select()
    .from(mcpServerConfig)
    .where(and(eq(mcpServerConfig.name, QUBIT_BROKER_MCP_NAME), isNull(mcpServerConfig.projectId)))
    .limit(1);

  const caps = {
    description: "QUBIT 券商执行：健康检查、下单（需 intent）、撤单、成交、持仓",
  };

  if (existing[0]) {
    await db
      .update(mcpServerConfig)
      .set({
        transport: "stdio",
        command,
        capabilitiesJson: caps,
        enabled: true,
      })
      .where(eq(mcpServerConfig.id, existing[0].id));
  } else {
    await db.insert(mcpServerConfig).values({
      id: randomUUID(),
      name: QUBIT_BROKER_MCP_NAME,
      projectId: null,
      transport: "stdio",
      command,
      url: null,
      capabilitiesJson: caps,
      enabled: true,
    });
  }

  await syncServerDefaultStarBinding({
    serverName: QUBIT_BROKER_MCP_NAME,
    projectId: null,
    enabled: true,
    timeoutMs: 120_000,
  });

  console.log(`[Seed] Upserted MCP server "${QUBIT_BROKER_MCP_NAME}" with default tool binding.`);
}

if (import.meta.main) {
  void seedBrokerMcpServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
