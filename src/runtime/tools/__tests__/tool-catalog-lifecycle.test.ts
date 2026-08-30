import { describe, expect, test } from "bun:test";
import { RETIRED_GLOBAL_TOOL_NAMES, buildToolCatalog, resolveToolAlias } from "../tool-catalog";
import type { ToolCatalogEntry } from "../types";

function find(name: string): ToolCatalogEntry {
  const e = buildToolCatalog().find((x) => x.name === name);
  if (!e) throw new Error(`tool ${name} missing from catalog`);
  return e;
}

describe("tool-catalog lifecycle metadata", () => {
  test("default tools without explicit lifecycle remain stable (lifecycle undefined)", () => {
    expect(find("memory.recall").lifecycle).toBeUndefined();
    expect(find("fetch_klines").lifecycle).toBeUndefined();
    expect(find("evaluate_risk").lifecycle).toBeUndefined();
  });

  test("Prime D6 / Phase A team-compat tools are absent from the global catalog", () => {
    for (const name of ["run_analyst_team", "summarize_team_decision", "fuse_signals"]) {
      expect(buildToolCatalog().some((entry) => entry.name === name)).toBe(false);
      expect(resolveToolAlias(name).aliased).toBe(false);
      expect(resolveToolAlias(name).resolved).toBe(name);
    }
  });

  test("all centralized retired names are absent from the global catalog", () => {
    const names = new Set(buildToolCatalog().map((entry) => entry.name));
    for (const name of RETIRED_GLOBAL_TOOL_NAMES) expect(names.has(name)).toBe(false);
  });

  test("Step 2 deleted stubs are absent from catalog", () => {
    const deleted = ["task_decompose", "analyze_industry", "analyze_policy", "get_analyst_ratings"];
    const names = new Set(buildToolCatalog().map((e) => e.name));
    for (const name of deleted) {
      expect(names.has(name)).toBe(false);
    }
  });

  test("retired aliases still resolve for persisted workflow compatibility", () => {
    const cases: Array<{ name: string; replacedBy: string }> = [
      { name: "fetch_macro_data", replacedBy: "compute_macro_indicators" },
      { name: "fetch_bars", replacedBy: "fetch_klines" },
      { name: "check_risk", replacedBy: "evaluate_risk" },
      { name: "factor.evaluate", replacedBy: "factor.autoEvaluate" },
      { name: "compute_factors", replacedBy: "factor.compute" },
      { name: "run_experiment", replacedBy: "factor.autoEvaluate" },
      { name: "version_strategy", replacedBy: "strategy.create_version" },
    ];
    for (const { name, replacedBy } of cases) {
      expect(buildToolCatalog().some((entry) => entry.name === name)).toBe(false);
      expect(resolveToolAlias(name).resolved).toBe(replacedBy);
    }
  });

  test("every deprecated entry has both replacedBy and deprecationReason", () => {
    const all = buildToolCatalog();
    for (const e of all) {
      if (e.lifecycle === "deprecated") {
        expect(e.replacedBy, `${e.name} missing replacedBy`).toBeTruthy();
        expect(e.deprecationReason, `${e.name} missing reason`).toBeTruthy();
      }
    }
  });

  test("migrated research alias 无 connector 路由时也不再出现在 catalog", () => {
    expect(buildToolCatalog().some((entry) => entry.name === "compute_factors")).toBe(false);
    expect(resolveToolAlias("compute_factors").resolved).toBe("factor.compute");
  });
});

describe("resolveToolAlias (Step 3 — deprecated 别名透明跳转)", () => {
  test("stable 工具不被 alias", () => {
    const r = resolveToolAlias("fetch_klines");
    expect(r.aliased).toBe(false);
    expect(r.resolved).toBe("fetch_klines");
    expect(r.originalName).toBe("fetch_klines");
  });

  test("非 catalog 工具（未知名字）不被 alias", () => {
    const r = resolveToolAlias("foo_bar_unknown");
    expect(r.aliased).toBe(false);
    expect(r.resolved).toBe("foo_bar_unknown");
  });

  test("7 个 deprecated 工具都能正确解析到 replacedBy", () => {
    const cases: Array<{ from: string; to: string }> = [
      { from: "fetch_macro_data", to: "compute_macro_indicators" },
      { from: "fetch_bars", to: "fetch_klines" },
      { from: "check_risk", to: "evaluate_risk" },
      { from: "factor.evaluate", to: "factor.autoEvaluate" },
      { from: "compute_factors", to: "factor.compute" },
      { from: "run_experiment", to: "factor.autoEvaluate" },
      { from: "version_strategy", to: "strategy.create_version" },
    ];
    for (const { from, to } of cases) {
      const r = resolveToolAlias(from);
      expect(r.aliased, `${from} should be aliased`).toBe(true);
      expect(r.resolved).toBe(to);
      expect(r.originalName).toBe(from);
      expect(r.replacedBy).toBe(to);
    }
  });

  test("防御：不会出现链式跳转（target 自己是 deprecated 会拒绝 alias）", () => {
    // 当前所有透明 alias 的 deprecated 工具的 replacedBy 目标都不是 deprecated
    // —— resolveAlias:false 的 sunset 工具不参与 alias，跳过
    const all = buildToolCatalog();
    const deprecatedNames = all.filter((e) => e.lifecycle === "deprecated").map((e) => e.name);
    for (const name of deprecatedNames) {
      const r = resolveToolAlias(name);
      if (!r.aliased) continue;
      const targetEntry = all.find((e) => e.name === r.resolved);
      expect(targetEntry).toBeDefined();
      expect(
        targetEntry?.lifecycle,
        `${name} -> ${r.resolved}: target must not be deprecated`
      ).not.toBe("deprecated");
    }
  });
});
