import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { createBracketOrder } from "./bracket-order-service";
import { amendWaitingConditionalOrder } from "./conditional-order-service";
import { processExecutionTasks } from "./execution-worker";

describe("bracket order service", () => {
  test("activates children after entry fill and cancels the OCO sibling", async () => {
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
      goal: "bracket",
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
      logicHash: "bracket",
      paramSchemaJson: {},
    });
    await db.insert(schema.instrument).values({
      id: instrumentId,
      symbol: "BRK",
      assetClass: "stock",
      exchange: "NYSE",
      metaJson: {},
    });
    await db.insert(schema.dailyMarkPrice).values({
      id: randomUUID(),
      market: "US",
      symbol: "BRK",
      tradingDay: "2026-07-10",
      close: 100,
      source: "test",
    });

    const bracket = await createBracketOrder(db, {
      workflowRunId,
      strategyVersionId,
      instrumentId,
      side: "buy",
      qty: 5,
      entryOrderType: "market",
      entryReferencePrice: 100,
      takeProfitPrice: 110,
      stopLossPrice: 95,
      timeInForce: "gtc",
      dispatchMode: "paper",
      market: "US",
      symbol: "BRK",
    });

    const childTasksBefore = await db.select().from(schema.executionTask);
    expect(childTasksBefore.filter((task) => task.status === "held")).toHaveLength(2);
    const stopBefore = (await db.select().from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, bracket.stopLoss.orderIntentId)))[0];
    const amendedStop = await amendWaitingConditionalOrder(db, {
      orderIntentId: bracket.stopLoss.orderIntentId,
      expectedLifecycleUpdatedAt: stopBefore?.lifecycleUpdatedAt ?? "",
      stopPrice: 96,
      actorId: "tester",
    });
    expect(amendedStop.stopPrice).toBe(96);
    await processExecutionTasks(db, new Date("2026-07-10T20:00:00Z"));
    const childTasksActivated = await db.select().from(schema.executionTask);
    expect(childTasksActivated.filter((task) => task.status === "conditional_wait")).toHaveLength(2);

    await db.insert(schema.dailyMarkPrice).values({
      id: randomUUID(),
      market: "US",
      symbol: "BRK",
      tradingDay: "2026-07-11",
      close: 111,
      source: "test",
    });
    await processExecutionTasks(db, new Date("2026-07-11T20:00:00Z"));

    const takeProfit = (await db.select().from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, bracket.takeProfit.orderIntentId)))[0];
    const stopLoss = (await db.select().from(schema.orderIntent)
      .where(eq(schema.orderIntent.id, bracket.stopLoss.orderIntentId)))[0];
    expect(takeProfit?.lifecycleStatus).toBe("filled");
    expect(takeProfit?.triggerDirection).toBe("above");
    expect(stopLoss?.lifecycleStatus).toBe("cancelled");
  });

  test("rejects an inverted long bracket before writing", async () => {
    await expect(createBracketOrder({} as never, {
      workflowRunId: "w",
      strategyVersionId: "v",
      instrumentId: "i",
      side: "buy",
      qty: 1,
      entryOrderType: "market",
      entryReferencePrice: 100,
      takeProfitPrice: 90,
      stopLossPrice: 110,
      timeInForce: "gtc",
    })).rejects.toThrow("long_bracket_requires_stop_below_entry_and_target_above_entry");
  });
});
