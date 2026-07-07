import { describe, expect, test } from "bun:test";
import { buildToolCatalog, resolveToolAlias } from "../tool-catalog";
import type { ToolCatalogEntry, ToolLifecycle } from "../types";

function find(name: string): ToolCatalogEntry {
  const e = buildToolCatalog().find((x) => x.name === name);
  if (!e) throw new Error(`tool ${name} missing from catalog`);
  return e;
}

describe("tool-catalog lifecycle metadata", () => {
  test("default tools without explicit lifecycle remain stable (lifecycle undefined)", () => {
    expect(find("run_analyst_team").lifecycle).toBeUndefined();
    expect(find("fetch_klines").lifecycle).toBeUndefined();
    expect(find("evaluate_risk").lifecycle).toBeUndefined();
  });

  test("remaining stubs are labeled lifecycle=stub with a deprecationReason", () => {
    // Step 2 删除了 task_decompose / analyze_industry / analyze_policy / get_analyst_ratings 4 个纯 builtin stub
    // 留下 4 个仍标 stub 的：connector stub (extract_event/score_sentiment) + 半 stub builtin (analyze_social_media/cleanup_ttl)
    // run_screener 已在 2026-06-05 监控复盘 #4 / C 升级为真实 universe（200+ ticker + sector/industry 过滤），不再是 stub
    const stubs = [
      "score_sentiment",
      "extract_event",
      "analyze_social_media",
      "cleanup_ttl",
    ];
    for (const name of stubs) {
      const e = find(name);
      expect(e.lifecycle).toBe("stub" satisfies ToolLifecycle);
      expect(typeof e.deprecationReason).toBe("string");
      expect((e.deprecationReason ?? "").length).toBeGreaterThan(0);
    }
  });

  test("Step 2 deleted stubs are absent from catalog", () => {
    const deleted = ["task_decompose", "analyze_industry", "analyze_policy", "get_analyst_ratings"];
    const names = new Set(buildToolCatalog().map((e) => e.name));
    for (const name of deleted) {
      expect(names.has(name)).toBe(false);
    }
  });

  test("7 deprecated aliases carry replacedBy pointing to a valid catalog entry", () => {
    const cases: Array<{ name: string; replacedBy: string }> = [
      { name: "fetch_macro_data", replacedBy: "compute_macro_indicators" },
      { name: "fetch_bars", replacedBy: "fetch_klines" },
      { name: "check_risk", replacedBy: "evaluate_risk" },
      { name: "factor.evaluate", replacedBy: "factor.autoEvaluate" },
      { name: "compute_factors", replacedBy: "factor.compute" },
      { name: "run_experiment", replacedBy: "factor.autoEvaluate" },
      { name: "version_strategy", replacedBy: "strategy.create_version" },
    ];
    const catalogNames = new Set(buildToolCatalog().map((e) => e.name));
    for (const { name, replacedBy } of cases) {
      const e = find(name);
      expect(e.lifecycle).toBe("deprecated" satisfies ToolLifecycle);
      expect(e.replacedBy).toBe(replacedBy);
      expect(catalogNames.has(replacedBy)).toBe(true);
      expect(typeof e.deprecationReason).toBe("string");
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

  test("migrated research alias 无 connector 路由时仍出现在 catalog", () => {
    const cf = find("compute_factors");
    expect(cf.lifecycle).toBe("deprecated");
    expect(cf.replacedBy).toBe("factor.compute");
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
    // 当前所有 7 个 replacedBy 目标都不是 deprecated，所以 alias 都生效
    // 但 resolveToolAlias 实现里的 target.lifecycle !== "deprecated" 守卫必须存在
    // —— 用所有 deprecated 工具的 resolved 来反向验证
    const all = buildToolCatalog();
    const deprecatedNames = all.filter((e) => e.lifecycle === "deprecated").map((e) => e.name);
    for (const name of deprecatedNames) {
      const r = resolveToolAlias(name);
      expect(r.aliased).toBe(true);
      const targetEntry = all.find((e) => e.name === r.resolved);
      expect(targetEntry).toBeDefined();
      expect(targetEntry!.lifecycle, `${name} -> ${r.resolved}: target must not be deprecated`).not.toBe("deprecated");
    }
  });
});
