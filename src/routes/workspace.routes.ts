import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { workspace, project } from "../db/sqlite/schema";
import { eq } from "drizzle-orm";

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
