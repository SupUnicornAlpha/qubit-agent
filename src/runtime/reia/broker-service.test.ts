import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { runMigrations } from "../../db/sqlite/migrate";
import { closeDb } from "../../db/sqlite/client";
import { paperFromBrokerMode } from "./broker-connector";
import { resolveBrokerAccount } from "./broker-service";
import { upsertBrokerAccount } from "./broker-admin";

describe("broker-service", () => {
  beforeAll(async () => {
    const testHome = `${process.cwd()}/.tmp-broker-test-home`;
    await rm(testHome, { recursive: true, force: true });
    await mkdir(testHome, { recursive: true });
    process.env.HOME = testHome;
    closeDb();
    await runMigrations();
  });

  test("paperFromBrokerMode maps sandbox/live", () => {
    expect(paperFromBrokerMode("sandbox")).toBe(true);
    expect(paperFromBrokerMode("live")).toBe(false);
    expect(paperFromBrokerMode("mock")).toBe(true);
  });

  test("resolveBrokerAccount prefers exact accountRef then default", async () => {
    await upsertBrokerAccount({
      provider: "futu",
      accountRef: "secondary",
      mode: "mock",
      isDefault: false,
    });
    await upsertBrokerAccount({
      provider: "futu",
      accountRef: "primary",
      mode: "mock",
      isDefault: true,
    });

    const exact = await resolveBrokerAccount("futu", "secondary");
    expect(exact?.accountRef).toBe("secondary");

    const fallback = await resolveBrokerAccount("futu");
    expect(fallback?.accountRef).toBe("primary");
  });
});
