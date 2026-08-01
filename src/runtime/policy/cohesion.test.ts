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
      artifactsOk: false,
      factorDefinitionCount: 0,
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
    expect(tools).toContain("order.create_intent");
    expect(tools).not.toContain("market.readiness");
    expect(tools).not.toContain("factor.list");
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
      artifactsOk: false,
      factorDefinitionCount: 1,
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
