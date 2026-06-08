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
    goalKeywords: ["美股", "宏观", "见解"],
    consistencyChecks: [
      {
        name: "fusion ↔ signal",
        description: "signal_fusion_result.ticker 应有至少一条对应的 analyst_signal",
        kind: "fusion_signal_refs",
      },
    ],
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
    ],
    requiredTools: ["screener"],
    goalKeywords: ["momentum", "估值", "新闻"],
    consistencyChecks: [],
  },

  factor: {
    scenario: "factor",
    requiredArtifacts: [
      {
        table: "factor_definition",
        countSql: `
          SELECT COUNT(*) AS c
          FROM factor_definition
          WHERE id IN (
            SELECT factor_id FROM factor_evaluation fe
            WHERE fe.factor_id IN (
              SELECT fd.id FROM factor_definition fd
              WHERE fd.id IN (SELECT id FROM factor_definition)
            )
          )`,
        minRows: 1,
        nonNullColumns: ["expr"],
      },
      {
        table: "factor_evaluation",
        countSql: `SELECT COUNT(*) AS c FROM factor_evaluation WHERE ic IS NOT NULL`,
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

  live_trading: {
    scenario: "live_trading",
    requiredArtifacts: [
      {
        table: "order_intent",
        countSql: `SELECT COUNT(*) AS c FROM order_intent WHERE workflow_run_id = ?`,
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
    goalKeywords: ["策略", "订单", "风控"],
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
