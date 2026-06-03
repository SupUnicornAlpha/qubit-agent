/**
 * P4a mark-price-fetcher 单测：注入 mock fetchBarsRange，验证 upsert / 时区 / 失败隔离。
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BarData } from "../../../connectors/data/data.connector";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { dailyMarkPrice } from "../../../db/sqlite/schema";
import { type DailyMarkPriceFetcher, createDailyMarkPriceFetcher } from "../mark-price-fetcher";

let fetcher: DailyMarkPriceFetcher;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p4a-mark-${Date.now()}`);
  await runMigrations();
  const db = await getDb();
  fetcher = createDailyMarkPriceFetcher(db);
});

beforeEach(async () => {
  // 清空表，确保每个 test 独立
  const db = await getDb();
  await db.delete(dailyMarkPrice).run();
});

function bar(symbol: string, day: string, close: number): BarData {
  return {
    symbol,
    exchange: "",
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
    turnover: close * 1000,
    timestamp: `${day}T08:00:00Z`, // UTC 08:00 → CN 16:00 / US 03:00（前一日）
  };
}

describe("DailyMarkPriceFetcher — fetchAndPersist", () => {
  test("空 targets → no-op", async () => {
    const r = await fetcher.fetchAndPersist([], { from: "2026-06-01", to: "2026-06-05" });
    expect(r.inserted).toBe(0);
    expect(r.failures).toEqual([]);
  });

  test("单 target 单 bar → inserted 1", async () => {
    const r = await fetcher.fetchAndPersist([{ market: "CN", symbol: "600000" }], {
      from: "2026-06-01",
      to: "2026-06-02",
      fetchBarsRange: async () => [bar("600000", "2026-06-02", 10.5)],
    });
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(0);
    expect(r.failures).toEqual([]);

    const close = await fetcher.getClose("CN", "600000", "2026-06-02");
    expect(close).toBe(10.5);
  });

  test("跨时区：UTC 22:00 在 CN 算次日 trading_day", async () => {
    const r = await fetcher.fetchAndPersist([{ market: "CN", symbol: "600000" }], {
      from: "2026-06-01",
      to: "2026-06-03",
      fetchBarsRange: async () => [
        { ...bar("600000", "2026-06-01", 10), timestamp: "2026-06-01T22:00:00Z" },
      ],
    });
    expect(r.inserted).toBe(1);
    // UTC 22:00 → CN UTC+8 = 06:00 次日，trading_day = 2026-06-02
    const close = await fetcher.getClose("CN", "600000", "2026-06-02");
    expect(close).toBe(10);
  });

  test("重复写：updated 而不是 duplicate insert", async () => {
    await fetcher.fetchAndPersist([{ market: "CN", symbol: "600000" }], {
      from: "2026-06-01",
      to: "2026-06-02",
      fetchBarsRange: async () => [bar("600000", "2026-06-02", 10)],
    });
    const r2 = await fetcher.fetchAndPersist([{ market: "CN", symbol: "600000" }], {
      from: "2026-06-01",
      to: "2026-06-02",
      fetchBarsRange: async () => [bar("600000", "2026-06-02", 11)],
      sourceTag: "rebackfill",
    });
    expect(r2.inserted).toBe(0);
    expect(r2.updated).toBe(1);
    const close = await fetcher.getClose("CN", "600000", "2026-06-02");
    expect(close).toBe(11);
  });

  test("一个 target 失败不影响其他", async () => {
    let call = 0;
    const r = await fetcher.fetchAndPersist(
      [
        { market: "CN", symbol: "600000" },
        { market: "CN", symbol: "BAD" },
        { market: "US", symbol: "AAPL" },
      ],
      {
        from: "2026-06-01",
        to: "2026-06-02",
        fetchBarsRange: async (p) => {
          call += 1;
          if (p.symbol === "BAD") throw new Error("connector down");
          return [bar(p.symbol, "2026-06-02", 100)];
        },
      }
    );
    expect(call).toBe(3);
    expect(r.inserted).toBe(2);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toEqual({ market: "CN", symbol: "BAD", reason: "connector down" });
  });

  test("空 bars → skipped 计数", async () => {
    const r = await fetcher.fetchAndPersist([{ market: "CN", symbol: "600000" }], {
      from: "2026-06-01",
      to: "2026-06-02",
      fetchBarsRange: async () => [],
    });
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  test("超过 batch 上限抛错", async () => {
    const huge = Array.from({ length: 201 }, (_, i) => ({
      market: "CN",
      symbol: `s${i}`,
    }));
    await expect(
      fetcher.fetchAndPersist(huge, {
        from: "2026-06-01",
        to: "2026-06-02",
        fetchBarsRange: async () => [],
      })
    ).rejects.toThrow(/batch size/);
  });
});

describe("DailyMarkPriceFetcher — getClosesByDay", () => {
  test("批量取多 symbol 同一天", async () => {
    await fetcher.fetchAndPersist(
      [
        { market: "CN", symbol: "600000" },
        { market: "CN", symbol: "000001" },
      ],
      {
        from: "2026-06-01",
        to: "2026-06-02",
        fetchBarsRange: async (p) => [bar(p.symbol, "2026-06-02", p.symbol === "600000" ? 10 : 20)],
      }
    );
    const map = await fetcher.getClosesByDay("CN", ["600000", "000001", "999999"], "2026-06-02");
    expect(map.size).toBe(2);
    expect(map.get("600000")).toBe(10);
    expect(map.get("000001")).toBe(20);
    expect(map.has("999999")).toBe(false);
  });

  test("空 symbols → 空 Map", async () => {
    const map = await fetcher.getClosesByDay("CN", [], "2026-06-02");
    expect(map.size).toBe(0);
  });
});
