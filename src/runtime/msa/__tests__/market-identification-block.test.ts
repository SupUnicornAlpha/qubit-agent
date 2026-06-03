import { describe, expect, test } from "bun:test";
import { buildMarketIdentificationBlock } from "../analyst-team-context";

describe("buildMarketIdentificationBlock — 注入到 prompt 让 LLM 不靠猜", () => {
  test("空 primary → 不输出", () => {
    expect(buildMarketIdentificationBlock("")).toBe("");
  });

  test("000001 → 显示 CN/SZ inferred（修 000001 错路 bug 的 prompt 侧）", () => {
    const out = buildMarketIdentificationBlock("000001");
    expect(out).toMatch(/系统市场识别/);
    expect(out).toMatch(/market=\*\*CN\*\* \/ exchange=\*\*SZ\*\*/);
    expect(out).toMatch(/confidence=inferred/);
    expect(out).toMatch(/leading 0/);
  });

  test("600519 → CN/SH", () => {
    expect(buildMarketIdentificationBlock("600519")).toMatch(/market=\*\*CN\*\* \/ exchange=\*\*SH\*\*/);
  });

  test("AAPL → US/US", () => {
    expect(buildMarketIdentificationBlock("AAPL")).toMatch(/market=\*\*US\*\* \/ exchange=\*\*US\*\*/);
  });

  test("00700.HK → HK/HK explicit", () => {
    const out = buildMarketIdentificationBlock("00700.HK");
    expect(out).toMatch(/market=\*\*HK\*\* \/ exchange=\*\*HK\*\*/);
    expect(out).toMatch(/confidence=explicit/);
  });

  test("hintExchange override 走 explicit 路径", () => {
    const out = buildMarketIdentificationBlock("AAPL", "NASDAQ");
    expect(out).toMatch(/confidence=explicit/);
    expect(out).toMatch(/hintExchange=NASDAQ/);
  });

  test("BTCUSDT → CRYPTO inferred", () => {
    expect(buildMarketIdentificationBlock("BTCUSDT")).toMatch(/market=\*\*CRYPTO\*\* \/ exchange=\*\*CRYPTO\*\*/);
  });

  test("UNKNOWN ticker → 输出 fallback 探测提示", () => {
    const out = buildMarketIdentificationBlock("XYZ123456");
    expect(out).toMatch(/推断失败/);
    expect(out).toMatch(/fetch_klines/);
  });
});
