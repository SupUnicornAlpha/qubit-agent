import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { orchestratorAgent } from "../agents/orchestrator";

export const workflowRouter = new Hono();

workflowRouter.get("/", async (c) => {
  const db = await getDb();
  const rows = await db.select().from(workflowRun).limit(50);
  return c.json({ data: rows });
});

workflowRouter.post("/", async (c) => {
  const body = await c.req.json<{
    projectId: string;
    goal: string;
    mode: "research" | "backtest" | "simulation" | "live";
  }>();

  const db = await getDb();
  const id = crypto.randomUUID();

  await db.insert(workflowRun).values({
    id,
    projectId: body.projectId,
    goal: body.goal,
    mode: body.mode,
    status: "pending",
  });

  // Kick off orchestration
  await orchestratorAgent.assignTask(id, orchestratorAgent.id, {
    taskId: crypto.randomUUID(),
    taskType: "workflow_start",
    params: { workflowRunId: id, goal: body.goal, mode: body.mode },
    assignedRole: "orchestrator",
  });

  const created = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, id))
    .limit(1);

  return c.json({ data: created[0] }, 201);
});

workflowRouter.get("/:id", async (c) => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, c.req.param("id")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  return c.json({ data: rows[0] });
});
