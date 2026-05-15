import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../db/sqlite/schema";
import { createOrderIntentWithExecution } from "../execution/order-intent-service";
import { processExecutionTasks } from "../execution/execution-worker";
import { evaluateSignalCode } from "./signal-evaluator";
import {
  createStrategyRuntime,
  startStrategyRuntime,
  stopStrategyRuntime,
} from "./strategy-runtime-service";

async function seedBase(db: ReturnType<typeof drizzle>) {
  const wid = randomUUID();
  const pid = randomUUID();
  const wrid = randomUUID();
  const sid = randomUUID();
  const svid = randomUUID();
  const iid = randomUUID();
  const sessionId = randomUUID();
  const scriptId = randomUUID();

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
  await db.insert(schema.chatSession).values({
    id: sessionId,
    workspaceId: wid,
    projectId: pid,
    title: "s",
    status: "active",
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
    exchange: "US",
    metaJson: {},
  });
  await db.insert(schema.riskRule).values({
    id: randomUUID(),
    projectId: pid,
    name: "cap",
    scope: "pre_trade",
    ruleExpr: JSON.stringify({ kind: "max_notional", max: 1_000_000 }),
    severity: "block",
    enabled: true,
    version: 1,
  });
  await db.insert(schema.indicatorStrategyScript).values({
    id: scriptId,
    sessionId,
    workflowRunId: wrid,
    name: "sma",
    ideCode: "",
    signalCode: `
buy = [False] * len(closes)
sell = [False] * len(closes)
if len(closes) >= 2 and closes[-1] > closes[-2]:
    buy[-1] = True
`,
    purpose: "both",
  });

  return { wrid, svid, iid, scriptId };
}

describe("strategy runtime", () => {
  test("evaluateSignalCode detects buy on rising close", async () => {
    const bars = [
      { time: "2024-01-01", open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: "2024-01-02", open: 10, high: 12, low: 10, close: 11, volume: 100 },
    ];
    const code = `
buy = [False] * len(closes)
sell = [False] * len(closes)
if len(closes) >= 2 and closes[-1] > closes[-2]:
    buy[-1] = True
`;
    const sig = await evaluateSignalCode(code, bars);
    expect(sig.buy).toBe(true);
    expect(sig.sell).toBe(false);
  });

  test("create runtime and unified execution pipeline", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations");
    await migrate(db, { migrationsFolder });

    const { scriptId, wrid, svid, iid } = await seedBase(db);

    const runtime = await createStrategyRuntime(
      {
        strategyScriptId: scriptId,
        market: "US",
        symbol: "TEST",
        timeframe: "1d",
        executionMode: "paper",
        autoStart: false,
        params: { orderQty: 5 },
      },
      db
    );

    expect(runtime.status).toBe("stopped");
    await startStrategyRuntime(runtime.id, db);

    const created = await createOrderIntentWithExecution(db, {
      workflowRunId: wrid,
      strategyVersionId: svid,
      instrumentId: iid,
      side: "buy",
      qty: 5,
      orderType: "limit",
      price: 100,
      timeInForce: "day",
      strategyRuntimeId: runtime.id,
      signalBarTime: "2024-01-02",
      dispatchMode: "paper",
    });

    expect(created.riskOutcome).toBe("allow");
    await processExecutionTasks(db);
    const tasks = await db
      .select()
      .from(schema.executionTask)
      .where(eq(schema.executionTask.id, created.executionTaskId!));
    expect(tasks[0]?.status).toBe("filled");

    await stopStrategyRuntime(runtime.id, db);
    const stopped = await db
      .select()
      .from(schema.strategyRuntime)
      .where(eq(schema.strategyRuntime.id, runtime.id))
      .limit(1);
    expect(stopped[0]?.status).toBe("stopped");
  });
});
