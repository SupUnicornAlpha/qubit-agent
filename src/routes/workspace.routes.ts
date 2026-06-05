import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { workspace, project } from "../db/sqlite/schema";
import { eq } from "drizzle-orm";
import {
  DEFAULT_USER_WORKSPACE_ID,
  DEFAULT_USER_WORKSPACE_NAME,
  DEFAULT_USER_WORKSPACE_OWNER,
  ensureDefaultUserWorkspace,
} from "../runtime/bootstrap/ensure-default-workspace";

export const workspaceRouter = new Hono();

workspaceRouter.get("/", async (c) => {
  const db = await getDb();
  const rows = await db.select().from(workspace);
  return c.json({ data: rows });
});

workspaceRouter.post("/", async (c) => {
  const body = await c.req.json<{ name: string; owner: string }>();
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.insert(workspace).values({ id, name: body.name, owner: body.owner });
  const created = await db.select().from(workspace).where(eq(workspace.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

/**
 * 返回单租户兜底 workspace。前端 boot 阶段调这个端点，省去自己
 * `if (!workspaces[0]) createWorkspace()` 兜底 —— 历史那段兜底因为
 * A2A Pool 永远占着 workspaces[0] 从未真正触发，造成前端"上车"用了
 * system workspace 的乌龙。
 *
 * 路由顺序重要：必须放在 `GET /:id` 之前，否则会被参数化路由捕获。
 *
 * 兜底逻辑：若 workspace 不存在（极小概率：DB 在 bootstrap 之外被外部
 * 工具创建），即时 ensure 一次再返回，避免给前端返 404 引起白屏。
 */
workspaceRouter.get("/default", async (c) => {
  const db = await getDb();
  let rows = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, DEFAULT_USER_WORKSPACE_ID))
    .limit(1);
  if (!rows[0]) {
    await ensureDefaultUserWorkspace();
    rows = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, DEFAULT_USER_WORKSPACE_ID))
      .limit(1);
  }
  return c.json({
    data: rows[0] ?? {
      id: DEFAULT_USER_WORKSPACE_ID,
      name: DEFAULT_USER_WORKSPACE_NAME,
      owner: DEFAULT_USER_WORKSPACE_OWNER,
    },
  });
});

workspaceRouter.get("/:id", async (c) => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workspace)
    .where(eq(workspace.id, c.req.param("id")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  return c.json({ data: rows[0] });
});

workspaceRouter.get("/:id/projects", async (c) => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(project)
    .where(eq(project.workspaceId, c.req.param("id")));
  return c.json({ data: rows });
});

workspaceRouter.post("/:id/projects", async (c) => {
  const body = await c.req.json<{
    name: string;
    marketScope: string;
    status?: "active" | "archived" | "paused";
  }>();
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.insert(project).values({
    id,
    workspaceId: c.req.param("id"),
    name: body.name,
    marketScope: body.marketScope,
    status: body.status ?? "active",
  });
  const created = await db.select().from(project).where(eq(project.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});
