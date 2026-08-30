import { describe, expect, test } from "bun:test";
import {
  getRegisteredToolDefinition,
  getRegisteredToolDefinitions,
} from "./tool-definition-registry";

describe("tool definition registry", () => {
  test("owns model-facing descriptions and schemas", () => {
    const factor = getRegisteredToolDefinition("factor.compute");
    expect(factor.description.length).toBeGreaterThan(0);
    expect(factor.parameters.required).toEqual(["factor_id", "symbols"]);

    const backtest = getRegisteredToolDefinition("backtest.run");
    expect(backtest.parameters.required).toEqual([
      "strategy_version_id",
      "symbols",
      "dataset_snapshot_id",
    ]);
    expect(backtest.parameters.properties).toHaveProperty("instruments");
  });

  test("returns a deterministic, deduplicated surface", () => {
    const definitions = getRegisteredToolDefinitions(["web.search", "factor.compute", "web.search"]);
    expect(definitions.map((definition) => definition.name)).toEqual([
      "factor.compute",
      "web.search",
    ]);
  });
});
