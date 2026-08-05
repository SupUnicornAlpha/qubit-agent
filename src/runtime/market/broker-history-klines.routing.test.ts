import { describe, expect, test } from "bun:test";
import {
  parseKlinesDataSourceSetting,
  resolveEffectiveKlinesSource,
} from "./klines-data-source";

describe("ib / ifind (supermind) klines routing", () => {
  test("parses ib and ifind aliases", () => {
    expect(parseKlinesDataSourceSetting("ib")).toBe("ib_bridge");
    expect(parseKlinesDataSourceSetting("ib_bridge")).toBe("ib_bridge");
    expect(parseKlinesDataSourceSetting("ifind")).toBe("supermind_bridge");
    expect(parseKlinesDataSourceSetting("ths")).toBe("supermind_bridge");
    expect(parseKlinesDataSourceSetting("supermind")).toBe("supermind_bridge");
  });

  test("auto prefers iFinD for A-shares when available", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
        hasWindAvailable: false,
        hasFutuAvailable: true,
        hasIfindAvailable: true,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("supermind_bridge");
  });

  test("wind still beats iFinD for A-shares", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: true,
        hasWindAvailable: true,
        hasIfindAvailable: true,
        hasFutuAvailable: true,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("wind");
  });

  test("auto prefers IB for US when available and Futu not", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
        hasFutuAvailable: false,
        hasIbAvailable: true,
        symbol: "AAPL",
        exchange: "US",
      })
    ).toBe("ib_bridge");
  });

  test("Futu still beats IB for US when both available", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
        hasFutuAvailable: true,
        hasIbAvailable: true,
        symbol: "AAPL",
        exchange: "US",
      })
    ).toBe("futu_bridge");
  });

  test("explicit ib_bridge / supermind_bridge modes", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "ib_bridge" } },
        period: "1d",
        hasTushareToken: false,
        hasIbAvailable: true,
        symbol: "AAPL",
        exchange: "US",
      })
    ).toBe("ib_bridge");
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "supermind_bridge" } },
        period: "1d",
        hasTushareToken: false,
        hasIfindAvailable: true,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("supermind_bridge");
  });
});
