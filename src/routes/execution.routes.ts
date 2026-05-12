import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  brokerOrder,
  executionTask,
  executionTaskEvent,
  fill,
  orderIntent,
  riskHitLog,
} from "../db/sqlite/schema";
import {
  approveRiskReviewTicket,
  createOrderIntentWithExecution,
  rejectRiskReviewTicket,
  type CreateOrderIntentInput,
} from "../runtime/execution/order-intent-service";

export const executionRouter = new Hono();

executionRouter.post("/intents", async (c) => {
  const body = await c.req.json<Partial<CreateOrderIntentInput>>();
  if (
    !body.workflowRunId ||
    !body.strategyVersionId ||
    !body.instrumentId ||
    !body.side ||
    body.qty === undefined ||
    !body.orderType ||
    !body.timeInForce
  ) {
    return c.json(
      {
        error:
          "workflowRunId, strategyVersionId, instrumentId, side, qty, orderType, timeInForce are required",
      },
      400
    );
  }
  const db = await getDb();
  const result = await createOrderIntentWithExecution(db, {
    workflowRunId: body.workflowRunId,
    strategyVersionId: body.strategyVersionId,
    instrumentId: body.instrumentId,
    side: body.side,
    qty: Number(body.qty),
    orderType: body.orderType,
    price: body.price === undefined ? null : Number(body.price),
    timeInForce: body.timeInForce,
    accountId: body.accountId,
    traceId: body.traceId,
  });
  return c.json({ ok: true, data: result });
});

executionRouter.get("/intents/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const intents = await db.select().from(orderIntent).where(eq(orderIntent.id, id)).limit(1);
  const intent = intents[0];
  if (!intent) return c.json({ error: "not_found" }, 404);

  const tasks = await db.select().from(executionTask).where(eq(executionTask.orderIntentId, id)).limit(1);
  const hits = await db.select().from(riskHitLog).where(eq(riskHitLog.orderIntentId, id));

  return c.json({
    ok: true,
    data: {
      intent,
      executionTask: tasks[0] ?? null,
      riskHitLogs: hits,
    },
  });
});

executionRouter.get("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const tasks = await db.select().from(executionTask).where(eq(executionTask.id, id)).limit(1);
  const task = tasks[0];
  if (!task) return c.json({ error: "not_found" }, 404);

  const intents = await db
    .select()
    .from(orderIntent)
    .where(eq(orderIntent.id, task.orderIntentId))
    .limit(1);

  const orders = await db.select().from(brokerOrder).where(eq(brokerOrder.orderIntentId, task.orderIntentId));
  const fills: unknown[] = [];
  for (const o of orders) {
    const fs = await db.select().from(fill).where(eq(fill.brokerOrderId, o.id));
    fills.push(...fs);
  }

  return c.json({
    ok: true,
    data: {
      task,
      orderIntent: intents[0] ?? null,
      brokerOrders: orders,
      fills,
    },
  });
});

executionRouter.get("/tasks/:id/events", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const events = await db
    .select()
    .from(executionTaskEvent)
    .where(eq(executionTaskEvent.executionTaskId, id));
  return c.json({ ok: true, data: events });
});

executionRouter.post("/review/:ticketId/approve", async (c) => {
  const ticketId = c.req.param("ticketId");
  const body = await c.req.json<{ reviewer?: string; note?: string }>();
  if (!body.reviewer) return c.json({ error: "reviewer is required" }, 400);
  const db = await getDb();
  const result = await approveRiskReviewTicket(db, ticketId, body.reviewer, body.note);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true });
});

executionRouter.post("/review/:ticketId/reject", async (c) => {
  const ticketId = c.req.param("ticketId");
  const body = await c.req.json<{ reviewer?: string; note?: string }>();
  if (!body.reviewer) return c.json({ error: "reviewer is required" }, 400);
  const db = await getDb();
  const result = await rejectRiskReviewTicket(db, ticketId, body.reviewer, body.note);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true });
});
