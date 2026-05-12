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

    await processExecutionTasks(db);

    const tasks = await db.select().from(schema.executionTask).where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("filled");

    const orders = await db
      .select()
      .from(schema.brokerOrder)
      .where(eq(schema.brokerOrder.orderIntentId, created.orderIntentId));
    expect(orders.length).toBe(1);
    expect(orders[0]?.status).toBe("filled");
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

    await processExecutionTasks(db);

    const tasks = await db.select().from(schema.executionTask).where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("rejected");
  });
});
