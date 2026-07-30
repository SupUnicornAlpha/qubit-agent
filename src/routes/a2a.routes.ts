import { Hono } from "hono";
import { requestA2ATaskCancellation } from "../runtime/a2a/a2a-task-cancellation";
import {
  getA2ATask,
  listA2ATaskEvents,
  listA2ATasksForWorkflow,
} from "../runtime/a2a/a2a-task-service";

/**
 * Read/recovery surface for the local A2A transport.  These endpoints are not
 * the inter-agent transport itself; they expose the same durable Task and
 * ordered event semantics to reconnecting UI and recovery workers.
 */
export const a2aRouter = new Hono();

a2aRouter.get("/tasks", async (c) => {
  const workflowId = c.req.query("workflowId")?.trim();
  if (!workflowId) return c.json({ error: "workflowId is required" }, 400);
  const requestedLimit = Number(c.req.query("limit") ?? "200");
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 200;
  const data = await listA2ATasksForWorkflow(workflowId, limit);
  return c.json({ data });
});

a2aRouter.get("/tasks/:taskId", async (c) => {
  const data = await getA2ATask(c.req.param("taskId"));
  if (!data) return c.json({ error: "A2A task not found" }, 404);
  return c.json({ data });
});

a2aRouter.get("/tasks/:taskId/events", async (c) => {
  const taskId = c.req.param("taskId");
  const task = await getA2ATask(taskId);
  if (!task) return c.json({ error: "A2A task not found" }, 404);
  const rawAfter = c.req.query("afterSequence");
  const afterSequence = rawAfter === undefined ? undefined : Number(rawAfter);
  if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < -1)) {
    return c.json({ error: "afterSequence must be an integer no smaller than -1" }, 400);
  }
  const requestedLimit = Number(c.req.query("limit") ?? "200");
  const limit = Number.isFinite(requestedLimit) ? requestedLimit : 200;
  const data = await listA2ATaskEvents(taskId, afterSequence, limit);
  return c.json({ data, task });
});

a2aRouter.post("/tasks/:taskId/cancel", async (c) => {
  const taskId = c.req.param("taskId");
  const task = await getA2ATask(taskId);
  if (!task) return c.json({ error: "A2A task not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : "cancelled_by_user";
  await requestA2ATaskCancellation(taskId, reason);
  return c.json({ data: await getA2ATask(taskId) });
});
