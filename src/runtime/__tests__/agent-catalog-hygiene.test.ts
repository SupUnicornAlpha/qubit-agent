/**
 * P2-E / P2-F 卫生单测：
 *
 *   P2-E：def-analyst-technical 不应再持有 run_backtest 工具授权
 *         （prompt 第 572 行明确写"信号 > 0.7 触发 backtest 外抛"——technical
 *         不亲自跑回测，保留 run_backtest 仅会让 LLM 误把 backtest 当成本
 *         角色职责吞掉一轮，token 浪费 + 与 backtest 角色重复）。
 *
 *   P2-F：所有 BuiltinAgentGroupSpec.memberRoles 不能再出现 RETIRED 名单里的 role。
 *         （历史 5 个 group 写的 risk_manager / stock_screener / audit /
 *         portfolio_manager / execution_trader 都是 M9.P5 退役但 catalog 滞后，
 *         前端选编组 UI 会显示根本没有对应 def 的 role 名，让用户困惑。）
 *
 *   同时校验 memberRoles 长度 == memberDefinitionIds 长度（一一对齐）。
 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_AGENT_GROUPS,
  type BuiltinAgentGroupSpec,
} from "../seed-agent-catalog";
import {
  SEED_AGENT_DEFINITIONS,
  RETIRED_BUILTIN_DEFINITION_IDS,
} from "../seed-agent-definitions-data";
import type { AgentRole } from "../../types/entities";

/**
 * 退役 role 名单（M9.P5 起从 catalog 中应清除；AgentRole type 联合仍保留
 * 是因为 sqlite check / migration 已固化，删 enum 值会破坏 schema）。
 * 与 RETIRED_BUILTIN_DEFINITION_IDS 对齐，去掉 backtest_engineer（被
 * def-walk-forward-validator 复用，是 active role）。
 */
const RETIRED_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  "researcher_bull",
  "researcher_bear",
  "risk_manager",
  "portfolio_manager",
  "stock_screener",
  "execution_trader",
  "memory_curator",
]);

describe("P2-E：analyst_technical × research × backtest 工具去重", () => {
  test("def-analyst-technical 不再持 run_backtest（外抛给 backtest 角色）", () => {
    const t = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-analyst-technical");
    expect(t).toBeTruthy();
    expect(t?.tools).not.toContain("run_backtest");
  });

  test("def-backtest 仍持 run_backtest（这才是它该亲自跑回测的地方）", () => {
    const b = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-backtest");
    expect(b).toBeTruthy();
    expect(b?.tools).toContain("run_backtest");
  });

  test("def-research 走的是 backtest.run（事件驱动），不持 run_backtest", () => {
    const r = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-research");
    expect(r).toBeTruthy();
    expect(r?.tools).toContain("backtest.run");
    /** research 用 M2/M6 事件驱动版，不用 connector 那个 run_backtest */
    expect(r?.tools).not.toContain("run_backtest");
  });
});

describe("P2-F：BuiltinAgentGroupSpec 卫生", () => {
  for (const g of BUILTIN_AGENT_GROUPS) {
    describe(`${g.id} (${g.name})`, () => {
      test("memberRoles 不出现退役 role", () => {
        const retired = g.memberRoles.filter((r) => RETIRED_ROLES.has(r));
        expect(retired).toEqual([]);
      });

      test("memberRoles 长度 == memberDefinitionIds 长度", () => {
        expect(g.memberRoles.length).toBe(g.memberDefinitionIds.length);
      });

      test("memberDefinitionIds 都在 SEED_AGENT_DEFINITIONS 且非退役", () => {
        const seeded = new Set(SEED_AGENT_DEFINITIONS.map((d) => d.id));
        const retired = new Set(RETIRED_BUILTIN_DEFINITION_IDS);
        for (const id of g.memberDefinitionIds) {
          expect(seeded.has(id)).toBe(true);
          expect(retired.has(id as (typeof RETIRED_BUILTIN_DEFINITION_IDS)[number])).toBe(false);
        }
      });
    });
  }

  test("整体：所有 group 的 memberRoles 并集都属于活跃 role", () => {
    const activeRoles = new Set(SEED_AGENT_DEFINITIONS.map((d) => d.role));
    const allRoles = new Set<AgentRole>();
    for (const g of BUILTIN_AGENT_GROUPS) {
      for (const r of g.memberRoles) allRoles.add(r);
    }
    const invalid = Array.from(allRoles).filter((r) => !activeRoles.has(r));
    expect(invalid).toEqual([]);
  });
});

describe("P2-F：稳定 type 检查（防回退）", () => {
  test("BuiltinAgentGroupSpec 仍是 readonly 接口（type guard）", () => {
    const sample: BuiltinAgentGroupSpec = BUILTIN_AGENT_GROUPS[0]!;
    expect(typeof sample.id).toBe("string");
    expect(Array.isArray(sample.memberRoles)).toBe(true);
  });
});

/**
 * Migration 0073 卫生测试（防"哪些 role 做什么"再次硬编码进 dispatcher）。
 *
 * 触发场景（2026-06 评估批次实测）：
 *   - case 5 (event-radar) news_event 在 memberRoles 里、但 dispatcher 用
 *     `isMsAnalystRole` 过滤把它丢了，attendedRoles=[] / signals=0；
 *   - case 4 (discovery) 同理 backtest_engineer 被丢。
 *
 * 修复路径：
 *   - `agent_group.pipeline_kind` 决定编组 dispatch 模式（msa_fusion / sequential_research / ...）；
 *   - `agent_definition.outputs` 决定角色产出能力（signal / report / events / ...）；
 *   - Dispatcher 按 outputs 分桶（而非按 role 名硬编码 set），按 pipelineKind 路由。
 *
 * 本测试只校验 declarative 数据完整性，不校验 dispatcher 行为（dispatcher 重构
 * 在 Phase B 单独验证）。
 */
describe("P0-01 / P1-04：pipeline_kind + outputs 卫生（migration 0073）", () => {
  const VALID_PIPELINES = new Set([
    "msa_fusion",
    "sequential_research",
    "event_radar",
    "factor_discovery",
  ]);
  const VALID_OUTPUTS = new Set([
    "signal",
    "report",
    "events",
    "factor_candidates",
    "strategy_dsl",
    "backtest_results",
    "risk_assessment",
  ]);

  for (const g of BUILTIN_AGENT_GROUPS) {
    test(`group ${g.id} 必须声明合法 pipelineKind`, () => {
      expect(typeof g.pipelineKind).toBe("string");
      expect(VALID_PIPELINES.has(g.pipelineKind)).toBe(true);
    });
  }

  for (const d of SEED_AGENT_DEFINITIONS) {
    test(`def ${d.id} outputs 必须是合法 AgentOutput 数组`, () => {
      expect(Array.isArray(d.outputs)).toBe(true);
      for (const o of d.outputs ?? []) {
        expect(VALID_OUTPUTS.has(o)).toBe(true);
      }
    });
  }

  test("event_radar 编组必须至少有一个角色产出 'events'（否则该模式无意义）", () => {
    for (const g of BUILTIN_AGENT_GROUPS.filter((x) => x.pipelineKind === "event_radar")) {
      const memberDefs = SEED_AGENT_DEFINITIONS.filter((d) =>
        g.memberDefinitionIds.includes(d.id)
      );
      const hasEvents = memberDefs.some((d) => (d.outputs ?? []).includes("events"));
      if (!hasEvents) {
        throw new Error(`${g.id} pipelineKind=event_radar 但成员无人产出 events`);
      }
    }
  });

  test("factor_discovery 编组必须至少有 'factor_candidates' + 'backtest_results' 各一个", () => {
    for (const g of BUILTIN_AGENT_GROUPS.filter((x) => x.pipelineKind === "factor_discovery")) {
      const memberDefs = SEED_AGENT_DEFINITIONS.filter((d) =>
        g.memberDefinitionIds.includes(d.id)
      );
      const hasFactor = memberDefs.some((d) =>
        (d.outputs ?? []).includes("factor_candidates")
      );
      const hasBacktest = memberDefs.some((d) =>
        (d.outputs ?? []).includes("backtest_results")
      );
      if (!hasFactor || !hasBacktest) {
        throw new Error(
          `${g.id} pipelineKind=factor_discovery 但成员缺 factor_candidates=${hasFactor} / backtest_results=${hasBacktest}`
        );
      }
    }
  });

  test("msa_fusion 编组必须至少有 2 个 signal 产出者（否则无投票意义）", () => {
    for (const g of BUILTIN_AGENT_GROUPS.filter((x) => x.pipelineKind === "msa_fusion")) {
      const memberDefs = SEED_AGENT_DEFINITIONS.filter((d) =>
        g.memberDefinitionIds.includes(d.id)
      );
      const signalCount = memberDefs.filter((d) =>
        (d.outputs ?? []).includes("signal")
      ).length;
      if (signalCount < 2) {
        throw new Error(
          `${g.id} pipelineKind=msa_fusion 但仅 ${signalCount} 个 signal 产出者（需 ≥2）`
        );
      }
    }
  });
});
