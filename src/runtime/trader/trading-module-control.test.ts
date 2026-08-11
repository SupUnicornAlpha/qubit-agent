import { afterEach, describe, expect, test } from "bun:test";
import {
  assertTradingModuleEnabled,
  getTradingModuleStatus,
  resetTradingModuleForTest,
  setTradingModuleEnabled,
} from "./trading-module-control";

afterEach(() => resetTradingModuleForTest());

describe("trading-module-control", () => {
  test("default is enabled", () => {
    expect(getTradingModuleStatus().enabled).toBe(true);
  });

  test("paused module blocks new trading work until explicitly resumed", () => {
    expect(setTradingModuleEnabled(false).enabled).toBe(false);
    expect(() => assertTradingModuleEnabled()).toThrow("trading_module_paused");
    expect(setTradingModuleEnabled(true).enabled).toBe(true);
    expect(() => assertTradingModuleEnabled()).not.toThrow();
  });
});
