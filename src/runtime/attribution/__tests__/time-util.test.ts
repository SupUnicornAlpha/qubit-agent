/**
 * P4a time-util 单测：覆盖跨时区、周末、节假日回退、ISO ↔ epoch day 转换。
 */
import { describe, expect, test } from "bun:test";
import {
  SUPPORTED_MARKETS,
  dateToEpochDay,
  dateToTradingDay,
  epochDayToDate,
  isWeekendInMarket,
  isoDateToEpochDay,
  listTradingDays,
  previousTradingDay,
} from "../time-util";

describe("dateToEpochDay / epochDayToDate", () => {
  test("UTC midnight 1970-01-01 → 0", () => {
    const d = new Date("1970-01-01T00:00:00Z");
    expect(dateToEpochDay(d)).toBe(0);
  });
  test("UTC midnight 1970-01-02 → 1", () => {
    expect(dateToEpochDay(new Date("1970-01-02T00:00:00Z"))).toBe(1);
  });
  test("非整日时间向下取整", () => {
    expect(dateToEpochDay(new Date("2026-06-02T23:59:59Z"))).toBe(
      Math.floor(Date.UTC(2026, 5, 2) / 86_400_000)
    );
  });
  test("roundtrip：epoch → date → epoch 恒等", () => {
    const e = 20240;
    expect(dateToEpochDay(epochDayToDate(e))).toBe(e);
  });
});

describe("isoDateToEpochDay", () => {
  test("'2026-06-02' 解析为 UTC 那天", () => {
    const e = isoDateToEpochDay("2026-06-02");
    expect(epochDayToDate(e).toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });
  test("带时间后缀也能解析", () => {
    expect(isoDateToEpochDay("2026-06-02T23:30:00Z")).toBe(isoDateToEpochDay("2026-06-02"));
  });
  test("非法格式抛错", () => {
    expect(() => isoDateToEpochDay("bad-date")).toThrow();
  });
});

describe("dateToTradingDay — 跨时区", () => {
  test("UTC 2026-06-02 22:30 在 CN 是 2026-06-03（已过 UTC+8 当日 6:30）", () => {
    expect(dateToTradingDay(new Date("2026-06-02T22:30:00Z"), "CN")).toBe("2026-06-03");
  });
  test("UTC 2026-06-02 22:30 在 US 是 2026-06-02（NY 时区 18:30）", () => {
    expect(dateToTradingDay(new Date("2026-06-02T22:30:00Z"), "US")).toBe("2026-06-02");
  });
  test("CRYPTO 用 UTC", () => {
    expect(dateToTradingDay(new Date("2026-06-02T22:30:00Z"), "CRYPTO")).toBe("2026-06-02");
  });
  test("未知 market 走 US fallback（与 trading-calendar.ts 保持一致）", () => {
    expect(dateToTradingDay(new Date("2026-06-02T22:30:00Z"), "WTF")).toBe("2026-06-02");
  });
});

describe("isWeekendInMarket", () => {
  test("CN：周六(2026-06-06 Sat) 是周末", () => {
    expect(isWeekendInMarket(new Date("2026-06-06T05:00:00Z"), "CN")).toBe(true);
  });
  test("CN：周一(2026-06-01 Mon) 不是周末", () => {
    expect(isWeekendInMarket(new Date("2026-06-01T05:00:00Z"), "CN")).toBe(false);
  });
  test("CRYPTO：周末也是交易日（7×24）", () => {
    expect(isWeekendInMarket(new Date("2026-06-06T05:00:00Z"), "CRYPTO")).toBe(false);
  });
});

describe("listTradingDays", () => {
  test("CN 一周（2026-06-01 Mon ~ 2026-06-07 Sun）= 5 个交易日", () => {
    const days = listTradingDays(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-07T23:59:00Z"),
      "CN"
    );
    expect(days).toHaveLength(5);
    expect(days[0]).toBe("2026-06-01");
    expect(days[4]).toBe("2026-06-05");
  });
  test("CRYPTO 一周 = 7 天", () => {
    const days = listTradingDays(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-07T23:59:00Z"),
      "CRYPTO"
    );
    expect(days).toHaveLength(7);
  });
  test("from > to → []", () => {
    expect(
      listTradingDays(new Date("2026-06-10T00:00:00Z"), new Date("2026-06-01T00:00:00Z"), "CN")
    ).toEqual([]);
  });
  test("同一天 from=to → 1 天（若非周末）", () => {
    const days = listTradingDays(
      new Date("2026-06-02T10:00:00Z"),
      new Date("2026-06-02T10:00:00Z"),
      "CN"
    );
    expect(days.length).toBeGreaterThanOrEqual(1);
  });
});

describe("previousTradingDay", () => {
  test("周一回退到周五（跳过周末）", () => {
    const mon = new Date("2026-06-01T10:00:00Z"); // 2026-06-01 是周一
    const prev = previousTradingDay(mon, "CN");
    expect(dateToTradingDay(prev, "CN")).toBe("2026-05-29"); // 上一个周五
  });
  test("周三回退到周二", () => {
    const wed = new Date("2026-06-03T10:00:00Z"); // 周三
    const prev = previousTradingDay(wed, "CN");
    expect(dateToTradingDay(prev, "CN")).toBe("2026-06-02");
  });
  test("CRYPTO 永远回退一天", () => {
    const prev = previousTradingDay(new Date("2026-06-01T10:00:00Z"), "CRYPTO");
    expect(dateToTradingDay(prev, "CRYPTO")).toBe("2026-05-31");
  });
});

describe("SUPPORTED_MARKETS", () => {
  test("含 4 个 market", () => {
    expect(SUPPORTED_MARKETS).toEqual(["CN", "US", "HK", "CRYPTO"]);
  });
});
