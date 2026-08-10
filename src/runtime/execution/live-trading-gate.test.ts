import { describe, expect, test } from "bun:test";
import {
  assertBrokerDispatchAllowed,
  isSimTradingEnabled,
  parseDispatchMode,
} from "./live-trading-gate";

describe("parseDispatchMode", () => {
  test("maps aliases to sim", () => {
    expect(parseDispatchMode("sim")).toBe("sim");
    expect(parseDispatchMode("sandbox")).toBe("sim");
    expect(parseDispatchMode("simulate")).toBe("sim");
    expect(parseDispatchMode("paper_broker")).toBe("sim");
  });

  test("keeps paper and live", () => {
    expect(parseDispatchMode("paper")).toBe("paper");
    expect(parseDispatchMode("local")).toBe("paper");
    expect(parseDispatchMode("live")).toBe("live");
    expect(parseDispatchMode("real")).toBe("live");
  });

  test("rejects unknown", () => {
    expect(() => parseDispatchMode("shadow")).toThrow(/invalid_dispatch_mode/);
  });
});

describe("assertBrokerDispatchAllowed", () => {
  test("paper always allowed", () => {
    expect(() => assertBrokerDispatchAllowed("paper", "live")).not.toThrow();
  });

  test("sim allows sandbox/mock, rejects live account", () => {
    expect(() => assertBrokerDispatchAllowed("sim", "sandbox")).not.toThrow();
    expect(() => assertBrokerDispatchAllowed("sim", "mock")).not.toThrow();
    expect(() => assertBrokerDispatchAllowed("sim", "live")).toThrow(
      /sim_dispatch_requires_sandbox/
    );
  });

  test("sim gate respects QUBIT_SIM_TRADING_ENABLED", () => {
    const prev = process.env.QUBIT_SIM_TRADING_ENABLED;
    process.env.QUBIT_SIM_TRADING_ENABLED = "false";
    try {
      expect(isSimTradingEnabled()).toBe(false);
      expect(() => assertBrokerDispatchAllowed("sim", "sandbox")).toThrow(/sim_trading_disabled/);
    } finally {
      if (prev === undefined) delete process.env.QUBIT_SIM_TRADING_ENABLED;
      else process.env.QUBIT_SIM_TRADING_ENABLED = prev;
    }
  });

  test("provider and account kill switches block sandbox and live dispatch", () => {
    const prevProvider = process.env.QUBIT_KILL_SWITCH_PROVIDERS;
    const prevAccount = process.env.QUBIT_KILL_SWITCH_ACCOUNTS;
    process.env.QUBIT_KILL_SWITCH_PROVIDERS = "ccxt";
    process.env.QUBIT_KILL_SWITCH_ACCOUNTS = "ib:DU123";
    try {
      expect(() =>
        assertBrokerDispatchAllowed("sim", "sandbox", { provider: "ccxt", accountRef: "anything" })
      ).toThrow(/kill_switch_engaged:provider:ccxt/);
      expect(() =>
        assertBrokerDispatchAllowed("live", "live", { provider: "ib", accountRef: "DU123" })
      ).toThrow(/kill_switch_engaged:account:ib:DU123/);
    } finally {
      if (prevProvider === undefined) delete process.env.QUBIT_KILL_SWITCH_PROVIDERS;
      else process.env.QUBIT_KILL_SWITCH_PROVIDERS = prevProvider;
      if (prevAccount === undefined) delete process.env.QUBIT_KILL_SWITCH_ACCOUNTS;
      else process.env.QUBIT_KILL_SWITCH_ACCOUNTS = prevAccount;
    }
  });
});
