import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../db/sqlite/schema";
import { createOrderIntentWithExecution } from "./order-intent-service";
import { processExecutionTasks } from "./execution-worker";

describe("execution pipeline (memory sqlite)", () => {
  test("allows intent and paper-fills through worker", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations");
    await migrate(db, { migrationsFolder });

    const wid = randomUUID();
    const pid = randomUUID();
    const wrid = randomUUID();
    const sid = randomUUID();
    const svid = randomUUID();
    const iid = randomUUID();
    const rid = randomUUID();

    await db.insert(schema.workspace).values({
      id: wid,
      name: "t-ws",
      owner: "tester",
    });
    await db.insert(schema.project).values({
      id: pid,
      workspaceId: wid,
      name: "t-proj",
      marketScope: "US",
      status: "active",
    });
    await db.insert(schema.workflowRun).values({
      id: wrid,
      projectId: pid,
      goal: "test",
      mode: "simulation",
      source: "api",
      status: "running",
    });
    await db.insert(schema.strategy).values({
      id: sid,
      projectId: pid,
      name: "s",
      style: "low_freq",
      description: "",
    });
    await db.insert(schema.strategyVersion).values({
      id: svid,
      strategyId: sid,
      versionTag: "v1",
      logicHash: "x",
      paramSchemaJson: {},
    });
    await db.insert(schema.instrument).values({
      id: iid,
      symbol: "TEST",
      assetClass: "stock",
      exchange: "NYSE",
      metaJson: {},
    });
    await db.insert(schema.riskRule).values({
      id: rid,
      projectId: pid,
      name: "cap",
      scope: "pre_trade",
      ruleExpr: JSON.stringify({ kind: "max_notional", max: 1_000_000 }),
      severity: "block",
      enabled: true,
      version: 1,
    });

    const created = await createOrderIntentWithExecution(db, {
      workflowRunId: wrid,
      strategyVersionId: svid,
      instrumentId: iid,
      side: "buy",
      qty: 10,
      orderType: "limit",
      price: 100,
      timeInForce: "day",
    });

    expect(created.riskOutcome).toBe("allow");
    expect(created.executionTaskId).toBeTruthy();
    const riskChecked = await db
      .select()
      .from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, created.orderIntentId));
    expect(riskChecked[0]?.lifecycleStatus).toBe("risk_checked");
    expect(riskChecked[0]?.clientOrderId).toBe(created.orderIntentId);

    await processExecutionTasks(db);

    const tasks = await db.select().from(schema.executionTask).where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("filled");

    const orders = await db
      .select()
      .from(schema.brokerOrder)
      .where(eq(schema.brokerOrder.orderIntentId, created.orderIntentId));
    expect(orders.length).toBe(1);
    expect(orders[0]?.status).toBe("filled");
    const filledIntent = await db
      .select()
      .from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, created.orderIntentId));
    expect(filledIntent[0]?.lifecycleStatus).toBe("filled");
  });

  test("blocks when notional exceeds max_notional", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations");
    await migrate(db, { migrationsFolder });

    const wid = randomUUID();
    const pid = randomUUID();
    const wrid = randomUUID();
    const sid = randomUUID();
    const svid = randomUUID();
    const iid = randomUUID();
    const rid = randomUUID();

    await db.insert(schema.workspace).values({ id: wid, name: "w", owner: "t" });
    await db.insert(schema.project).values({
      id: pid,
      workspaceId: wid,
      name: "p",
      marketScope: "US",
      status: "active",
    });
    await db.insert(schema.workflowRun).values({
      id: wrid,
      projectId: pid,
      goal: "t",
      mode: "simulation",
      source: "api",
      status: "running",
    });
    await db.insert(schema.strategy).values({
      id: sid,
      projectId: pid,
      name: "s",
      style: "low_freq",
      description: "",
    });
    await db.insert(schema.strategyVersion).values({
      id: svid,
      strategyId: sid,
      versionTag: "v1",
      logicHash: "x",
      paramSchemaJson: {},
    });
    await db.insert(schema.instrument).values({
      id: iid,
      symbol: "X",
      assetClass: "stock",
      exchange: "NYSE",
      metaJson: {},
    });
    await db.insert(schema.riskRule).values({
      id: rid,
      projectId: pid,
      name: "low_cap",
      scope: "pre_trade",
      ruleExpr: JSON.stringify({ kind: "max_notional", max: 100 }),
      severity: "block",
      enabled: true,
      version: 1,
    });

    const created = await createOrderIntentWithExecution(db, {
      workflowRunId: wrid,
      strategyVersionId: svid,
      instrumentId: iid,
      side: "buy",
      qty: 10,
      orderType: "limit",
      price: 100,
      timeInForce: "day",
    });

    expect(created.riskOutcome).toBe("block");
    expect(created.executionTaskId).toBeTruthy();
    const rejectedIntent = await db
      .select()
      .from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, created.orderIntentId));
    expect(rejectedIntent[0]?.lifecycleStatus).toBe("rejected");

    await processExecutionTasks(db);

    const tasks = await db.select().from(schema.executionTask).where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("rejected");
  });

  test("clientOrderId replay reuses the same order_intent", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations");
    await migrate(db, { migrationsFolder });

    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const workflowRunId = randomUUID();
    const strategyId = randomUUID();
    const strategyVersionId = randomUUID();
    const instrumentId = randomUUID();
    await db.insert(schema.workspace).values({ id: workspaceId, name: "w", owner: "t" });
    await db.insert(schema.project).values({
      id: projectId,
      workspaceId,
      name: "p",
      marketScope: "US",
      status: "active",
    });
    await db.insert(schema.workflowRun).values({
      id: workflowRunId,
      projectId,
      goal: "idempotency",
      mode: "simulation",
      source: "api",
      status: "running",
    });
    await db.insert(schema.strategy).values({
      id: strategyId,
      projectId,
      name: "s",
      style: "low_freq",
      description: "",
    });
    await db.insert(schema.strategyVersion).values({
      id: strategyVersionId,
      strategyId,
      versionTag: "v1",
      logicHash: "x",
      paramSchemaJson: {},
    });
    await db.insert(schema.instrument).values({
      id: instrumentId,
      symbol: "IDEM",
      assetClass: "stock",
      exchange: "NYSE",
      metaJson: {},
    });

    const input = {
      workflowRunId,
      strategyVersionId,
      instrumentId,
      side: "buy" as const,
      qty: 1,
      orderType: "market" as const,
      timeInForce: "day" as const,
      clientOrderId: "client-idem-1",
    };
    const first = await createOrderIntentWithExecution(db, input);
    const replay = await createOrderIntentWithExecution(db, input);
    expect(replay.orderIntentId).toBe(first.orderIntentId);
    expect(replay.executionTaskId).toBe(first.executionTaskId);
    const rows = await db
      .select()
      .from(schema.orderIntent)
      .where(eq(schema.orderIntent.clientOrderId, "client-idem-1"));
    expect(rows).toHaveLength(1);
  });

  test("waits for market data before triggering a paper stop", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations");
    await migrate(db, { migrationsFolder });

    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const workflowRunId = randomUUID();
    const strategyId = randomUUID();
    const strategyVersionId = randomUUID();
    const instrumentId = randomUUID();
    await db.insert(schema.workspace).values({ id: workspaceId, name: "w", owner: "t" });
    await db.insert(schema.project).values({
      id: projectId, workspaceId, name: "p", marketScope: "US", status: "active",
    });
    await db.insert(schema.workflowRun).values({
      id: workflowRunId, projectId, goal: "stop", mode: "simulation", source: "api", status: "running",
    });
    await db.insert(schema.strategy).values({
      id: strategyId, projectId, name: "s", style: "low_freq", description: "",
    });
    await db.insert(schema.strategyVersion).values({
      id: strategyVersionId, strategyId, versionTag: "v1", logicHash: "stop", paramSchemaJson: {},
    });
    await db.insert(schema.instrument).values({
      id: instrumentId, symbol: "STOP", assetClass: "stock", exchange: "NYSE", metaJson: {},
    });
    await db.insert(schema.dailyMarkPrice).values({
      id: randomUUID(), market: "US", symbol: "STOP", tradingDay: "2026-07-10", close: 96, source: "test",
    });

    const created = await createOrderIntentWithExecution(db, {
      workflowRunId,
      strategyVersionId,
      instrumentId,
      side: "sell",
      qty: 2,
      orderType: "stop",
      price: 100,
      stopPrice: 95,
      market: "US",
      symbol: "STOP",
      timeInForce: "gtc",
    });
    await processExecutionTasks(db, new Date("2026-07-10T20:00:00Z"));
    let tasks = await db.select().from(schema.executionTask).where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("conditional_wait");

    await db.insert(schema.dailyMarkPrice).values({
      id: randomUUID(), market: "US", symbol: "STOP", tradingDay: "2026-07-11", close: 94, source: "test",
    });
    await processExecutionTasks(db, new Date("2026-07-11T20:00:00Z"));
    tasks = await db.select().from(schema.executionTask).where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("filled");
    const intents = await db.select().from(schema.orderIntent).where(eq(schema.orderIntent.id, created.orderIntentId));
    expect(intents[0]?.activationStatus).toBe("triggered");
    expect(intents[0]?.lifecycleStatus).toBe("filled");
    expect(intents[0]?.price).toBe(94);
  });
});
