import { describe, expect, test } from "bun:test";
import {
  inferFactorLang,
  normalizeFactorExpression,
  formatUnsupportedExpressionError,
} from "./factor-expression-contract";
import { assertAnswerSchema } from "./answer-schema";
import { resolveScenarioRecipe } from "./scenario-recipe";
import { applyToolSurface } from "./tool-surface";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";

describe("factor expression contract", () => {
  test("rewrites shift/delay to Ref and defaults to qlib_expr", () => {
    const normalized = normalizeFactorExpression("close / shift(close, 21) - 1");
    expect(normalized.expr).toContain("Ref(");
    expect(normalized.rewrites).toContain("shift→Ref");
    expect(inferFactorLang(normalized.expr)).toBe("qlib_expr");
  });

  test("clamps huge Ref lookbacks for dry-run viability", () => {
    const normalized = normalizeFactorExpression("close / Ref(close, 252) - 1");
    expect(normalized.expr).toContain("Ref(close, 21)");
    expect(normalized.rewrites.some((r) => r.includes("252"))).toBe(true);
  });

  test("flags python-only symbols", () => {
    const normalized = normalizeFactorExpression("pd.Series(close).pct_change()");
    expect(normalized.unsupported).toContain("pd");
    expect(formatUnsupportedExpressionError({ expr: "x", reason: "bad" })).toContain(
      "unsupported_expression"
    );
  });
});

describe("tool surface second hop", () => {
  test("after strategy version, prefers compose/order tools", () => {
    const snapshot = {
      workflowId: "wf",
      scenarioKey: "live_trading",
      recipe: resolveScenarioRecipe("live_trading"),
      authorizedTools: [],
      attemptedTools: ["strategy.create_version"],
      successfulTools: ["strategy.create_version"],
      notAttemptedCapabilities: ["order"],
      unavailableCapabilities: [],
      missingArtifactTables: ["order_intent"],
      missingArtifacts: [],
      artifactsOk: false,
      researchArtifactsOk: false,
      factorDefinitionCount: 0,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: null,
      strategyVersionId: "sv-1",
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    const tools = applyToolSurface({
      tools: [
        "strategy.create_version",
        "order.create_intent",
        "factor.list",
        "update_plan",
        "market.readiness",
      ],
      snapshot,
      role: "execute",
    });
    expect(tools).toEqual(["order.create_intent"]);
    expect(tools).not.toContain("market.readiness");
    expect(tools).not.toContain("factor.list");
    expect(tools).not.toContain("evaluate_risk");
  });

  test("live trading strips submit_order before order_intent", () => {
    const snapshot = {
      workflowId: "wf",
      scenarioKey: "live_trading",
      recipe: resolveScenarioRecipe("live_trading"),
      authorizedTools: [],
      attemptedTools: ["strategy.create_version"],
      successfulTools: ["strategy.create_version"],
      notAttemptedCapabilities: ["order.create_intent"],
      unavailableCapabilities: [],
      missingArtifactTables: ["order_intent", "risk_decision"],
      missingArtifacts: [],
      artifactsOk: false,
      researchArtifactsOk: false,
      factorDefinitionCount: 0,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: null,
      strategyVersionId: "sv-1",
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    const tools = applyToolSurface({
      tools: [
        "order.create_intent",
        "qubit-broker/submit_order",
        "qubit-risk/evaluate_risk",
        "rule.evaluate",
        "strategy.create_version",
      ],
      snapshot,
      role: "execute",
    });
    expect(tools).toEqual(["order.create_intent"]);
    expect(tools).not.toContain("rule.evaluate");
  });

  test("stock pick after screener keeps quote + recommendation tools", () => {
    const snapshot = {
      workflowId: "wf",
      scenarioKey: "stock_pick",
      recipe: resolveScenarioRecipe("stock_pick"),
      authorizedTools: [],
      attemptedTools: ["run_screener"],
      successfulTools: ["run_screener"],
      notAttemptedCapabilities: ["get_quote", "recommendation.record"],
      unavailableCapabilities: [],
      missingArtifactTables: ["recommendation_snapshot"],
      missingArtifacts: [],
      artifactsOk: false,
      researchArtifactsOk: false,
      factorDefinitionCount: 0,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: "AAPL",
      strategyVersionId: null,
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    const tools = applyToolSurface({
      tools: [
        "run_screener",
        "fetch_klines",
        "recommendation.record",
        "update_plan",
        "factor.list",
      ],
      snapshot,
      role: "research",
    });
    expect(tools).toContain("recommendation.record");
    expect(tools).toContain("fetch_klines");
    expect(tools).not.toContain("run_screener");
    expect(tools).not.toContain("factor.list");
  });

  test("research after klines prefers news tools", () => {
    const snapshot = {
      workflowId: "wf",
      scenarioKey: "research_multi",
      recipe: resolveScenarioRecipe("research_multi"),
      authorizedTools: [],
      attemptedTools: ["qubit-data/fetch_klines"],
      successfulTools: [
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
      ],
      notAttemptedCapabilities: ["news"],
      unavailableCapabilities: [],
      missingArtifactTables: [],
      missingArtifacts: [],
      artifactsOk: false,
      researchArtifactsOk: false,
      factorDefinitionCount: 0,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: null,
      strategyVersionId: null,
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    const tools = applyToolSurface({
      tools: [
        "fetch_klines",
        "fetch_news",
        "run_analyst_team",
        "update_plan",
        "market.readiness",
      ],
      snapshot,
      role: "research",
    });
    expect(tools).toEqual(["fetch_news"]);
    expect(tools).not.toContain("fetch_klines");
    expect(tools).not.toContain("market.readiness");
  });

  test("research after klines strips quote tools when agent lacks fetch_news", () => {
    const snapshot = {
      workflowId: "wf",
      scenarioKey: "research",
      recipe: resolveScenarioRecipe("research"),
      authorizedTools: [],
      attemptedTools: ["qubit-data/fetch_klines"],
      successfulTools: [
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
        "qubit-data/fetch_klines",
      ],
      notAttemptedCapabilities: ["news"],
      unavailableCapabilities: [],
      missingArtifactTables: [],
      missingArtifacts: [],
      artifactsOk: false,
      researchArtifactsOk: false,
      factorDefinitionCount: 0,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: null,
      strategyVersionId: null,
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    const tools = applyToolSurface({
      tools: [
        "fetch_klines",
        "fetch_price_data",
        "compute_indicators",
        "code.run_python",
        "market.readiness",
      ],
      snapshot,
      role: "analyst_technical",
    });
    expect(tools).toContain("compute_indicators");
    expect(tools).toContain("code.run_python");
    expect(tools).not.toContain("fetch_klines");
    expect(tools).not.toContain("fetch_price_data");
    expect(tools).not.toContain("market.readiness");
  });

  test("after factor registration, exposes evaluation instead of duplicate registration", () => {
    const snapshot = {
      workflowId: "wf",
      scenarioKey: "factor",
      recipe: resolveScenarioRecipe("factor"),
      authorizedTools: [],
      attemptedTools: ["factor.register"],
      successfulTools: ["factor.register"],
      notAttemptedCapabilities: [],
      unavailableCapabilities: [],
      missingArtifactTables: ["factor_evaluation"],
      missingArtifacts: [],
      artifactsOk: false,
      researchArtifactsOk: false,
      factorDefinitionCount: 1,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: null,
      strategyVersionId: null,
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    expect(
      applyToolSurface({
        tools: ["factor.register", "factor.compute", "factor.evaluate", "factor.autoEvaluate"],
        snapshot,
        role: "factor",
      })
    ).toEqual(["factor.compute", "factor.evaluate", "factor.autoEvaluate"]);
  });
});

describe("answer schema still required", () => {
  test("sections", () => {
    const ok = assertAnswerSchema(
      { requiredSections: ["goal", "evidence", "decision", "risks", "gaps"] },
      "## goal\nx\n## evidence\ny\n## decision\nz\n## risks\nr\n## gaps\ng"
    );
    expect(ok.schemaOk).toBe(true);
  });
});
