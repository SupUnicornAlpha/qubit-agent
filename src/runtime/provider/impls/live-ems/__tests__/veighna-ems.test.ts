/**
 * VeighnaEmsProvider — 内存 paper-trade 单测
 *
 * 验证 submitOrder / cancelOrder / getOrderStatus / getAccountSnapshot 四件套
 * 在 paper 模式下的行为正确。
 */

import { describe, expect, test } from "bun:test";
import { VeighnaEmsProvider } from "../veighna-ems-provider";

describe("VeighnaEmsProvider (paper mode)", () => {
  test("meta + healthCheck：kind=live_ems, paper 模式 ok", async () => {
    const p = new VeighnaEmsProvider();
    expect(p.meta.kind).toBe("live_ems");
    expect(p.meta.key).toBe("veighna_ems");
    const h = await p.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.meta?.["mode"]).toBe("paper");
  });

  test("submitOrder：买单 → filled + cash 扣除 + 持仓增加", async () => {
    const p = new VeighnaEmsProvider({ startingCash: 100_000 });
    const ack = await p.submitOrder({
      intentOrderId: "i1",
      accountRef: "test_acc",
      symbol: "AAPL",
      exchange: "NASDAQ",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      limitPrice: 200,
    });
    expect(ack.status).toBe("filled");
    expect(ack.filledQty).toBe(10);
    expect(ack.avgPrice).toBe(200);
    expect(ack.brokerOrderId).toMatch(/^vn_/);

    const snap = await p.getAccountSnapshot({ accountRef: "test_acc" });
    expect(snap.cash).toBe(98_000);
    expect(snap.positions.length).toBe(1);
    expect(snap.positions[0]!.symbol).toBe("AAPL");
    expect(snap.positions[0]!.quantity).toBe(10);
    expect(snap.positions[0]!.avgCost).toBe(200);
    expect(snap.equity).toBe(100_000);
  });

  test("submitOrder：资金不足 → rejected，账户不变", async () => {
    const p = new VeighnaEmsProvider({ startingCash: 1_000 });
    const ack = await p.submitOrder({
      intentOrderId: "i2",
      accountRef: "lowcash",
      symbol: "TSLA",
      exchange: "NASDAQ",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      limitPrice: 500,
    });
    expect(ack.status).toBe("rejected");

    const snap = await p.getAccountSnapshot({ accountRef: "lowcash" });
    expect(snap.cash).toBe(1_000);
    expect(snap.positions.length).toBe(0);
  });

  test("submitOrder：多次买入同 symbol → 持仓累加 + 平均成本正确", async () => {
    const p = new VeighnaEmsProvider({ startingCash: 100_000 });
    await p.submitOrder({
      intentOrderId: "i3a",
      accountRef: "acc",
      symbol: "X",
      exchange: "NYSE",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      limitPrice: 100,
    });
    await p.submitOrder({
      intentOrderId: "i3b",
      accountRef: "acc",
      symbol: "X",
      exchange: "NYSE",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      limitPrice: 200,
    });
    const snap = await p.getAccountSnapshot({ accountRef: "acc" });
    expect(snap.positions[0]!.quantity).toBe(20);
    // avg = (100*10 + 200*10) / 20 = 150
    expect(snap.positions[0]!.avgCost).toBe(150);
    expect(snap.cash).toBe(100_000 - 1_000 - 2_000);
  });

  test("submitOrder：卖空（无持仓） → rejected", async () => {
    const p = new VeighnaEmsProvider();
    const ack = await p.submitOrder({
      intentOrderId: "i4",
      accountRef: "acc",
      symbol: "Y",
      exchange: "",
      side: "sell",
      orderType: "limit",
      quantity: 5,
      limitPrice: 100,
    });
    expect(ack.status).toBe("rejected");
  });

  test("submitOrder：买后再卖 → 持仓减少 + 现金返还", async () => {
    const p = new VeighnaEmsProvider({ startingCash: 100_000 });
    await p.submitOrder({
      intentOrderId: "i5a",
      accountRef: "acc",
      symbol: "Z",
      exchange: "",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      limitPrice: 50,
    });
    await p.submitOrder({
      intentOrderId: "i5b",
      accountRef: "acc",
      symbol: "Z",
      exchange: "",
      side: "sell",
      orderType: "limit",
      quantity: 6,
      limitPrice: 60,
    });
    const snap = await p.getAccountSnapshot({ accountRef: "acc" });
    expect(snap.positions[0]!.quantity).toBe(4);
    // cash = 100000 - 500 (买) + 360 (卖 6@60)
    expect(snap.cash).toBe(100_000 - 500 + 360);
  });

  test("getOrderStatus：填入已成交订单返回 filled", async () => {
    const p = new VeighnaEmsProvider({ startingCash: 100_000 });
    const ack = await p.submitOrder({
      intentOrderId: "i6",
      accountRef: "acc",
      symbol: "W",
      exchange: "",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      limitPrice: 100,
    });
    const status = await p.getOrderStatus({
      brokerOrderId: ack.brokerOrderId,
      accountRef: "acc",
    });
    expect(status.status).toBe("filled");
    expect(status.filledQty).toBe(1);
    expect(status.avgPrice).toBe(100);
  });

  test("cancelOrder：已 filled 订单不可撤", async () => {
    const p = new VeighnaEmsProvider({ startingCash: 100_000 });
    const ack = await p.submitOrder({
      intentOrderId: "i7",
      accountRef: "acc",
      symbol: "V",
      exchange: "",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      limitPrice: 100,
    });
    const r = await p.cancelOrder({
      brokerOrderId: ack.brokerOrderId,
      accountRef: "acc",
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("filled");
  });
});
