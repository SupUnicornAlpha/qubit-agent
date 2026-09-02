import { describe, expect, test } from "bun:test";
import { selectRuntimesToStopOnTradingPause } from "../trader.routes";

describe("trading module pause runtime selection", () => {
  const runtimes = [
    { id: "paper-a", executionMode: "paper" as const, brokerAccountId: null },
    { id: "sim-a", executionMode: "sim" as const, brokerAccountId: "sandbox-a" },
    { id: "live-a", executionMode: "live" as const, brokerAccountId: "live-a" },
    { id: "shadow-a", executionMode: "shadow" as const, brokerAccountId: null },
  ];

  test("stops every executable runtime but retains shadow observation", () => {
    expect(selectRuntimesToStopOnTradingPause(runtimes, {})).toEqual([
      runtimes[0],
      runtimes[1],
      runtimes[2],
    ]);
  });

  test("applies account and runtime scope without reclassifying shadow", () => {
    expect(selectRuntimesToStopOnTradingPause(runtimes, { brokerAccountId: "sandbox-a" })).toEqual([
      runtimes[1],
    ]);
    expect(selectRuntimesToStopOnTradingPause(runtimes, { strategyRuntimeId: "shadow-a" })).toEqual(
      []
    );
  });
});
