import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import {
  assertTradingModuleEnabled,
  getTradingModuleStatus,
  resetTradingModuleForTest,
  setTradingModuleEnabled,
} from "./trading-module-control";

beforeAll(async () => {
  await runMigrations();
});

afterEach(async () => resetTradingModuleForTest());

describe("trading-module-control", () => {
  test("default is enabled", async () => {
    expect((await getTradingModuleStatus()).enabled).toBe(true);
  });

  test("pause is durable across independent status reads and blocks new trading work", async () => {
    const db = await getDb();
    const paused = await setTradingModuleEnabled(false, {
      reason: "test_pause",
      changedBy: "test",
      db,
    });
    expect(paused).toMatchObject({ enabled: false, reason: "test_pause", source: "database" });
    expect((await getTradingModuleStatus(db)).revision).toBe(paused.revision);
    await expect(assertTradingModuleEnabled(db)).rejects.toThrow("trading_module_paused");
    const resumed = await setTradingModuleEnabled(true, { reason: "test_resume", db });
    expect(resumed.enabled).toBe(true);
    expect(resumed.revision).toBeGreaterThan(paused.revision);
    await expect(assertTradingModuleEnabled(db)).resolves.toBeUndefined();
  });

  test("a scoped pause blocks only its broker account or strategy runtime", async () => {
    const db = await getDb();
    await setTradingModuleEnabled(false, {
      reason: "broker_maintenance",
      db,
      scope: { brokerAccountId: "broker-a" },
    });
    expect((await getTradingModuleStatus(db)).enabled).toBe(true);
    expect(
      await getTradingModuleStatus(db, { brokerAccountId: "broker-a" })
    ).toMatchObject({ enabled: false, scopeKey: "broker_account:broker-a" });
    await expect(assertTradingModuleEnabled(db, { brokerAccountId: "broker-a" })).rejects.toThrow(
      "trading_module_paused:broker_account:broker-a"
    );
    await expect(assertTradingModuleEnabled(db, { brokerAccountId: "broker-b" })).resolves.toBeUndefined();

    await setTradingModuleEnabled(false, {
      reason: "runtime_incident",
      db,
      scope: { strategyRuntimeId: "runtime-a" },
    });
    await expect(assertTradingModuleEnabled(db, { strategyRuntimeId: "runtime-a" })).rejects.toThrow(
      "trading_module_paused:strategy_runtime:runtime-a"
    );
    await expect(
      setTradingModuleEnabled(false, {
        db,
        scope: { brokerAccountId: "broker-a", strategyRuntimeId: "runtime-a" },
      })
    ).rejects.toThrow("trading_module_scope_ambiguous");
  });
});
