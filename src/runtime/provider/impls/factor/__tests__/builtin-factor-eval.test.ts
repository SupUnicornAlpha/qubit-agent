import { describe, expect, test } from "bun:test";
import { BuiltinFactorEvalProvider } from "../builtin-factor-eval-provider";
import type { FactorComputeRow } from "../../../types";

const provider = new BuiltinFactorEvalProvider();

function row(symbol: string, date: string, value: number): FactorComputeRow {
  return { symbol, date, value };
}

describe("BuiltinFactorEvalProvider v0.2", () => {
  test("强单调正相关因子 → IC ≈ 1, RankIC = 1", async () => {
    const values: FactorComputeRow[] = [];
    const futures: FactorComputeRow[] = [];
    // 5 个 symbol × 3 天，每天因子值与未来收益完全单调
    for (const d of ["2026-04-01", "2026-04-02", "2026-04-03"]) {
      for (let i = 0; i < 5; i++) {
        values.push(row(`S${i}`, d, i));
        futures.push(row(`S${i}`, d, i * 0.01));
      }
    }
    const r = await provider.evaluate({ factorId: "f1", universe: "test", values, futureReturns: futures });
    expect(r.ic).toBeGreaterThan(0.99);
    expect(r.rankIc).toBeCloseTo(1, 4);
    expect(r.sampleSize).toBe(15);
    // IR 在所有日 IC 完全一致时 std=0 → 0（合理回退）；这里只断言不为 NaN
    expect(Number.isFinite(r.ir)).toBe(true);
  });

  test("IR：daily IC 有方差时正常计算", async () => {
    const values: FactorComputeRow[] = [];
    const futures: FactorComputeRow[] = [];
    // day1: 完全正相关；day2: 正相关 70%；day3: 正相关 30%
    const noiseDay: Record<string, number> = {
      "2026-04-01": 0,
      "2026-04-02": 0.6,
      "2026-04-03": 0.9,
    };
    for (const d of Object.keys(noiseDay)) {
      const noise = noiseDay[d]!;
      for (let i = 0; i < 8; i++) {
        values.push(row(`S${i}`, d, i));
        const ret = i * 0.01 + (i % 2 === 0 ? noise * 0.05 : -noise * 0.05);
        futures.push(row(`S${i}`, d, ret));
      }
    }
    const r = await provider.evaluate({ factorId: "f", universe: "test", values, futureReturns: futures });
    expect(Number.isFinite(r.ir)).toBe(true);
    expect(r.ir).not.toBe(0);
  });

  test("负相关因子 → IC < 0", async () => {
    const values: FactorComputeRow[] = [];
    const futures: FactorComputeRow[] = [];
    for (const d of ["2026-04-01", "2026-04-02", "2026-04-03"]) {
      for (let i = 0; i < 5; i++) {
        values.push(row(`S${i}`, d, i));
        futures.push(row(`S${i}`, d, -i * 0.01));
      }
    }
    const r = await provider.evaluate({ factorId: "f1", universe: "test", values, futureReturns: futures });
    expect(r.ic).toBeLessThan(-0.99);
  });

  test("sample 太小 → error=sample_size_too_small", async () => {
    const values = [row("A", "2026-04-01", 1), row("B", "2026-04-01", 2)];
    const futures = [row("A", "2026-04-01", 0.01), row("B", "2026-04-01", 0.02)];
    const r = await provider.evaluate({ factorId: "f1", universe: "test", values, futureReturns: futures });
    expect(r.error).toBe("sample_size_too_small");
  });

  test("groupReturns：单调因子 → 第 1 组 < 第 5 组", async () => {
    const values: FactorComputeRow[] = [];
    const futures: FactorComputeRow[] = [];
    for (const d of ["2026-04-01", "2026-04-02"]) {
      for (let i = 0; i < 10; i++) {
        values.push(row(`S${i}`, d, i));
        futures.push(row(`S${i}`, d, i * 0.01));
      }
    }
    const r = await provider.evaluate({
      factorId: "f",
      universe: "test",
      values,
      futureReturns: futures,
      groupCount: 5,
    });
    expect(r.groupReturns.length).toBe(5);
    expect(r.groupReturns[0]!).toBeLessThan(r.groupReturns[4]!);
  });

  test("decayCurve：传 byHorizon 时输出对应数组", async () => {
    const values: FactorComputeRow[] = [];
    const futures1: FactorComputeRow[] = [];
    const futures5: FactorComputeRow[] = [];
    for (const d of ["2026-04-01", "2026-04-02"]) {
      for (let i = 0; i < 5; i++) {
        values.push(row(`S${i}`, d, i));
        futures1.push(row(`S${i}`, d, i * 0.01));
        futures5.push(row(`S${i}`, d, i * 0.005)); // 衰减 50%
      }
    }
    const r = await provider.evaluate({
      factorId: "f",
      universe: "test",
      values,
      futureReturns: futures1,
      futureReturnsByHorizon: { 1: futures1, 5: futures5 },
    });
    expect(r.decayCurve.length).toBe(2);
    // 1 期 IC 应接近 1，5 期 IC 也接近 1（线性），但 magnitude 一致；这里关键是数组长度
    expect(r.decayCurve[0]).toBeGreaterThan(0.9);
  });

  test("turnover：完全反序的相邻天 → turnover 显著 > 0", async () => {
    const values: FactorComputeRow[] = [];
    const futures: FactorComputeRow[] = [];
    // day1: S0..S9 因子=0..9
    // day2: S0..S9 因子=9..0（完全反转）
    for (let i = 0; i < 10; i++) {
      values.push(row(`S${i}`, "2026-04-01", i));
      values.push(row(`S${i}`, "2026-04-02", 9 - i));
      futures.push(row(`S${i}`, "2026-04-01", 0.01));
      futures.push(row(`S${i}`, "2026-04-02", 0.01));
    }
    const r = await provider.evaluate({
      factorId: "f",
      universe: "test",
      values,
      futureReturns: futures,
    });
    expect(r.turnover).toBeGreaterThan(0.4); // top 20% 完全变化
  });
});
