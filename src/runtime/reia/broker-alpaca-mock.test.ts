import { describe, expect, test } from "bun:test";
import {
  createBrokerConnector,
  getBrokerConnector,
  type BrokerProvider,
} from "./broker-connector";

/**
 * MockAlpacaConnector 行为契约测试。
 *
 * 不覆盖真实 HTTP 调用（那个走 broker_http_server.py + python alpaca adapter，单独 e2e）。
 * 这里只保证：
 *   - 'alpaca' provider 在 BrokerProvider 类型里
 *   - getBrokerConnector('alpaca') / createBrokerConnector(mode='mock', provider='alpaca')
 *     都返回可调用 connector
 *   - submit / health / cancel / get / fills / positions 全部返回结构正确的对象
 *   - 滑点在 ±0.5% 内（区别 futu 的 ±0.6% / ib 的 ±0.8%）
 */
describe("MockAlpacaConnector", () => {
  test("BrokerProvider type includes 'alpaca'", () => {
    const p: BrokerProvider = "alpaca";
    expect(p).toBe("alpaca");
  });

  test("getBrokerConnector('alpaca') returns connector with provider=alpaca", () => {
    const c = getBrokerConnector("alpaca");
    expect(c.provider).toBe("alpaca");
    expect(c.mode).toBe("mock");
  });

  test("createBrokerConnector(mode=mock, provider=alpaca) returns MockAlpacaConnector", () => {
    const c = createBrokerConnector({
      provider: "alpaca",
      mode: "mock",
      accountRef: "test-account",
    });
    expect(c.provider).toBe("alpaca");
    expect(c.mode).toBe("mock");
    expect(c.accountRef).toBe("test-account");
  });

  test("submitOrder returns filled order with slippage within ±0.5%", async () => {
    const c = getBrokerConnector("alpaca");
    const base = 100;
    for (let i = 0; i < 30; i++) {
      const r = await c.submitOrder({
        ticker: "AAPL",
        side: "buy",
        quantity: 10,
        orderType: "limit",
        limitPrice: base,
      });
      expect(r.provider).toBe("alpaca");
      expect(r.status).toBe("filled");
      expect(r.brokerOrderId).toMatch(/^alpaca-/);
      expect(r.actualQuantity).toBe(10);
      // ±0.5% slippage band（与 MockAlpacaConnector 实现一致）
      const drift = Math.abs(r.actualPrice - base) / base;
      expect(drift).toBeLessThanOrEqual(0.005 + 1e-9);
    }
  });

  test("healthCheck returns healthy + accountRef", async () => {
    const c = createBrokerConnector({
      provider: "alpaca",
      mode: "mock",
      accountRef: "paper-acct-7",
    });
    const h = await c.healthCheck();
    expect(h.provider).toBe("alpaca");
    expect(h.status).toBe("healthy");
    expect(h.accountRef).toBe("paper-acct-7");
    expect(h.message).toContain("mock");
  });

  test("cancelOrder / getOrder / getFills / getPositions don't throw", async () => {
    const c = getBrokerConnector("alpaca");
    await c.cancelOrder("alpaca-fake-id");
    const o = await c.getOrder("alpaca-fake-id");
    expect(o.brokerOrderId).toBe("alpaca-fake-id");
    const fills = await c.getFills("alpaca-fake-id");
    expect(Array.isArray(fills)).toBe(true);
    const pos = await c.getPositions();
    expect(Array.isArray(pos)).toBe(true);
  });
});
