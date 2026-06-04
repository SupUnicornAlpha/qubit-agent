/**
 * P9 install-service 单测：抽自 agent.routes 的 install 主体。
 *   1) catalog 不存在 → CatalogNotFoundError
 *   2) 全新装：写 mcp_server_config + mcp_tool_binding + mcp_catalog_install
 *   3) 已有 server name → 复用 + 更新（reusedServer=true）
 *   4) 已有 binding (server+tool+null def) → 复用 + 重新 enable
 *   5) toolName 缺省 → 用 catalog.defaultToolName，再缺 → "ping"
 *   6) installedBy 透传到 audit 行
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../../../config";
import { closeDb, getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  mcpCatalog,
  mcpCatalogInstall,
  mcpServerConfig,
  mcpToolBinding,
} from "../../../db/sqlite/schema";
import { CatalogNotFoundError, installMcpCatalogToProject } from "../install-service";

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p9-install-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(mcpCatalogInstall).run();
  await db.delete(mcpToolBinding).run();
  await db.delete(mcpServerConfig).run();
  await db.delete(mcpCatalog).run();
  await db
    .insert(mcpCatalog)
    .values({
      id: "c_slack",
      slug: "slack",
      name: "Slack",
      transport: "stdio",
      command: "npx -y @x/slack",
      defaultToolName: "post_message",
      defaultTimeoutMs: 30_000,
      defaultRetryPolicyJson: { maxAttempts: 2 },
      defaultRateLimitJson: { rpm: 60 },
      defaultCapabilitiesJson: ["chat"],
    })
    .run();
});

afterEach(async () => {
  /* state per-test via beforeEach */
});

describe("installMcpCatalogToProject", () => {
  test("catalog 不存在 → CatalogNotFoundError", async () => {
    await expect(
      installMcpCatalogToProject({ catalogId: "missing", serverName: "x" })
    ).rejects.toThrow(CatalogNotFoundError);
  });

  test("全新装：建 server + binding + audit", async () => {
    const r = await installMcpCatalogToProject({
      catalogId: "c_slack",
      serverName: "slack-prod",
    });
    expect(r.installId).toBeTruthy();
    expect(r.catalogSlug).toBe("slack");
    expect(r.toolName).toBe("post_message");
    expect(r.reusedServer).toBe(false);
    expect(r.reusedBinding).toBe(false);

    const db = await getDb();
    const [s] = await db
      .select()
      .from(mcpServerConfig)
      .where(eq(mcpServerConfig.name, "slack-prod"));
    expect(s).toBeDefined();
    expect(s!.command).toBe("npx -y @x/slack");

    const [b] = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "slack-prod"));
    expect(b).toBeDefined();
    expect(b!.toolName).toBe("post_message");
    expect(b!.timeoutMs).toBe(30_000);

    const [a] = await db
      .select()
      .from(mcpCatalogInstall)
      .where(eq(mcpCatalogInstall.id, r.installId));
    expect(a).toBeDefined();
    expect(a!.installedBy).toBe("user");
  });

  test("二次装同 serverName → reusedServer + reusedBinding", async () => {
    await installMcpCatalogToProject({ catalogId: "c_slack", serverName: "slack-prod" });
    const r2 = await installMcpCatalogToProject({
      catalogId: "c_slack",
      serverName: "slack-prod",
    });
    expect(r2.reusedServer).toBe(true);
    expect(r2.reusedBinding).toBe(true);

    const db = await getDb();
    // 不能造成重复行
    const servers = await db
      .select()
      .from(mcpServerConfig)
      .where(eq(mcpServerConfig.name, "slack-prod"));
    expect(servers.length).toBe(1);
    const bindings = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "slack-prod"));
    expect(bindings.length).toBe(1);
  });

  test("toolName 显式覆盖 catalog default", async () => {
    const r = await installMcpCatalogToProject({
      catalogId: "c_slack",
      serverName: "slack-prod",
      toolName: "list_channels",
    });
    expect(r.toolName).toBe("list_channels");
  });

  test("catalog 无 defaultToolName + 未传 → fallback 'ping'", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_void",
        slug: "void",
        name: "Void",
        transport: "stdio",
        defaultToolName: "",
      })
      .run();
    const r = await installMcpCatalogToProject({ catalogId: "c_void", serverName: "void-srv" });
    expect(r.toolName).toBe("ping");
  });

  test("installedBy='auto_installer' → audit 行透传", async () => {
    const r = await installMcpCatalogToProject({
      catalogId: "c_slack",
      serverName: "slack-auto",
      installedBy: "auto_installer",
    });
    const db = await getDb();
    const [a] = await db
      .select()
      .from(mcpCatalogInstall)
      .where(eq(mcpCatalogInstall.id, r.installId));
    expect(a!.installedBy).toBe("auto_installer");
  });
});
