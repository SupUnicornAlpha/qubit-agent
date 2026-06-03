/**
 * P4a fee-calculator 单测：覆盖默认 seed 行 + 边界（min commission / 印花税 / 通配 fallback / 全 miss）。
 *
 * 用真实 sqlite（已 apply migrations）跑，避免 mock fee_schedule 行；
 * QUBIT_DATA_DIR 每次 random，确保隔离。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { type FeeCalculator, createFeeCalculator } from "../fee-calculator";

let calc: FeeCalculator;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p4a-fee-${Date.now()}`);
  await runMigrations();
  const db = await getDb();
  calc = createFeeCalculator(db);
});

describe("FeeCalculator — 默认 seed", () => {
  test("CN A 股买入：notional 1w 触发 commission min 5 元 + 过户费十万 2，无印花税", async () => {
    const r = await calc.calculate({
      broker: "futu",
      market: "CN",
      assetClass: "stock",
      side: "buy",
      qty: 1000,
      price: 10,
      asOf: "2026-06-02",
    });
    // notional = 10000；万 2.5 算出 2.5，触发最低 5 元
    expect(r.commission).toBe(5);
    expect(r.stampDuty).toBe(0);
    expect(r.transferFee).toBeCloseTo(10000 * 0.00002, 6); // 0.2
    expect(r.total).toBeCloseTo(5.2, 6);
    expect(r.matchedRuleId).toBe("fee_seed_cn_buy_v1");
  });

  test("CN A 股大额买入：notional 10w 算出 commission 25 元（超过 min）", async () => {
    const r = await calc.calculate({
      broker: "futu",
      market: "CN",
      assetClass: "stock",
      side: "buy",
      qty: 1000,
      price: 100,
      asOf: "2026-06-02",
    });
    // notional = 100000；万 2.5 = 25，不触发 min
    expect(r.commission).toBeCloseTo(25, 6);
    expect(r.transferFee).toBeCloseTo(100000 * 0.00002, 6); // 2
    expect(r.total).toBeCloseTo(27, 6);
  });

  test("CN A 股卖出：commission（触发 min 5）+ 印花税 + 过户费", async () => {
    const r = await calc.calculate({
      broker: "futu",
      market: "CN",
      assetClass: "stock",
      side: "sell",
      qty: 1000,
      price: 10,
      asOf: "2026-06-02",
    });
    expect(r.commission).toBe(5);
    expect(r.stampDuty).toBeCloseTo(10000 * 0.001, 6); // 10
    expect(r.transferFee).toBeCloseTo(0.2, 6);
    expect(r.total).toBeCloseTo(15.2, 6);
  });

  test("小额成交触发最低 commission 5 元", async () => {
    const r = await calc.calculate({
      broker: "*",
      market: "CN",
      assetClass: "stock",
      side: "buy",
      qty: 100,
      price: 5, // notional = 500，commission rate 算出来 = 0.125，min 5
      asOf: "2026-06-02",
    });
    expect(r.commission).toBe(5);
    expect(r.total).toBeCloseTo(5 + 0 + 500 * 0.00002, 6); // 5.01
  });

  test("US 股票：仅 commission 0.0001，无印花/过户", async () => {
    const r = await calc.calculate({
      broker: "ib",
      market: "US",
      assetClass: "stock",
      side: "sell",
      qty: 100,
      price: 100,
      asOf: "2026-06-02",
    });
    expect(r.commission).toBeCloseTo(100 * 100 * 0.0001, 6); // 1.0
    expect(r.stampDuty).toBe(0);
    expect(r.transferFee).toBe(0);
    expect(r.total).toBeCloseTo(1.0, 6);
  });

  test("HK 股票卖出：含印花税 0.0013", async () => {
    const r = await calc.calculate({
      broker: "futu",
      market: "HK",
      assetClass: "stock",
      side: "sell",
      qty: 1000,
      price: 50,
      asOf: "2026-06-02",
    });
    expect(r.commission).toBeCloseTo(50000 * 0.001, 6); // 50
    expect(r.stampDuty).toBeCloseTo(50000 * 0.0013, 6); // 65
    expect(r.transferFee).toBeCloseTo(50000 * 0.00002, 6); // 1
    expect(r.total).toBeCloseTo(50 + 65 + 1, 4);
  });

  test("CRYPTO 通配 side", async () => {
    const r = await calc.calculate({
      broker: "ccxt",
      market: "CRYPTO",
      assetClass: "crypto",
      side: "buy",
      qty: 1,
      price: 50000,
      asOf: "2026-06-02",
    });
    expect(r.commission).toBeCloseTo(50000 * 0.001, 6); // 50
    expect(r.total).toBeCloseTo(50, 6);
  });
});

describe("FeeCalculator — 优先级", () => {
  test("paper broker 优先于通配（priority=100 > 10），零费率胜出", async () => {
    const r = await calc.calculate({
      broker: "paper",
      market: "CN",
      assetClass: "stock",
      side: "buy",
      qty: 1000,
      price: 10,
      asOf: "2026-06-02",
    });
    expect(r.total).toBe(0);
    expect(r.matchedRuleId).toBe("fee_seed_paper_v1");
  });
});

describe("FeeCalculator — 全 miss", () => {
  test("市场不在 seed 也不通配 → total=0, matchedRuleId=null", async () => {
    const r = await calc.calculate({
      broker: "unknown_broker",
      market: "MARS",
      assetClass: "alien",
      side: "buy",
      qty: 1,
      price: 1,
      asOf: "2026-06-02",
    });
    // 通配 broker='*' / market='*' / asset='*' 应该会命中 paper broker？不会，因为 paper 要求 broker='paper'
    // CN/US/HK/CRYPTO 行的 market 都是具体的 → 不通配 'MARS'
    // 所以应该全 miss
    expect(r.matchedRuleId).toBeNull();
    expect(r.total).toBe(0);
  });
});

describe("FeeCalculator — effective window", () => {
  test("asOf 早于 effective_from → 不命中（用 1999 早于所有 seed 2024-01-01）", async () => {
    const r = await calc.calculate({
      broker: "futu",
      market: "CN",
      assetClass: "stock",
      side: "buy",
      qty: 1000,
      price: 10,
      asOf: "1999-01-01",
    });
    expect(r.matchedRuleId).toBeNull();
    expect(r.total).toBe(0);
  });
});

describe("FeeCalculator — applyRule 直接用 fake rule", () => {
  test("rule=null → 全 0", () => {
    const r = calc.applyRule(
      { broker: "x", market: "x", assetClass: "x", side: "buy", qty: 100, price: 10 },
      null
    );
    expect(r).toEqual({
      commission: 0,
      stampDuty: 0,
      transferFee: 0,
      total: 0,
      matchedRuleId: null,
    });
  });
  test("自定义 rule：rate 0.01 / min 0", () => {
    const r = calc.applyRule(
      { broker: "x", market: "x", assetClass: "x", side: "buy", qty: 100, price: 10 },
      {
        id: "test",
        broker: "x",
        market: "x",
        assetClass: "x",
        side: "buy",
        commissionRate: 0.01,
        commissionMin: 0,
        stampDutyRate: 0,
        transferFeeRate: 0,
        enabled: true,
        priority: 100,
        effectiveFrom: "2024-01-01",
        effectiveTo: null,
      }
    );
    expect(r.commission).toBe(10);
    expect(r.total).toBe(10);
    expect(r.matchedRuleId).toBe("test");
  });
});

describe("FeeCalculator — calculateBatch", () => {
  test("空数组 → 空", async () => {
    expect(await calc.calculateBatch([])).toEqual([]);
  });
  test("批量 3 笔 = 单笔 3 次", async () => {
    const input = {
      broker: "ib" as const,
      market: "US",
      assetClass: "stock",
      side: "buy" as const,
      qty: 100,
      price: 100,
      asOf: "2026-06-02",
    };
    const r = await calc.calculateBatch([input, input, input]);
    expect(r).toHaveLength(3);
    for (const row of r) expect(row.total).toBeCloseTo(1.0, 6);
  });
});
