/**
 * P2-D：recommendAgentGroupForScope 纯函数单测。
 *
 * 评估报告核心痛点：默认全跑 10-agent 编组烧 token。这个推荐函数按 scope
 * 自动选最匹配的 4-8 agent 子集编组，按预估能省 30-60% token。测试覆盖：
 *
 *   1. explore + 关键词 → 6 个 M1 编组（含优先级冲突 case）
 *   2. sector → portfolio-management
 *   3. basket ≥5 → portfolio-management
 *   4. basket 2-4 → null（保持默认）
 *   5. single 1 → full-analyst-team
 *   6. option / 边角 → 安全降级
 *   7. available 列表注入（推荐 group 缺失时降级）
 */
import { describe, expect, test } from "bun:test";
import {
  recommendAgentGroupForScope,
  recommendAgentGroupIdForScope,
} from "../recommend-agent-group";
import { BUILTIN_AGENT_GROUPS } from "../../seed-agent-catalog";
import type { NormalizedResearchScope } from "../../../types/research-scope";

function scope(overrides: Partial<NormalizedResearchScope>): NormalizedResearchScope {
  return {
    kind: "single",
    symbols: ["AAPL"],
    primarySymbol: "AAPL",
    displayLabel: "AAPL",
    instrument: "equity",
    positionSide: "long",
    ...overrides,
  };
}

describe("recommendAgentGroupForScope — P2-D 自动编组推荐", () => {
  describe("explore.kind — 6 个关键词路由", () => {
    test("theme 含「因子」→ grp-factor-research", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "explore", theme: "动量因子挖掘" }));
      /** "挖掘" 关键词排在 "因子" 之前（更广义），所以走 discovery 而非 factor */
      expect(r.groupId).toBe("grp-discovery");
      expect(r.reason).toBe("explore_keyword_discovery");
    });

    test("theme 只含「因子」不含「挖掘」→ grp-factor-research", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "explore", theme: "动量 alpha 因子" }));
      expect(r.groupId).toBe("grp-factor-research");
      expect(r.reason).toBe("explore_keyword_factor");
      expect(r.feature).toMatch(/因子|alpha/);
    });

    test("theme 含「规则」→ grp-rule-research", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "explore", theme: "构造 RSI 规则" }));
      expect(r.groupId).toBe("grp-rule-research");
      expect(r.reason).toBe("explore_keyword_rule");
    });

    test("theme 含「选股」→ grp-stock-screening", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "explore", theme: "选股策略" }));
      expect(r.groupId).toBe("grp-stock-screening");
      expect(r.reason).toBe("explore_keyword_screening");
    });

    test("theme 含「复盘」→ grp-postmortem", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "explore", theme: "策略复盘归因" }));
      expect(r.groupId).toBe("grp-postmortem");
      expect(r.reason).toBe("explore_keyword_postmortem");
    });

    test("theme 含「事件」→ grp-news-event-radar", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "explore", theme: "earnings 事件雷达扫描" })
      );
      /** "雷达"+"事件"+"earnings" 都在 event_radar 关键词；按 EXPLORE_KEYWORD_RULES 顺序 */
      expect(r.groupId).toBe("grp-news-event-radar");
      expect(r.reason).toBe("explore_keyword_event_radar");
    });

    test("英文关键词 case-insensitive：FACTOR / Alpha → grp-factor-research", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "explore", theme: "FACTOR Mining Alpha" })
      );
      /** "mining"≠"挖掘"（不是同义关键词），所以走 factor 而不是 discovery */
      expect(r.groupId).toBe("grp-factor-research");
    });

    test("explore 但 theme/displayLabel 都无关键词 → null（保持默认）", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "explore", theme: "我想看看市场最近怎么样" })
      );
      expect(r.groupId).toBeNull();
      expect(r.reason).toBe("no_recommendation");
    });

    test("explore + displayLabel 也参与关键词匹配（theme 缺省）", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "explore", displayLabel: "factor library 浏览" })
      );
      expect(r.groupId).toBe("grp-factor-research");
    });

    test("sector 名字含 'factor' 但 kind=sector → 走 sector 分支而非 factor", () => {
      /** 反 pattern 守护：避免「AI 因子板块」被误路由到 factor-research */
      const r = recommendAgentGroupForScope(
        scope({ kind: "sector", sector: "AI 因子板块", displayLabel: "AI 因子板块" })
      );
      expect(r.groupId).toBe("grp-portfolio-management");
      expect(r.reason).toBe("scope_kind_sector");
    });
  });

  describe("sector / basket — 多标场景", () => {
    test("kind=sector → grp-portfolio-management", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "sector", sector: "半导体", symbols: ["NVDA", "AMD", "INTC"] })
      );
      expect(r.groupId).toBe("grp-portfolio-management");
      expect(r.reason).toBe("scope_kind_sector");
      expect(r.feature).toBe("半导体");
    });

    test("basket ≥5 → grp-portfolio-management", () => {
      const r = recommendAgentGroupForScope(
        scope({
          kind: "basket",
          symbols: ["AAPL", "MSFT", "NVDA", "GOOG", "META"],
          primarySymbol: "AAPL",
        })
      );
      expect(r.groupId).toBe("grp-portfolio-management");
      expect(r.reason).toBe("scope_basket_large");
      expect(r.feature).toBe("5");
    });

    test("basket 2-4 → null（保持默认 10-agent，避免误降级）", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "basket", symbols: ["AAPL", "MSFT"], primarySymbol: "AAPL" })
      );
      expect(r.groupId).toBeNull();
      expect(r.reason).toBe("no_recommendation");
    });
  });

  describe("single — 单标深度研究", () => {
    test("single + 1 symbol → grp-full-analyst-team", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "single", symbols: ["NVDA"] }));
      expect(r.groupId).toBe("grp-full-analyst-team");
      expect(r.reason).toBe("scope_single_consensus");
    });

    test("single + option 标的也归 single 路径", () => {
      const r = recommendAgentGroupForScope(
        scope({ kind: "single", symbols: ["NVDA"], instrument: "option" })
      );
      expect(r.groupId).toBe("grp-full-analyst-team");
    });

    test("single 但 symbols 异常为空 → 不命中 single 分支 → null", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "single", symbols: [], primarySymbol: "" }));
      expect(r.groupId).toBeNull();
      expect(r.reason).toBe("no_recommendation");
    });
  });

  describe("available 列表注入 — 测试 + 防御", () => {
    test("如果推荐 group 不在 available 列表 → 降级 null", () => {
      const onlyDefault = BUILTIN_AGENT_GROUPS.filter((g) => g.id === "grp-default-analyst-team");
      const r = recommendAgentGroupForScope(
        scope({ kind: "single", symbols: ["NVDA"] }),
        { available: onlyDefault }
      );
      expect(r.groupId).toBeNull();
      expect(r.humanText).toContain("缺失");
    });

    test("默认 available 即 BUILTIN_AGENT_GROUPS（12 个）", () => {
      const r = recommendAgentGroupForScope(scope({ kind: "single", symbols: ["NVDA"] }));
      expect(r.groupId).toBe("grp-full-analyst-team");
    });
  });

  describe("便利包装 recommendAgentGroupIdForScope", () => {
    test("返回纯 string | null，与完整版 reason 一致", () => {
      expect(recommendAgentGroupIdForScope(scope({ kind: "single", symbols: ["X"] }))).toBe(
        "grp-full-analyst-team"
      );
      expect(
        recommendAgentGroupIdForScope(scope({ kind: "basket", symbols: ["A", "B"] }))
      ).toBeNull();
    });
  });
});
