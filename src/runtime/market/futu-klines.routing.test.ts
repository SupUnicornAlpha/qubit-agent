import { describe, expect, test } from "bun:test";

// Lightweight unit tests for Futu symbol / period mapping live in Python.
// Here we cover TS routing helpers that decide when futu_bridge is selected.

import {
  parseKlinesDataSourceSetting,
  resolveEffectiveKlinesSource,
} from "./klines-data-source";

describe("futu klines routing", () => {
  test("parses futu aliases to futu_bridge", () => {
    expect(parseKlinesDataSourceSetting("futu")).toBe("futu_bridge");
    expect(parseKlinesDataSourceSetting("futu_bridge")).toBe("futu_bridge");
  });

  test("auto prefers futu when available for CN/HK/US", () => {
    const settings = { "qubit-data": { klinesDataSource: "auto" } };
    expect(
      resolveEffectiveKlinesSource({
        settings,
        period: "1d",
        hasTushareToken: false,
        hasWindAvailable: false,
        hasFutuAvailable: true,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("futu_bridge");
    expect(
      resolveEffectiveKlinesSource({
        settings,
        period: "1d",
        hasTushareToken: false,
        hasWindAvailable: false,
        hasFutuAvailable: true,
        symbol: "AAPL",
        exchange: "US",
      })
    ).toBe("futu_bridge");
  });

  test("wind still beats futu for A-shares when both available", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: true,
        hasWindAvailable: true,
        hasFutuAvailable: true,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("wind");
  });

  test("explicit futu_bridge mode", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { "qubit-data": { klinesDataSource: "futu_bridge" } },
        period: "5m",
        hasTushareToken: false,
        hasFutuAvailable: true,
        symbol: "00700",
        exchange: "HK",
      })
    ).toBe("futu_bridge");
  });
});
