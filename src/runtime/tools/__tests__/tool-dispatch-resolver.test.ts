import { describe, expect, test } from "bun:test";
import { resolveToolExecutionRoute } from "../tool-dispatch-resolver";

describe("resolveToolExecutionRoute (runtime 4.5 · A 类冗余)", () => {
  test("deprecated connector 别名优先走 builtin", () => {
    const r = resolveToolExecutionRoute("compute_factors");
    expect(r.aliased).toBe(true);
    expect(r.effectiveName).toBe("factor.compute");
    expect(r.route).toBe("builtin");
  });

  test("version_strategy → strategy.create_version (builtin)", () => {
    const r = resolveToolExecutionRoute("version_strategy");
    expect(r.route).toBe("builtin");
    expect(r.effectiveName).toBe("strategy.create_version");
  });

  test("fetch_klines 仍走 connector（无 builtin 等价）", () => {
    const r = resolveToolExecutionRoute("fetch_klines");
    expect(r.route).toBe("connector");
    expect(r.connectorName).toBe("qubit-data");
  });

  test("fetch_bars 别名到 fetch_klines 后仍走 connector", () => {
    const r = resolveToolExecutionRoute("fetch_bars");
    expect(r.aliased).toBe(true);
    expect(r.effectiveName).toBe("fetch_klines");
    expect(r.route).toBe("connector");
  });

  test("factor.compute 直接调用走 builtin", () => {
    const r = resolveToolExecutionRoute("factor.compute");
    expect(r.route).toBe("builtin");
    expect(r.aliased).toBe(false);
  });
});
