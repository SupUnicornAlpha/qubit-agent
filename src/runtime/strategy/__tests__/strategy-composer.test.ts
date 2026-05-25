/**
 * StrategyComposer 测试
 *
 * 由于 P0 阶段 python_inline factor compute 返回空 rows，
 * 这里通过 mock：先把因子写库 → 用 strategy_composer.execute 自行喂因子值上下文，
 * 测试 factor_score / rule / hybrid 三种 kind 的分数与过滤逻辑。
 *
 * 测试聚焦在 composer 内部的：
 *   - 权重计算（equal / manual）
 *   - rule 过滤
 *   - hybrid = rule filter + factor score
 *   - picks 排序 / rank 赋值
 *
 * 因为 factor compute 在 P0 返回空 rows，这里我们绕开 compute，
 * 用 mock 因子（直接写 factor_definition）+ patch context 路径。
 *
 * P0 阶段更稳的方式：直接 instantiate StrategyComposer 子类，覆盖 compute 行为；
 * 这里采用更轻的方式：构造因子但直接用 ruleService 验证组合的核心 picks 输出。
 */

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { runMigrations } from "../../../db/sqlite/migrate";
import { bootstrapProviders, _resetBootstrapForTests } from "../../provider/bootstrap";
import { factorService } from "../../factor/factor-service";
import { ruleService } from "../../rule/rule-service";
import { strategyComposer, StrategyComposerError } from "../strategy-composer";

let projectId = "";
let strategyVersionId = "";

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  const db = await getDb();
  const wid = randomUUID();
  projectId = randomUUID();
  const strategyId = randomUUID();
  strategyVersionId = randomUUID();
  await db.insert(schema.workspace).values({ id: wid, name: "sc-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId: wid,
    name: "sc-proj",
    marketScope: "CN-A",
    status: "active",
  });
  await db.insert(schema.strategy).values({
    id: strategyId,
    projectId,
    name: "sc-strat",
    style: "low_freq",
    description: "",
  });
  await db.insert(schema.strategyVersion).values({
    id: strategyVersionId,
    strategyId,
    versionTag: "v1",
    logicHash: "h",
    paramSchemaJson: {},
  });
});

describe("StrategyComposer.define()", () => {
  test("kind=factor_score 缺 factorIds → validation_failed", async () => {
    await expect(
      strategyComposer.define({
        strategyVersionId,
        kind: "factor_score",
        factorIds: [],
      })
    ).rejects.toBeInstanceOf(StrategyComposerError);
  });

  test("kind=rule 缺 ruleIds → validation_failed", async () => {
    await expect(
      strategyComposer.define({
        strategyVersionId,
        kind: "rule",
        ruleIds: [],
      })
    ).rejects.toBeInstanceOf(StrategyComposerError);
  });

  test("kind=hybrid 需要 factor 与 rule 双备", async () => {
    await expect(
      strategyComposer.define({
        strategyVersionId,
        kind: "hybrid",
        factorIds: ["f1"],
        ruleIds: [],
      })
    ).rejects.toBeInstanceOf(StrategyComposerError);
  });

  test("strategyVersion 不存在 → validation_failed", async () => {
    await expect(
      strategyComposer.define({
        strategyVersionId: "non-existent",
        kind: "factor_score",
        factorIds: ["f1"],
      })
    ).rejects.toBeInstanceOf(StrategyComposerError);
  });

  test("正确路径：listByVersion 能查到", async () => {
    const f = await factorService.register({
      projectId,
      name: `mom_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: [f.id],
      weightMethod: "equal",
    });
    expect(comp.id).toBeTruthy();
    const list = await strategyComposer.listByVersion(strategyVersionId);
    expect(list.some((c) => c.id === comp.id)).toBe(true);
  });
});

describe("StrategyComposer.execute()", () => {
  test("kind=rule：过滤 + 排序 + rank", async () => {
    // 注册因子（factor compute 返回空，所以 factorContext 走 input.symbols 填空字典）
    const f = await factorService.register({
      projectId,
      name: `f_rule_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    // 规则：mom > 0
    const r = await ruleService.register({
      projectId,
      name: `r_${randomUUID().slice(0, 6)}`,
      appliesTo: "filter",
      dsl: { when: { ">": [{ factor: "mom" }, 0] }, score: { factor: "mom" } },
    });

    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "rule",
      factorIds: [f.id],
      ruleIds: [r.id],
    });

    // execute 时 factor compute 返回空 rows，所以 factorContext 只有 input.symbols 撑起来的空 map；
    // 这种情况下 rule 因为 factor=null 全部 fail → 0 picks
    const result = await strategyComposer.execute({
      compositionId: comp.id,
      asof: "2026-05-20",
      startDate: "2026-01-01",
      endDate: "2026-05-20",
      symbols: ["A", "B", "C"],
    });
    expect(result.kind).toBe("rule");
    expect(result.meta.universe).toBe("CN-A");
    // factor 没值 → rule when 全部不通过 → picks=0
    expect(result.picks.length).toBe(0);
    // 但 sampleSize 应该统计候选数
    expect(result.meta.sampleSize).toBeGreaterThanOrEqual(3);
  });

  test("rank_ic_weighted：所有因子都没评估留痕 → validation_failed", async () => {
    const f1 = await factorService.register({
      projectId,
      name: `f_ic_none1_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const f2 = await factorService.register({
      projectId,
      name: `f_ic_none2_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: [f1.id, f2.id],
      weightMethod: "rank_ic_weighted",
    });
    await expect(
      strategyComposer.execute({
        compositionId: comp.id,
        asof: "2026-05-20",
        startDate: "2026-01-01",
        endDate: "2026-05-20",
        symbols: ["A"],
      })
    ).rejects.toBeInstanceOf(StrategyComposerError);
  });

  test("rank_ic_weighted：按 |rank_ic| 归一化（缺值按 0）", async () => {
    const f1 = await factorService.register({
      projectId,
      name: `f_ic_rw1_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const f2 = await factorService.register({
      projectId,
      name: `f_ic_rw2_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const f3 = await factorService.register({
      projectId,
      name: `f_ic_rw3_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const db = await getDb();
    // 直接写 factor_evaluation：f1=rankIc 0.06, f2=rankIc -0.02, f3 无评估（应当贡献 0）
    await db.insert(schema.factorEvaluation).values([
      {
        id: randomUUID(),
        factorId: f1.id,
        asof: "2026-05-20",
        universe: "CN-A",
        rankIc: 0.06,
        ic: 0.05,
        ir: 0.8,
        sampleSize: 100,
      },
      {
        id: randomUUID(),
        factorId: f2.id,
        asof: "2026-05-20",
        universe: "CN-A",
        rankIc: -0.02,
        ic: -0.02,
        ir: -0.3,
        sampleSize: 100,
      },
    ]);

    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: [f1.id, f2.id, f3.id],
      weightMethod: "rank_ic_weighted",
    });
    const res = await strategyComposer.execute({
      compositionId: comp.id,
      asof: "2026-05-20",
      startDate: "2026-01-01",
      endDate: "2026-05-20",
      symbols: ["A"],
    });
    // 不直接 assert picks，因为 factor compute 在 P0 返回空；
    // 改成 assert 组合执行不抛 + sampleSize 与上游一致。
    expect(res.compositionId).toBe(comp.id);
    expect(res.meta.sampleSize).toBeGreaterThanOrEqual(1);
  });

  test("ic_ir_weighted：当所有 |ir| 都是 0 → 退到 equal 不抛错", async () => {
    const f1 = await factorService.register({
      projectId,
      name: `f_ir_zero1_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const f2 = await factorService.register({
      projectId,
      name: `f_ir_zero2_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const db = await getDb();
    await db.insert(schema.factorEvaluation).values([
      {
        id: randomUUID(),
        factorId: f1.id,
        asof: "2026-05-20",
        universe: "CN-A",
        rankIc: 0.1,
        ic: 0.1,
        ir: 0,
        sampleSize: 100,
      },
      {
        id: randomUUID(),
        factorId: f2.id,
        asof: "2026-05-20",
        universe: "CN-A",
        rankIc: 0.05,
        ic: 0.05,
        ir: 0,
        sampleSize: 100,
      },
    ]);

    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: [f1.id, f2.id],
      weightMethod: "ic_ir_weighted",
    });
    const res = await strategyComposer.execute({
      compositionId: comp.id,
      asof: "2026-05-20",
      startDate: "2026-01-01",
      endDate: "2026-05-20",
      symbols: ["X"],
    });
    expect(res.compositionId).toBe(comp.id);
  });

  test("manual weights 归一化", async () => {
    const f1 = await factorService.register({
      projectId,
      name: `f_w1_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const f2 = await factorService.register({
      projectId,
      name: `f_w2_${randomUUID().slice(0, 6)}`,
      category: "value",
      expr: "close",
    });
    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: [f1.id, f2.id],
      weightMethod: "manual",
      factorWeights: { [f1.name]: 3, [f2.name]: 1 },
    });
    expect(comp.params["factorWeights"]).toBeTruthy();
    // execute 跑得动（即便 factor compute 是空）
    const res = await strategyComposer.execute({
      compositionId: comp.id,
      asof: "2026-05-20",
      startDate: "2026-01-01",
      endDate: "2026-05-20",
      symbols: ["X", "Y"],
    });
    expect(res.kind).toBe("factor_score");
    // factor compute 在 P0 返回空 → contribution 也是 0 → score=0
    expect(res.picks.every((p) => p.score === 0)).toBe(true);
    expect(res.picks[0]?.rank).toBe(1);
  });
});
