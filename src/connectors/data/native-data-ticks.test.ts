import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/sqlite/migrate";
import { QubitNativeDataConnector } from "./native-data.connector";

describe("QubitNativeDataConnector fetchTicks", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  test("never returns the historical fixed placeholder for unsupported markets", async () => {
    const connector = new QubitNativeDataConnector();
    await expect(
      connector.fetchTicks({
        symbol: "AAPL",
        exchange: "US",
        date: "2026-07-26",
      })
    ).rejects.toThrow("market_data_unavailable");
  });
});
