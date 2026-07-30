/**
 * syncServerDefaultStarBinding：启用 server → 自动 `*`；禁用 → disable `*`。
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../../../config";
import { closeDb, getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { mcpServerConfig, mcpToolBinding, project, workspace } from "../../../db/sqlite/schema";
import {
  MCP_WILDCARD_TOOL,
  syncServerDefaultStarBinding,
} from "../default-star-binding";

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-star-bind-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(mcpToolBinding).run();
  await db.delete(mcpServerConfig).run();
  await db.delete(project).run();
  await db.delete(workspace).run();
});

describe("syncServerDefaultStarBinding", () => {
  test("enabled=true 且无行 → 创建 *", async () => {
    const r = await syncServerDefaultStarBinding({
      serverName: "mathjs",
      projectId: null,
      enabled: true,
      timeoutMs: 15_000,
    });
    expect(r.created).toBe(true);
    expect(r.updated).toBe(false);
    expect(r.bindingId).toBeTruthy();

    const db = await getDb();
    const [row] = await db
      .select()
      .from(mcpToolBinding)
      .where(
        and(
          eq(mcpToolBinding.serverName, "mathjs"),
          eq(mcpToolBinding.toolName, MCP_WILDCARD_TOOL),
          isNull(mcpToolBinding.projectId),
          isNull(mcpToolBinding.definitionId)
        )
      );
    expect(row?.enabled).toBe(true);
    expect(row?.timeoutMs).toBe(15_000);
  });

  test("再次 enabled=true → 幂等不重复", async () => {
    await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: true,
    });
    const r2 = await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: true,
    });
    expect(r2.created).toBe(false);
    expect(r2.updated).toBe(false);

    const db = await getDb();
    const rows = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "mathjs"));
    expect(rows.length).toBe(1);
  });

  test("enabled=false → 禁用已有 *，不删行", async () => {
    await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: true,
    });
    const r = await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: false,
    });
    expect(r.updated).toBe(true);

    const db = await getDb();
    const [row] = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "mathjs"));
    expect(row?.enabled).toBe(false);
  });

  test("enabled=false 且无行 → 不创建", async () => {
    const r = await syncServerDefaultStarBinding({
      serverName: "ghost",
      enabled: false,
    });
    expect(r.created).toBe(false);
    expect(r.bindingId).toBeNull();
    const db = await getDb();
    const rows = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "ghost"));
    expect(rows.length).toBe(0);
  });

  test("不覆盖已有 timeout（仅新建时写入）", async () => {
    await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: true,
      timeoutMs: 10_000,
    });
    await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: false,
    });
    await syncServerDefaultStarBinding({
      serverName: "mathjs",
      enabled: true,
      timeoutMs: 99_000,
    });
    const db = await getDb();
    const [row] = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "mathjs"));
    expect(row?.timeoutMs).toBe(10_000);
    expect(row?.enabled).toBe(true);
  });

  test("project 作用域隔离", async () => {
    const db = await getDb();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
    await db
      .insert(project)
      .values({
        id: projectId,
        workspaceId,
        name: "p",
        marketScope: "CN",
      })
      .run();

    await syncServerDefaultStarBinding({
      serverName: "shared",
      projectId: null,
      enabled: true,
    });
    await syncServerDefaultStarBinding({
      serverName: "shared",
      projectId,
      enabled: true,
    });
    const rows = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.serverName, "shared"));
    expect(rows.length).toBe(2);
  });
});
