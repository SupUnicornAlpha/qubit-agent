import { describe, expect, test } from "bun:test";
import { generateGbmTicks, GBM_MIN_LENGTH } from "../synthesize-gbm";

describe("synthesize-gbm", () => {
  test("同 symbol 应产生确定性序列（可重复）", () => {
    const a = generateGbmTicks("AAPL", 100);
    const b = generateGbmTicks("AAPL", 100);
    expect(a).toEqual(b);
  });

  test("不同 symbol 应产生不同 seed → 序列不一致", () => {
    const a = generateGbmTicks("AAPL", 60);
    const b = generateGbmTicks("TSLA", 60);
    const firstCloseDiff = a[0]!.close !== b[0]!.close;
    expect(firstCloseDiff).toBe(true);
  });

  test("count 小于最小长度时应回退到最小长度", () => {
    const ticks = generateGbmTicks("AAPL", 5);
    expect(ticks.length).toBe(GBM_MIN_LENGTH);
  });

  test("OHLCV 关系满足：high ≥ max(open, close) ≥ min(open, close) ≥ low", () => {
    const ticks = generateGbmTicks("BTCUSDT", 50);
    for (const t of ticks) {
      const hi = Math.max(t.open, t.close);
      const lo = Math.min(t.open, t.close);
      expect(t.high).toBeGreaterThanOrEqual(hi - 1e-9);
      expect(t.low).toBeLessThanOrEqual(lo + 1e-9);
      expect(t.close).toBeGreaterThan(0);
      expect(t.volume).toBeGreaterThan(0);
      expect(Math.abs(t.turnover - t.volume * t.close)).toBeLessThan(1e-6);
    }
  });

  test("空字符串 symbol 也能稳定输出", () => {
    const ticks = generateGbmTicks("", 50);
    expect(ticks.length).toBe(50);
    expect(ticks[0]!.close).toBeGreaterThan(0);
  });
});
