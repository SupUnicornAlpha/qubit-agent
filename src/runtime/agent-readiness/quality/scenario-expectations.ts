/**
 * 五场景的"期望"配置：A-1 / A-2 / A-4 / B-1 都依赖这份配置。
 *
 * 设计取舍：
 *   - 单一来源：每场景一份 expectation，A/B 类指标共享，避免在多个文件里维护"研究场景应该有 quote 工具"。
 *   - 数据驱动：如果将来场景增加，只需要改这里，不需要碰指标实现。
 *   - 不写死 ticker：goal 里出现的 "AAPL" / "美股" 之类关键词通过 keyword 集合匹配，避免硬编码。
 */
import type { ScenarioRecipe } from "../scenarios";

export interface ArtifactExpectation {
  /** 该 SQL 表名，用于错误信息渲染 */
  table: string;
  /** 用 (sqlite, workflowRunId) → count 抓本 workflow 该产物的数量 */
  countSql: string;
  /** 最低条数（含），低于此即视为"未产出" */
  minRows: number;
  /** 可选：必填字段（落表非空才算"实质产出"）；nullable → 单条命中即可 */
  nonNullColumns?: string[];
}

export interface ScenarioExpectation {
  scenario: ScenarioRecipe["key"];
  /** 必备产物表（A-1） */
  requiredArtifacts: ArtifactExpectation[];
  /** 效果质量门：比“已落库”更进一步，要求关键结果可验证 */
  qualityGates?: ArtifactExpectation[];
  /** 必备工具集合（B-1）：按 toolName / 前缀匹配 */
  requiredTools: ReadonlyArray<string>;
  /**
   * goal 关键词（A-2）：用来检查产物字段是否提到这些词。
   * 只是 sanity 检查，不要过度严格——否则 LLM 没说出某个 sector 就被扣分。
   */
  goalKeywords: ReadonlyArray<string>;
  /** A-4 内部一致性的引用规则集 */
  consistencyChecks: ReadonlyArray<ConsistencyCheck>;
}

/**
 * 内部一致性检查 spec：每条规则描述一组"引用"关系，
 * 例如 strategy_composition.factorIdsJson 里的每个 id 都应该在 factor_definition 中存在。
 *
 * 实现层用 (sqlite, workflowRunId) → { totalRefs, brokenRefs }，
 * grader 取 brokenRefs/totalRefs 作为破坏率。
 */
export interface ConsistencyCheck {
  name: string;
  description: string;
  /** 返回 (totalRefs, brokenRefs) 的 SQL 查询；具体实现走 content-quality.ts */
  kind:
    | "strategy_factor_refs"
    | "order_strategy_refs"
    | "fusion_signal_refs";
}

export const SCENARIO_EXPECTATIONS: Record<ScenarioRecipe["key"], ScenarioExpectation> = {
  research: {
    scenario: "research",
    requiredArtifacts: [
      {
        table: "analyst_signal",
        countSql: `SELECT COUNT(*) AS c FROM analyst_signal WHERE workflow_run_id = ?`,
        minRows: 2,
        nonNullColumns: ["reasoning", "ticker"],
      },
      {
        table: "signal_fusion_result",
        countSql: `SELECT COUNT(*) AS c FROM signal_fusion_result WHERE workflow_run_id = ?`,
        minRows: 1,
      },
    ],
    requiredTools: [
      // 研究场景至少要拿过价格 + 看过新闻/财报；用前缀匹配以兼容多 MCP 实现
      "get_quote",
      "news",
    ],
    goalKeywords: ["AAPL", "估值", "见解"],
    consistencyChecks: [
      {
        name: "fusion ↔ signal",
        description: "signal_fusion_result.ticker 应有至少一条对应的 analyst_signal",
        kind: "fusion_signal_refs",
      },
    ],
  },

  research_multi: {
    scenario: "research_multi",
    requiredArtifacts: [
      {
        table: "analyst_signal",
        // 多标的对比要求 ≥3 条 signal 且至少覆盖 2 个不同 ticker
        countSql: `SELECT COUNT(*) AS c FROM analyst_signal WHERE workflow_run_id = ?`,
        minRows: 3,
        nonNullColumns: ["reasoning", "ticker"],
      },
      {
        table: "analyst_signal_distinct_tickers",
        countSql: `SELECT COUNT(DISTINCT ticker) AS c FROM analyst_signal WHERE workflow_run_id = ?`,
        minRows: 2,
      },
      {
        table: "signal_fusion_result",
        countSql: `SELECT COUNT(*) AS c FROM signal_fusion_result WHERE workflow_run_id = ?`,
        minRows: 1,
      },
    ],
    requiredTools: ["get_quote", "news"],
    goalKeywords: ["NVDA", "AMD", "对比"],
    consistencyChecks: [
      {
        name: "fusion ↔ signal",
        description: "signal_fusion_result.ticker 应有至少一条对应的 analyst_signal",
        kind: "fusion_signal_refs",
      },
    ],
  },

  research_theme: {
    scenario: "research_theme",
    requiredArtifacts: [
      {
        table: "analyst_signal",
        countSql: `SELECT COUNT(*) AS c FROM analyst_signal WHERE workflow_run_id = ?`,
        minRows: 3,
        nonNullColumns: ["reasoning", "ticker"],
      },
      {
        table: "analyst_signal_distinct_tickers",
        countSql: `SELECT COUNT(DISTINCT ticker) AS c FROM analyst_signal WHERE workflow_run_id = ?`,
        minRows: 3,
      },
    ],
    requiredTools: ["screener", "get_quote", "news"],
    goalKeywords: ["AI", "算力", "细分"],
    consistencyChecks: [],
  },

  stock_pick: {
    scenario: "stock_pick",
    requiredArtifacts: [
      {
        table: "screener_candidate",
        countSql: `
          SELECT COUNT(*) AS c
          FROM screener_candidate
          WHERE screener_run_id IN (
            SELECT id FROM screener_run WHERE workflow_run_id = ?
          )`,
        minRows: 3,
        nonNullColumns: ["ticker", "score"],
      },
      {
        table: "recommendation_snapshot",
        countSql: `
          SELECT COUNT(*) AS c
          FROM recommendation_snapshot
          WHERE workflow_run_id = ?
            AND side = 'long'`,
        minRows: 3,
        nonNullColumns: ["symbol", "rationale"],
      },
    ],
    requiredTools: ["screener", "recommendation.record"],
    goalKeywords: ["momentum", "估值", "新闻"],
    consistencyChecks: [],
  },

  stock_pick_short: {
    scenario: "stock_pick_short",
    requiredArtifacts: [
      {
        table: "screener_candidate",
        countSql: `
          SELECT COUNT(*) AS c
          FROM screener_candidate
          WHERE screener_run_id IN (
            SELECT id FROM screener_run WHERE workflow_run_id = ?
          )`,
        minRows: 2,
        nonNullColumns: ["ticker", "score"],
      },
      {
        table: "recommendation_snapshot",
        countSql: `
          SELECT COUNT(*) AS c
          FROM recommendation_snapshot
          WHERE workflow_run_id = ?
            AND side = 'short'`,
        minRows: 2,
        nonNullColumns: ["symbol", "rationale"],
      },
    ],
    requiredTools: ["screener", "recommendation.record"],
    // 做空场景：关键词命中是给 A-2（内容相关性）打分用，要求产物文本里出现
    // 做空 / 估值 / 风险等词，A-3 由 LLM-Judge 进一步打专业度分。
    goalKeywords: ["做空", "估值", "风险"],
    consistencyChecks: [],
  },

  factor: {
    scenario: "factor",
    /**
     * Round 8 复盘（2026-06-08）：原 SQL 写成三层嵌套 IN 且没用 `?` 占位符，
     * artifact-checker / content-quality 用 `sqlite.prepare(sql).get(workflowRunId)`
     * 时多余参数被静默忽略，SQL 在全库范围跑 → 历史 round 留下的旧因子都进了 count
     * → A-1 永远 = 1 误判"有产出"，与 UI 研究产出 tab 实际为空形成假阳性。
     *
     * 现修为严格按 workflow_run_id 过滤；factor_evaluation 没有 workflow_run_id
     * 列，通过 factor_id JOIN 到 factor_definition 反查本 workflow 内的评估。
     */
    requiredArtifacts: [
      {
        table: "factor_definition",
        countSql: `SELECT COUNT(*) AS c FROM factor_definition WHERE workflow_run_id = ?`,
        minRows: 1,
        nonNullColumns: ["expr"],
      },
      {
        table: "factor_evaluation",
        countSql: `
          SELECT COUNT(*) AS c FROM factor_evaluation fe
          WHERE fe.ic IS NOT NULL
            AND fe.factor_id IN (
              SELECT id FROM factor_definition WHERE workflow_run_id = ?
            )`,
        minRows: 1,
      },
    ],
    qualityGates: [
      {
        table: "quality:factor_ic_rankic",
        countSql: `
          SELECT COUNT(*) AS c FROM factor_evaluation fe
          WHERE (
              (fe.ic IS NOT NULL AND ABS(fe.ic) >= 0.03)
              OR (fe.rank_ic IS NOT NULL AND ABS(fe.rank_ic) >= 0.03)
            )
            AND fe.factor_id IN (
              SELECT id FROM factor_definition WHERE workflow_run_id = ?
            )`,
        minRows: 1,
      },
    ],
    requiredTools: ["factor"],
    goalKeywords: ["因子", "alpha", "IC"],
    consistencyChecks: [],
  },

  strategy: {
    scenario: "strategy",
    requiredArtifacts: [
      {
        table: "strategy_version",
        countSql: `SELECT COUNT(*) AS c FROM strategy_version WHERE workflow_run_id = ?`,
        minRows: 1,
      },
      {
        table: "strategy_composition",
        countSql: `
          SELECT COUNT(*) AS c
          FROM strategy_composition
          WHERE strategy_version_id IN (
            SELECT id FROM strategy_version WHERE workflow_run_id = ?
          )
            AND factor_ids_json != '[]'`,
        minRows: 1,
      },
    ],
    qualityGates: [
      {
        table: "quality:strategy_backtest_completed",
        countSql: `
          SELECT COUNT(*) AS c
          FROM backtest_run
          WHERE workflow_run_id = ?
            AND status = 'completed'
            AND performance_json IS NOT NULL`,
        minRows: 1,
      },
    ],
    requiredTools: ["strategy"],
    goalKeywords: ["因子", "策略", "持仓"],
    consistencyChecks: [
      {
        name: "strategy → factor refs",
        description: "strategy_composition.factorIdsJson 中的每个 id 都应在 factor_definition 中存在",
        kind: "strategy_factor_refs",
      },
    ],
  },

  strategy_long_short: {
    scenario: "strategy_long_short",
    requiredArtifacts: [
      {
        table: "strategy_version",
        countSql: `SELECT COUNT(*) AS c FROM strategy_version WHERE workflow_run_id = ?`,
        minRows: 1,
      },
      {
        table: "strategy_composition",
        countSql: `
          SELECT COUNT(*) AS c
          FROM strategy_composition
          WHERE strategy_version_id IN (
            SELECT id FROM strategy_version WHERE workflow_run_id = ?
          )
            AND factor_ids_json != '[]'`,
        minRows: 1,
      },
    ],
    qualityGates: [
      {
        table: "quality:strategy_backtest_completed",
        countSql: `
          SELECT COUNT(*) AS c
          FROM backtest_run
          WHERE workflow_run_id = ?
            AND status = 'completed'
            AND performance_json IS NOT NULL`,
        minRows: 1,
      },
    ],
    requiredTools: ["strategy"],
    // 多空配对场景：description 应同时出现 long / short / pair / 配对 关键词
    goalKeywords: ["long", "short", "配对"],
    consistencyChecks: [
      {
        name: "strategy → factor refs",
        description:
          "strategy_composition.factorIdsJson 中的每个 id 都应在 factor_definition 中存在",
        kind: "strategy_factor_refs",
      },
    ],
  },

  live_trading: {
    scenario: "live_trading",
    requiredArtifacts: [
      {
        table: "order_intent",
        countSql: `SELECT COUNT(*) AS c FROM order_intent WHERE workflow_run_id = ? AND side = 'buy'`,
        minRows: 1,
      },
      {
        table: "risk_decision",
        countSql: `
          SELECT COUNT(*) AS c
          FROM risk_decision
          WHERE order_intent_id IN (
            SELECT id FROM order_intent WHERE workflow_run_id = ?
          )`,
        minRows: 1,
      },
    ],
    requiredTools: ["order", "risk"],
    goalKeywords: ["做多", "订单", "风控"],
    consistencyChecks: [
      {
        name: "order → strategy_version",
        description: "order_intent.strategy_version_id 必须能在 strategy_version 找到",
        kind: "order_strategy_refs",
      },
    ],
  },

  live_trading_short: {
    scenario: "live_trading_short",
    requiredArtifacts: [
      {
        table: "order_intent",
        // 做空场景：必须有 side='sell' 的 order_intent（做空通过 sell 表达，
        // 真正"开空"vs"平多"语义由 strategy_version 上下文决定）
        countSql: `SELECT COUNT(*) AS c FROM order_intent WHERE workflow_run_id = ? AND side = 'sell'`,
        minRows: 1,
      },
      {
        table: "risk_decision",
        countSql: `
          SELECT COUNT(*) AS c
          FROM risk_decision
          WHERE order_intent_id IN (
            SELECT id FROM order_intent WHERE workflow_run_id = ?
          )`,
        minRows: 1,
      },
    ],
    requiredTools: ["order", "risk"],
    goalKeywords: ["做空", "保证金", "风控"],
    consistencyChecks: [
      {
        name: "order → strategy_version",
        description: "order_intent.strategy_version_id 必须能在 strategy_version 找到",
        kind: "order_strategy_refs",
      },
    ],
  },
};

/** 取场景 expectation；未知场景抛错（避免静默 0 分） */
export function getScenarioExpectation(
  scenario: ScenarioRecipe["key"]
): ScenarioExpectation {
  const exp = SCENARIO_EXPECTATIONS[scenario];
  if (!exp) {
    throw new Error(`[scenario-expectations] unknown scenario: ${scenario}`);
  }
  return exp;
}
