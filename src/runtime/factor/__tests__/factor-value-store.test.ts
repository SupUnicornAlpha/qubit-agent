import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { factorValueStore } from "../factor-value-store";

describe("FactorValueStore (DuckDB)", () => {
  test("upsert + query 区间 + upsert 覆盖", async () => {
    const factorId = `f_${randomUUID().slice(0, 6)}`;
    const rows = [
      { symbol: "A", date: "2026-01-01", value: 0.1 },
      { symbol: "A", date: "2026-01-02", value: 0.2 },
      { symbol: "B", date: "2026-01-01", value: -0.05 },
    ];
    const w1 = await factorValueStore.upsert({ factorId, rows });
    expect(w1.written).toBe(3);

    const got = await factorValueStore.query({
      factorId,
      startDate: "2026-01-01",
      endDate: "2026-01-02",
    });
    expect(got.length).toBe(3);
    const A02 = got.find((r) => r.symbol === "A" && r.date === "2026-01-02");
    expect(A02?.value).toBe(0.2);

    // 覆盖：同 (factor, symbol, date) 重写
    await factorValueStore.upsert({
      factorId,
      rows: [{ symbol: "A", date: "2026-01-02", value: 0.99 }],
    });
    const after = await factorValueStore.query({
      factorId,
      symbols: ["A"],
      startDate: "2026-01-02",
      endDate: "2026-01-02",
    });
    expect(after[0]?.value).toBe(0.99);
  });

  test("latestN 取最新若干日", async () => {
    const factorId = `f_${randomUUID().slice(0, 6)}`;
    const rows = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map((d, i) => ({
      symbol: "X",
      date: d,
      value: i,
    }));
    await factorValueStore.upsert({ factorId, rows });
    const latest2 = await factorValueStore.query({ factorId, latestN: 2 });
    expect(latest2.length).toBe(2);
    expect(latest2.map((r) => r.date).sort()).toEqual(["2026-01-03", "2026-01-04"]);
  });

  test("queryAt 横截面 + stats", async () => {
    const factorId = `f_${randomUUID().slice(0, 6)}`;
    await factorValueStore.upsert({
      factorId,
      rows: [
        { symbol: "S1", date: "2026-05-20", value: 1 },
        { symbol: "S2", date: "2026-05-20", value: 2 },
        { symbol: "S3", date: "2026-05-19", value: 3 },
      ],
    });
    const cross = await factorValueStore.queryAt(factorId, "2026-05-20");
    expect(cross.length).toBe(2);
    const stats = await factorValueStore.stats(factorId);
    expect(stats.rowCount).toBe(3);
    expect(stats.symbolCount).toBe(3);
    expect(stats.minDate).toBe("2026-05-19");
    expect(stats.maxDate).toBe("2026-05-20");
  });
});
