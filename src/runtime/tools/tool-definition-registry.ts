/**
 * Provider-neutral tool definition registry.
 *
 * This is the single source for model-facing descriptions and input schemas.
 * Execution handlers may still perform stricter runtime validation, but
 * provider adapters must never recreate business schemas from tool names.
 */
import { getToolCatalogMap } from "./tool-catalog";

export type RegisteredToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

const SCHEMAS: Record<string, Record<string, unknown>> = {
  "tool.catalog.search": {
    type: "object",
    properties: {
      query: { type: "string" },
      category: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    additionalProperties: false,
  },
  update_plan: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["agent", "plan", "goal", "ask", "diagnose"] },
      goal: { type: "object" },
      steps: { type: "array", items: { type: "object" }, minItems: 1 },
    },
    required: ["steps"],
    additionalProperties: true,
  },
  "agent.invoke": {
    type: "object",
    properties: {
      callee_spec_id: { type: "string" },
      agent_ref: { type: "string" },
      role: { type: "string" },
      goal: { type: "string" },
      task: { type: "string" },
      handoff: { type: "object" },
    },
    required: ["goal", "callee_spec_id"],
    additionalProperties: true,
  },
  "factor.register": {
    type: "object",
    properties: {
      name: { type: "string" },
      expr: { type: "string" },
      expression: { type: "string" },
      category: { type: "string" },
      lang: { type: "string" },
      universe: { type: "string" },
      horizon: { type: "integer" },
    },
    required: ["name", "expr"],
    additionalProperties: true,
  },
  "factor.compute": {
    type: "object",
    properties: {
      factor_id: { type: "string" },
      factorId: { type: "string" },
      symbols: { type: "array", items: { type: "string" }, minItems: 1 },
      symbol: { type: "string" },
      ticker: { type: "string" },
      start_date: { type: "string" },
      end_date: { type: "string" },
      startDate: { type: "string" },
      endDate: { type: "string" },
    },
    required: ["factor_id", "symbols"],
    additionalProperties: true,
  },
  "factor.autoEvaluate": {
    type: "object",
    properties: {
      factor_id: { type: "string" },
      factorId: { type: "string" },
      symbols: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["factor_id", "symbols"],
    additionalProperties: true,
  },
  "strategy.create_version": {
    type: "object",
    properties: {
      name: { type: "string" },
      style: { type: "string" },
      description: { type: "string" },
      universe: { type: "string" },
    },
    required: ["name"],
    additionalProperties: true,
  },
  "strategy.compose": {
    type: "object",
    properties: {
      strategy_version_id: { type: "string" },
      strategyVersionId: { type: "string" },
      factor_ids: { type: "array", items: { type: "string" } },
      rule_ids: { type: "array", items: { type: "string" } },
      kind: { type: "string" },
      weight_method: { type: "string" },
      universe: { type: "string" },
    },
    required: ["strategy_version_id"],
    additionalProperties: true,
  },
  "backtest.run": {
    type: "object",
    properties: {
      strategy_version_id: { type: "string" },
      strategyVersionId: { type: "string" },
      symbols: { type: "array", items: { type: "string" }, minItems: 1 },
      symbol: { type: "string" },
      ticker: { type: "string" },
      composition_id: { type: "string" },
      signals: { type: "object" },
      dataset_snapshot_id: { type: "string" },
      datasetSnapshotId: { type: "string" },
      start_date: { type: "string" },
      end_date: { type: "string" },
      benchmark: { type: "string" },
      capital: { type: "number" },
      costs: { type: "object" },
      instruments: { type: "object" },
    },
    required: ["strategy_version_id", "symbols", "dataset_snapshot_id"],
    additionalProperties: true,
  },
  "backtest.walk_forward": {
    type: "object",
    properties: {
      backtest_run_id: { type: "string" },
      selection: { type: "object" },
      folds: { type: "array", items: { type: "object" } },
    },
    required: ["backtest_run_id"],
    additionalProperties: true,
  },
};

export function getRegisteredToolDefinition(name: string): RegisteredToolDefinition {
  const catalogEntry = getToolCatalogMap().get(name);
  return {
    name,
    description: catalogEntry?.description ?? `Registered tool: ${name}`,
    parameters: SCHEMAS[name] ?? { ...OBJECT_SCHEMA },
  };
}

export function getRegisteredToolDefinitions(names: string[]): RegisteredToolDefinition[] {
  return [...new Set(names.filter((name) => name.trim()))]
    .sort()
    .map(getRegisteredToolDefinition);
}
