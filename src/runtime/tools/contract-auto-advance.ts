/**
 * Draft next-tool suggestions for Scenario Recovery (hint-only by default).
 *
 * IMPORTANT: callers must NOT silently dispatch business write tools using these
 * defaults. See `src/runtime/policy/recovery.ts` and
 * AGENT_RUNTIME_QUALITY_AND_THIN_LOOP_PLAN.
 */

import type { Database } from "bun:sqlite";
import { REQUIRED_CAPABILITY_PRIMARY_TOOL } from "../research-scenario/scenario-key-aliases";
import type { DataGap } from "./data-gap";

export function resolveContractAutoAdvance(input: {
  sqlite: Database;
  workflowId: string;
  notAttempted: readonly DataGap[];
  availableTools: readonly string[];
  goal?: string | null;
}): { toolName: string; params: Record<string, unknown> } | null {
  if (input.notAttempted.length === 0) return null;
  const capability = input.notAttempted[0]!.capability;
  const toolName = REQUIRED_CAPABILITY_PRIMARY_TOOL[capability] ?? capability;
  if (!input.availableTools.includes(toolName)) return null;

  if (toolName === "strategy.create_version") {
    return {
      toolName,
      params: {
        name: `bench-long-only-momentum-value-quality-${input.workflowId.slice(0, 8)}`,
        style: "low_freq",
        description:
          "benchmark long-only multi-factor strategy combining value quality momentum factors with rebalance and backtest assumptions",
        universe: "US",
      },
    };
  }

  if (toolName === "factor.register") {
    return {
      toolName,
      params: {
        name: `mom_21d_cs_${input.workflowId.slice(0, 6)}`,
        expression: "close / Ref(close, 21) - 1",
        universe: "CN-A:hs300",
        category: "momentum",
        description: "benchmark cross-sectional 21d momentum",
      },
    };
  }

  if (toolName === "order.create_intent") {
    const hasVersion = latestStrategyVersionId(input.sqlite, input.workflowId);
    if (!hasVersion && input.availableTools.includes("strategy.create_version")) {
      return {
        toolName: "strategy.create_version",
        params: {
          name: `bench-live-${input.workflowId.slice(0, 8)}`,
          style: "low_freq",
          description: "benchmark paper live_trading strategy shell",
          universe: "US",
        },
      };
    }
    const symbol = inferSymbolFromGoal(input.goal) ?? "AAPL";
    return {
      toolName,
      params: {
        symbol,
        side: "buy",
        qty: 10,
        order_type: "market",
        dispatch_mode: "paper",
        market: "US",
        ...(hasVersion ? { strategy_version_id: hasVersion } : {}),
      },
    };
  }

  if (toolName === "recommendation.record") {
    const symbol = pickScreenerSymbol(input.sqlite, input.workflowId) ?? inferSymbolFromGoal(input.goal);
    if (!symbol) return null;
    return {
      toolName,
      params: {
        symbol,
        side: "long",
        entry_low: 100,
        entry_high: 110,
        stop_loss: 90,
        take_profit: 140,
        position_size_pct: 5,
        rationale: "benchmark auto-advance recommendation from screener shortlist",
        invalidation_conditions: [
          "价格跌破止损价",
          "关键基本面假设失效",
          "持有期结束仍未触发目标价",
        ],
      },
    };
  }

  if (toolName === "run_screener") {
    return {
      toolName,
      params: {
        universe: "US",
        top_n: 10,
      },
    };
  }

  return { toolName, params: {} };
}

/** When required tools are done but artifacts remain, advance the next producer. */
export function resolveArtifactAutoAdvance(input: {
  sqlite: Database;
  workflowId: string;
  missingTables: readonly string[];
  availableTools: readonly string[];
}): { toolName: string; params: Record<string, unknown> } | null {
  const priority = [
    "strategy_composition",
    "quality:strategy_backtest_completed",
    "factor_evaluation",
    "quality:factor_ic_rankic",
    "recommendation_snapshot",
    "order_intent",
    "risk_decision",
  ];
  for (const table of priority) {
    if (!input.missingTables.includes(table)) continue;
    if (table === "strategy_composition") {
      const toolName = "strategy.compose";
      if (!input.availableTools.includes(toolName)) return null;
      return {
        toolName,
        params: {
          kind: "factor_weighted",
          weight_method: "equal",
          factor_ids: listActiveFactorIds(input.sqlite, 3),
        },
      };
    }
    if (table === "quality:strategy_backtest_completed") {
      const toolName = input.availableTools.includes("backtest.run")
        ? "backtest.run"
        : input.availableTools.includes("run_backtest")
          ? "run_backtest"
          : null;
      if (!toolName) return null;
      return {
        toolName,
        params: {
          symbols: ["AAPL", "MSFT", "NVDA"],
          start_date: "2023-01-01",
          end_date: "2024-12-31",
        },
      };
    }
    if (table === "factor_evaluation" || table === "quality:factor_ic_rankic") {
      const toolName = input.availableTools.includes("factor.autoEvaluate")
        ? "factor.autoEvaluate"
        : input.availableTools.includes("factor.evaluate")
          ? "factor.evaluate"
          : null;
      if (!toolName) return null;
      const factorId = latestFactorDefinitionId(input.sqlite, input.workflowId);
      if (!factorId) return null;
      return {
        toolName,
        params: {
          factor_id: factorId,
          start_date: "2023-01-01",
          end_date: "2024-12-31",
        },
      };
    }
  }
  return null;
}

function latestStrategyVersionId(sqlite: Database, workflowId: string): string | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT id AS id FROM strategy_version
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workflowId) as { id?: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function listActiveFactorIds(sqlite: Database, limit: number): string[] {
  try {
    const rows = sqlite
      .prepare(
        `SELECT id AS id FROM factor_definition
         WHERE coalesce(status, 'active') != 'archived'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{ id: string }>;
    return rows.map((row) => row.id).filter(Boolean);
  } catch {
    return [];
  }
}

function latestFactorDefinitionId(sqlite: Database, workflowId: string): string | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT id AS id FROM factor_definition
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workflowId) as { id?: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

function inferSymbolFromGoal(goal: string | null | undefined): string | null {
  if (!goal) return null;
  const match = goal.match(/\b([A-Z]{1,5})(?:\.[A-Z]{1,2})?\b/);
  if (!match) return null;
  const symbol = match[1]!;
  if (["US", "CN", "IC", "IR", "AI", "API", "GPU"].includes(symbol)) return null;
  return symbol;
}

function pickScreenerSymbol(sqlite: Database, workflowId: string): string | null {
  try {
    const row = sqlite
      .prepare(
        `SELECT sc.ticker AS ticker
         FROM screener_candidate sc
         JOIN screener_run sr ON sr.id = sc.screener_run_id
         WHERE sr.workflow_run_id = ?
         ORDER BY sc.score DESC
         LIMIT 1`
      )
      .get(workflowId) as { ticker?: string } | undefined;
    const ticker = (row?.ticker ?? "").trim().toUpperCase();
    return ticker || null;
  } catch {
    return null;
  }
}
