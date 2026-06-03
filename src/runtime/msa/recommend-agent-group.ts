/**
 * P2-D：按 NormalizedResearchScope 自动推荐 BuiltinAgentGroup。
 *
 * 评估报告原话："仓库里没有任何 recommendAgentGroupFor / suggestAgentGroup 之类
 * helper，前端空串提交 → 后端取所有 enabled 的 9 个 slot role 全跑，对 scope/
 * instrument 完全无感。" —— 也就是说不管用户问的是单股 NVDA 还是「挖一下动量
 * 因子」还是「看一下 AI 板块复盘」，全都跑 10-agent 默认大编组，每次烧 token。
 *
 * 这个模块是**纯函数 + 零依赖**：不查 DB、不读 env、不抛错；env flag 由调用方判断。
 * 这样测试只要喂 scope + 可选 available 列表，结果完全 deterministic。
 *
 * 匹配优先级（短路）：
 *   1. explore + theme/displayLabel 命中关键词 → 对应 9 个 M1 编组
 *   2. sector / 多标的 (≥5) → portfolio-management（多策略权重）
 *   3. single + symbols.length === 1 → full-analyst-team（先共识，不进策略链）
 *   4. 其它（含 basket 2-4 / option / explore 无关键词）→ null（保持现状默认）
 *
 * 不会"硬"路由到 default-analyst-team / strategy-pipeline：
 *   - default 是 fallback，前端空 → 现行就是它，不需要推荐函数主动选
 *   - strategy-pipeline 是「已经有研究结论」的下游；用户应显式选，不应自动猜
 */
import type { NormalizedResearchScope } from "../../types/research-scope";
import { BUILTIN_AGENT_GROUPS, type BuiltinAgentGroupSpec } from "../seed-agent-catalog";

export type GroupRecommendationReason =
  | "explore_keyword_factor"
  | "explore_keyword_rule"
  | "explore_keyword_discovery"
  | "explore_keyword_screening"
  | "explore_keyword_postmortem"
  | "explore_keyword_event_radar"
  | "scope_kind_sector"
  | "scope_basket_large"
  | "scope_single_consensus"
  | "no_recommendation";

export interface GroupRecommendation {
  /** null 表示「无明确推荐」，调用方应保持现状（不写 agent_group_id） */
  groupId: string | null;
  reason: GroupRecommendationReason;
  /** 给监控 / 日志 / HITL 提示的人话说明，比 reason 友好 */
  humanText: string;
  /**
   * 命中的"特征值"，便于审计为什么走这一支：
   *   - explore_keyword_*：命中的关键词
   *   - scope_*：触发数值（如 symbols.length）
   */
  feature?: string;
}

export interface RecommendAgentGroupOptions {
  /** 注入子集便于测试；默认 BUILTIN_AGENT_GROUPS（含 12 个内置） */
  available?: readonly BuiltinAgentGroupSpec[];
}

/**
 * explore.kind 下按 theme/displayLabel 关键词路由的优先表。
 * 顺序敏感：先匹先赢（因为同一个 query 可能既含"因子"又含"挖掘"，按 P2-D 设计
 * "挖掘"覆盖更广 → 排在"因子"之前）。
 */
const EXPLORE_KEYWORD_RULES: ReadonlyArray<{
  groupId: string;
  reason: GroupRecommendationReason;
  /** 命中任一关键词即触发 */
  keywords: ReadonlyArray<string>;
  humanText: string;
}> = [
  {
    groupId: "grp-discovery",
    reason: "explore_keyword_discovery",
    keywords: ["挖掘", "discover", "gene pool", "演化", "automl", "进化"],
    humanText: "因子/规则/策略挖掘场景（自动跑 walk-forward 验证）",
  },
  {
    groupId: "grp-postmortem",
    reason: "explore_keyword_postmortem",
    keywords: ["复盘", "归因", "postmortem", "回顾", "attribution"],
    humanText: "复盘归因场景（research + analyst_macro）",
  },
  {
    groupId: "grp-news-event-radar",
    reason: "explore_keyword_event_radar",
    keywords: ["事件", "催化剂", "earnings", "财报", "刘易斯", "雷达", "event"],
    humanText: "事件雷达场景（news_event + analyst_sentiment）",
  },
  {
    groupId: "grp-stock-screening",
    reason: "explore_keyword_screening",
    keywords: ["选股", "screen", "筛选", "扫描", "screening", "universe"],
    humanText: "选股场景（research + fundamental + sentiment）",
  },
  {
    groupId: "grp-factor-research",
    reason: "explore_keyword_factor",
    keywords: ["因子", "factor", "alpha", "rankic", "ic"],
    humanText: "因子研究场景（research + fundamental + technical）",
  },
  {
    groupId: "grp-rule-research",
    reason: "explore_keyword_rule",
    keywords: ["规则", "rule", "dsl", "信号规则"],
    humanText: "规则研究场景（research + risk，产出 JSON-DSL 规则）",
  },
];

/**
 * 把 scope 的 theme + displayLabel 拼成小写字符串，给关键词匹配用。
 * 不包含 primarySymbol/symbols（避免「sector="AI 因子板块"」时被「factor」碰倒
 * 反而把 sector 误路由到 factor-research）。
 */
function buildKeywordHaystack(scope: NormalizedResearchScope): string {
  const parts = [scope.theme ?? "", scope.displayLabel ?? ""];
  return parts.join(" ").toLowerCase();
}

export function recommendAgentGroupForScope(
  scope: NormalizedResearchScope,
  options: RecommendAgentGroupOptions = {}
): GroupRecommendation {
  const available = options.available ?? BUILTIN_AGENT_GROUPS;
  const availableIds = new Set(available.map((g) => g.id));

  /** 内联校验：被推荐的 group 必须真存在于 available；否则降级 fallback */
  const safe = (
    groupId: string,
    reason: GroupRecommendationReason,
    humanText: string,
    feature?: string
  ): GroupRecommendation => {
    if (!availableIds.has(groupId)) {
      return {
        groupId: null,
        reason: "no_recommendation",
        humanText: `推荐 ${groupId} 但在 available 列表中缺失，降级 fallback`,
      };
    }
    return feature !== undefined
      ? { groupId, reason, humanText, feature }
      : { groupId, reason, humanText };
  };

  /** 1) explore.kind：按关键词路由（顺序敏感） */
  if (scope.kind === "explore") {
    const haystack = buildKeywordHaystack(scope);
    for (const rule of EXPLORE_KEYWORD_RULES) {
      for (const kw of rule.keywords) {
        if (haystack.includes(kw.toLowerCase())) {
          return safe(rule.groupId, rule.reason, rule.humanText, kw);
        }
      }
    }
    /** explore 但无关键词 → 不强推荐，保持现状默认 */
    return {
      groupId: null,
      reason: "no_recommendation",
      humanText: "explore 模式但 theme/displayLabel 未命中任何关键词，保持默认全栈编组",
    };
  }

  /** 2) sector 整板块 → PM 组合管理（多策略 / 权重分配视角） */
  if (scope.kind === "sector") {
    return safe(
      "grp-portfolio-management",
      "scope_kind_sector",
      "板块研究场景（PM 组合管理：research + risk + backtest）",
      scope.sector ?? scope.displayLabel
    );
  }

  /** 3) basket 多标的（≥5）→ 也走 PM 组合管理 */
  if (scope.kind === "basket" && scope.symbols.length >= 5) {
    return safe(
      "grp-portfolio-management",
      "scope_basket_large",
      `${scope.symbols.length} 个标的组合场景（PM 组合管理）`,
      String(scope.symbols.length)
    );
  }

  /** 4) single 单标 → full-analyst-team（先 MSA 共识，避免直接烧 10 agent + 策略链） */
  if (scope.kind === "single" && scope.symbols.length === 1) {
    return safe(
      "grp-full-analyst-team",
      "scope_single_consensus",
      "单标深度研究（全分析师 MSA + 辩论，不进策略链）",
      scope.primarySymbol || scope.symbols[0]
    );
  }

  /** 其它：basket 2-4 / option / 边角情况 → 保持现状默认（10-agent fallback） */
  return {
    groupId: null,
    reason: "no_recommendation",
    humanText: `scope.kind=${scope.kind} symbols=${scope.symbols.length}，无明确编组推荐`,
  };
}

/**
 * 调用方便利：直接拿到 groupId 字符串或 null。
 * 内部仍调 `recommendAgentGroupForScope`；保留单独 export 是为了让 analyst-team
 * 集成点更短小（一行 reassign）。
 */
export function recommendAgentGroupIdForScope(
  scope: NormalizedResearchScope,
  options: RecommendAgentGroupOptions = {}
): string | null {
  return recommendAgentGroupForScope(scope, options).groupId;
}
