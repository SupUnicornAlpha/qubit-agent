/**
 * P4b SkillAttributor 集成测：把 (workflow, day, pnl) 归因到 skill 维度。
 *
 * Fixture：workspace → project → workflow_run → sandbox_policy → agent_definition →
 *          agent_instance → 3 个 skill（s1,s2,s3）+ skill_recall_log（s1 executed,
 *          s2 executed, s3 NOT executed）+ agent_skill_run 行 for s1/s2。
 *
 * 覆盖：
 *   1) 单 workflow + 2 个 executed skill → agent_pnl_attribution + 2 个 skill_run.pnlDelta
 *   2) 0 executed skill → skipped，不写 agent_pnl_attribution
 *   3) 幂等 - 同 (workflow, day) 二次 attribute 覆盖原行
 *   4) 滚动 30 天 pnl_attribution_json 写出（pnlSum / winCount / loseCount / sampleCount）
 *   5) reader listAttributionsByRuntime / listSkillRankings / getPnlDeltaForRuns
 *   6) PnlAttributor end-to-end：fill → snapshot → skill_attribution_done
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
  BUILTIN_PAPER_TRADING_ACCOUNT_ID,
  agentDefinition,
  agentInstance,
  agentPnlAttribution,
  agentSkill,
  agentSkillRun,
  brokerOrder,
  chatSession,
  dailyMarkPrice,
  fill,
  indicatorStrategyScript,
  instrument,
  orderIntent,
  project,
  sandboxPolicy,
  skillRecallLog,
  strategy,
  strategyPnlSnapshot,
  strategyRuntime,
  strategyVersion,
  workflowRun,
  workspace,
} from "../../../db/sqlite/schema";
import { createPnlAttributor } from "../pnl-attributor";
import { createSkillAttributor } from "../skill-attributor";

interface Fixture {
  workspaceId: string;
  projectId: string;
  workflowRunId: string;
  sandboxPolicyId: string;
  definitionId: string;
  agentInstanceId: string;
  s1: string;
  s2: string;
  s3: string;
  // for PnlAttributor end-to-end
  chatSessionId: string;
  scriptId: string;
  strategyId: string;
  strategyVersionId: string;
  instrumentAAPL: string;
  runtimeUSId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p4b-skill-${Date.now()}`);
  await runMigrations();
  const db = await getDb();

  const f: Fixture = {
    workspaceId: `ws_${randomUUID()}`,
    projectId: `prj_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    sandboxPolicyId: `sp_${randomUUID()}`,
    definitionId: `def_${randomUUID()}`,
    agentInstanceId: `ai_${randomUUID()}`,
    s1: `skill_${randomUUID()}`,
    s2: `skill_${randomUUID()}`,
    s3: `skill_${randomUUID()}`,
    chatSessionId: `cs_${randomUUID()}`,
    scriptId: `script_${randomUUID()}`,
    strategyId: `strat_${randomUUID()}`,
    strategyVersionId: `strv_${randomUUID()}`,
    instrumentAAPL: `inst_${randomUUID()}`,
    runtimeUSId: `rt_${randomUUID()}`,
  };

  await db.insert(workspace).values({ id: f.workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: f.projectId, workspaceId: f.workspaceId, name: "p", marketScope: "US" })
    .run();
  await db
    .insert(workflowRun)
    .values({ id: f.workflowRunId, projectId: f.projectId, goal: "g", mode: "live" })
    .run();
  await db.insert(sandboxPolicy).values({ id: f.sandboxPolicyId, name: "test-policy" }).run();
  await db
    .insert(agentDefinition)
    .values({
      id: f.definitionId,
      role: "analyst_fundamental",
      name: "test-agent",
      systemPrompt: "sp",
      llmProvider: "openai",
      sandboxPolicyId: f.sandboxPolicyId,
    })
    .run();
  await db
    .insert(agentInstance)
    .values({
      id: f.agentInstanceId,
      definitionId: f.definitionId,
      workflowRunId: f.workflowRunId,
    })
    .run();
  // 3 个 skill
  for (const [id, name] of [
    [f.s1, "skill_one"],
    [f.s2, "skill_two"],
    [f.s3, "skill_three"],
  ] as const) {
    await db
      .insert(agentSkill)
      .values({
        id,
        projectId: f.projectId,
        name,
        definitionId: f.definitionId,
      })
      .run();
  }

  // PnlAttributor end-to-end fixture
  await db
    .insert(chatSession)
    .values({ id: f.chatSessionId, workspaceId: f.workspaceId, title: "t" })
    .run();
  await db
    .insert(indicatorStrategyScript)
    .values({
      id: f.scriptId,
      sessionId: f.chatSessionId,
      workflowRunId: f.workflowRunId,
      name: "test-script",
    })
    .run();
  await db
    .insert(strategy)
    .values({ id: f.strategyId, projectId: f.projectId, name: "s", style: "low_freq" })
    .run();
  await db
    .insert(strategyVersion)
    .values({
      id: f.strategyVersionId,
      strategyId: f.strategyId,
      versionTag: "v1",
      logicHash: "abc",
      paramSchemaJson: {},
    })
    .run();
  await db
    .insert(instrument)
    .values({
      id: f.instrumentAAPL,
      symbol: "AAPL",
      assetClass: "stock",
      exchange: "NASDAQ",
    })
    .run();
  await db
    .insert(strategyRuntime)
    .values({
      id: f.runtimeUSId,
      strategyScriptId: f.scriptId,
      market: "US",
      symbol: "AAPL",
      executionMode: "paper",
    })
    .run();

  fixture = f;
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(agentPnlAttribution).run();
  await db.delete(agentSkillRun).run();
  await db.delete(skillRecallLog).run();
  await db.delete(strategyPnlSnapshot).run();
  await db.delete(fill).run();
  await db.delete(brokerOrder).run();
  await db.delete(orderIntent).run();
  await db.delete(dailyMarkPrice).run();
  // 清 skill 的 pnl_attribution_json
  await db
    .update(agentSkill)
    .set({ pnlAttributionJson: "{}" })
    .where(eq(agentSkill.projectId, fixture.projectId))
    .run();
});

async function seedRecall(workflowRunId: string, skillId: string, executed: boolean) {
  const db = await getDb();
  await db
    .insert(skillRecallLog)
    .values({
      id: `rec_${randomUUID()}`,
      workflowRunId,
      skillId,
      executed,
    })
    .run();
}

async function seedSkillRun(workflowRunId: string, skillId: string) {
  const db = await getDb();
  const id = `sr_${randomUUID()}`;
  await db
    .insert(agentSkillRun)
    .values({
      id,
      skillId,
      workflowRunId,
      agentInstanceId: fixture.agentInstanceId,
      definitionId: fixture.definitionId,
      outcome: "success",
    })
    .run();
  return id;
}

describe("SkillAttributor.attribute", () => {
  test("场景1：2 个 executed skill → 写 attribution 行 + 2 个 skill_run.pnlDelta", async () => {
    await seedRecall(fixture.workflowRunId, fixture.s1, true);
    await seedRecall(fixture.workflowRunId, fixture.s2, true);
    await seedRecall(fixture.workflowRunId, fixture.s3, false);
    const runId1 = await seedSkillRun(fixture.workflowRunId, fixture.s1);
    const runId2 = await seedSkillRun(fixture.workflowRunId, fixture.s2);

    const db = await getDb();
    const attr = createSkillAttributor(db);
    const summary = await attr.attribute({
      items: [
        {
          workflowRunId: fixture.workflowRunId,
          tradingDay: "2026-06-01",
          pnlAttributed: 100,
          strategyRuntimeId: fixture.runtimeUSId,
        },
      ],
    });
    expect(summary.attributionRowsUpserted).toBe(1);
    expect(summary.itemsSkippedNoSkill).toBe(0);
    expect(summary.skillRunsUpdated).toBe(2);
    expect(summary.skillsRecomputed).toBe(2);

    const rows = await db
      .select()
      .from(agentPnlAttribution)
      .where(eq(agentPnlAttribution.workflowRunId, fixture.workflowRunId))
      .all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("missing");
    expect(row.pnlAttributed).toBe(100);
    expect(row.perSkillShare).toBe(50);
    const skillIds = JSON.parse(row.skillIdsJson) as string[];
    expect(skillIds.sort()).toEqual([fixture.s1, fixture.s2].sort());

    const run1 = await db.select().from(agentSkillRun).where(eq(agentSkillRun.id, runId1)).get();
    const run2 = await db.select().from(agentSkillRun).where(eq(agentSkillRun.id, runId2)).get();
    if (!run1 || !run2) throw new Error("missing skill_run");
    expect(run1.pnlDelta).toBe(50);
    expect(run2.pnlDelta).toBe(50);
    expect(run1.attributionConfidence).toBe(1);
  });

  test("场景2：0 executed skill → skipped + 不写 attribution", async () => {
    await seedRecall(fixture.workflowRunId, fixture.s1, false);

    const db = await getDb();
    const attr = createSkillAttributor(db);
    const summary = await attr.attribute({
      items: [
        {
          workflowRunId: fixture.workflowRunId,
          tradingDay: "2026-06-01",
          pnlAttributed: 100,
          strategyRuntimeId: fixture.runtimeUSId,
        },
      ],
    });
    expect(summary.itemsSkippedNoSkill).toBe(1);
    expect(summary.attributionRowsUpserted).toBe(0);

    const rows = await db.select().from(agentPnlAttribution).all();
    expect(rows).toHaveLength(0);
  });

  test("场景3：幂等 - 二次 attribute 覆盖原行不重复插入", async () => {
    await seedRecall(fixture.workflowRunId, fixture.s1, true);
    const runId = await seedSkillRun(fixture.workflowRunId, fixture.s1);

    const db = await getDb();
    const attr = createSkillAttributor(db);
    await attr.attribute({
      items: [
        {
          workflowRunId: fixture.workflowRunId,
          tradingDay: "2026-06-01",
          pnlAttributed: 100,
          strategyRuntimeId: fixture.runtimeUSId,
        },
      ],
    });
    await attr.attribute({
      items: [
        {
          workflowRunId: fixture.workflowRunId,
          tradingDay: "2026-06-01",
          pnlAttributed: -50, // 新的（更准）值
          strategyRuntimeId: fixture.runtimeUSId,
        },
      ],
    });
    const rows = await db
      .select()
      .from(agentPnlAttribution)
      .where(eq(agentPnlAttribution.workflowRunId, fixture.workflowRunId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pnlAttributed).toBe(-50);
    const run = await db.select().from(agentSkillRun).where(eq(agentSkillRun.id, runId)).get();
    if (!run) throw new Error("missing");
    expect(run.pnlDelta).toBe(-50);
  });

  test("场景4：30 天滚动 pnl_attribution_json 写出正确", async () => {
    await seedRecall(fixture.workflowRunId, fixture.s1, true);
    await seedSkillRun(fixture.workflowRunId, fixture.s1);

    const db = await getDb();
    const attr = createSkillAttributor(db);
    // 同一个 s1，跨 3 个 day 模拟历史归因（手动塞 attribution 行）
    const today = new Date().toISOString().slice(0, 10);
    const d1 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const d2 = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

    // 手动塞两行历史 attribution（不同 workflow）
    const w2 = `wf2_${randomUUID()}`;
    const w3 = `wf3_${randomUUID()}`;
    await db.insert(workflowRun).values({ id: w2, projectId: fixture.projectId, goal: "g", mode: "live" }).run();
    await db.insert(workflowRun).values({ id: w3, projectId: fixture.projectId, goal: "g", mode: "live" }).run();
    for (const [wfId, day, pnl] of [
      [w2, d1, 30],
      [w3, d2, -10],
    ] as const) {
      await db
        .insert(agentPnlAttribution)
        .values({
          id: `apa_${randomUUID()}`,
          workflowRunId: wfId,
          definitionId: null,
          strategyRuntimeId: fixture.runtimeUSId,
          asOfDate: day,
          pnlAttributed: pnl,
          skillIdsJson: JSON.stringify([fixture.s1]),
          perSkillShare: pnl,
          attributionMethod: "equal_weight_v0",
        })
        .run();
    }

    await attr.attribute({
      items: [
        {
          workflowRunId: fixture.workflowRunId,
          tradingDay: today,
          pnlAttributed: 20,
          strategyRuntimeId: fixture.runtimeUSId,
        },
      ],
    });

    const skill = await db
      .select({ pnlAttributionJson: agentSkill.pnlAttributionJson })
      .from(agentSkill)
      .where(eq(agentSkill.id, fixture.s1))
      .get();
    if (!skill) throw new Error("missing");
    const j = JSON.parse(skill.pnlAttributionJson) as {
      windowDays: number;
      pnlSum: number;
      winCount: number;
      loseCount: number;
      sampleCount: number;
    };
    expect(j.windowDays).toBe(30);
    // 三行：20 + 30 + (-10) = 40
    expect(j.pnlSum).toBe(40);
    expect(j.winCount).toBe(2);
    expect(j.loseCount).toBe(1);
    expect(j.sampleCount).toBe(3);
  });

  test("场景5：reader listAttributionsByRuntime / getPnlDeltaForRuns", async () => {
    await seedRecall(fixture.workflowRunId, fixture.s1, true);
    const runId = await seedSkillRun(fixture.workflowRunId, fixture.s1);

    const db = await getDb();
    const attr = createSkillAttributor(db);
    await attr.attribute({
      items: [
        {
          workflowRunId: fixture.workflowRunId,
          tradingDay: "2026-06-01",
          pnlAttributed: 200,
          strategyRuntimeId: fixture.runtimeUSId,
        },
      ],
    });

    const list = await attr.listAttributionsByRuntime(
      fixture.runtimeUSId,
      "2026-06-01",
      "2026-06-30"
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.pnlAttributed).toBe(200);
    expect(list[0]?.skillIds).toContain(fixture.s1);

    const map = await attr.getPnlDeltaForRuns([
      { workflowRunId: fixture.workflowRunId, skillId: fixture.s1 },
    ]);
    expect(map.get(`${fixture.workflowRunId}|${fixture.s1}`)).toBe(200);
    void runId;
  });

  test("场景5b：P9 listSkillRankingsByDefinition 按 agent 7d top-K", async () => {
    // seed 3 个 skill_run 都在 today，s2 最赚（+50）s1 中（+20）s3 亏（-10）
    const db = await getDb();
    const seedRunWithPnl = async (skillId: string, pnl: number) => {
      await db
        .insert(agentSkillRun)
        .values({
          id: `asr_${randomUUID()}`,
          skillId,
          workflowRunId: fixture.workflowRunId,
          agentInstanceId: fixture.agentInstanceId,
          definitionId: fixture.definitionId,
          outcome: pnl >= 0 ? "success" : "fail",
          pnlDelta: pnl,
          attributionConfidence: 1,
        })
        .run();
    };
    await seedRunWithPnl(fixture.s1, 20);
    await seedRunWithPnl(fixture.s2, 50);
    await seedRunWithPnl(fixture.s3, -10);

    const attr = createSkillAttributor(db);
    const out = await attr.listSkillRankingsByDefinition(fixture.definitionId, {
      windowDays: 7,
      topK: 3,
    });
    expect(out).toHaveLength(3);
    expect(out[0]?.skillId).toBe(fixture.s2);
    expect(out[0]?.pnlSum).toBe(50);
    expect(out[1]?.skillId).toBe(fixture.s1);
    expect(out[2]?.skillId).toBe(fixture.s3);
    expect(out[2]?.loseCount).toBe(1);

    // topK=2 截断
    const out2 = await attr.listSkillRankingsByDefinition(fixture.definitionId, {
      windowDays: 7,
      topK: 2,
    });
    expect(out2).toHaveLength(2);
    expect(out2.map((r) => r.skillId)).toEqual([fixture.s2, fixture.s1]);

    // 别的 definition 完全不串台
    const other = await attr.listSkillRankingsByDefinition(`def_${randomUUID()}`, {
      windowDays: 7,
    });
    expect(other).toHaveLength(0);

    // pnlDelta=null 的 run 不计入 sampleCount（直接 seed 一行 null）
    await db
      .insert(agentSkillRun)
      .values({
        id: `asr_${randomUUID()}`,
        skillId: fixture.s1,
        workflowRunId: fixture.workflowRunId,
        agentInstanceId: fixture.agentInstanceId,
        definitionId: fixture.definitionId,
        outcome: "unknown",
        pnlDelta: null,
        attributionConfidence: null,
      })
      .run();
    const out3 = await attr.listSkillRankingsByDefinition(fixture.definitionId, {
      windowDays: 7,
      topK: 3,
    });
    // s1 还是 pnl=20、sample=1（null run 被过滤）
    const s1Row = out3.find((r) => r.skillId === fixture.s1);
    expect(s1Row?.sampleCount).toBe(1);
    expect(s1Row?.pnlSum).toBe(20);
  });

  test("场景5c：窗口外的 run 不计入", async () => {
    const db = await getDb();
    // 8 天前的 run（应被排除）
    const oldTs = new Date(Date.now() - 8 * 86400_000).toISOString();
    await db
      .insert(agentSkillRun)
      .values({
        id: `asr_${randomUUID()}`,
        skillId: fixture.s1,
        workflowRunId: fixture.workflowRunId,
        agentInstanceId: fixture.agentInstanceId,
        definitionId: fixture.definitionId,
        outcome: "success",
        pnlDelta: 999,
        startedAt: oldTs,
        endedAt: oldTs,
      })
      .run();
    const attr = createSkillAttributor(db);
    const out = await attr.listSkillRankingsByDefinition(fixture.definitionId, {
      windowDays: 7,
    });
    expect(out).toHaveLength(0);
  });

  test("场景6：PnlAttributor end-to-end → SkillAttributor 自动跑", async () => {
    // 先 seed recall + skill_run
    await seedRecall(fixture.workflowRunId, fixture.s1, true);
    await seedSkillRun(fixture.workflowRunId, fixture.s1);

    // 一笔 fill
    const db = await getDb();
    const intentId = `oi_${randomUUID()}`;
    const orderId = `bo_${randomUUID()}`;
    await db
      .insert(orderIntent)
      .values({
        id: intentId,
        workflowRunId: fixture.workflowRunId,
        strategyVersionId: fixture.strategyVersionId,
        instrumentId: fixture.instrumentAAPL,
        side: "buy",
        qty: 100,
        orderType: "market",
        timeInForce: "day",
        market: "US",
        symbol: "AAPL",
        strategyRuntimeId: fixture.runtimeUSId,
      })
      .run();
    await db
      .insert(brokerOrder)
      .values({
        id: orderId,
        orderIntentId: intentId,
        accountId: BUILTIN_PAPER_TRADING_ACCOUNT_ID,
        connectorInstanceId: BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
        brokerOrderId: `bbo_${orderId}`,
        status: "filled",
      })
      .run();
    await db
      .insert(fill)
      .values({
        id: `f_${randomUUID()}`,
        brokerOrderId: orderId,
        fillQty: 100,
        fillPrice: 150,
        fee: 1,
        filledAt: "2026-06-01T14:00:00.000Z",
      })
      .run();
    await db
      .insert(dailyMarkPrice)
      .values({
        id: `dmp_${randomUUID()}`,
        market: "US",
        symbol: "AAPL",
        tradingDay: "2026-06-01",
        close: 152,
        source: "test_fixture",
      })
      .run();

    const pa = createPnlAttributor(db);
    const summary = await pa.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary.snapshotsWritten).toBe(1);
    expect(summary.skillAttribution).not.toBeNull();
    expect(summary.skillAttribution?.attributionRowsUpserted).toBe(1);
    expect(summary.skillAttribution?.skillRunsUpdated).toBe(1);

    // 验证 skill_run.pnlDelta 已被写入
    const runs = await db
      .select()
      .from(agentSkillRun)
      .where(
        and(
          eq(agentSkillRun.workflowRunId, fixture.workflowRunId),
          eq(agentSkillRun.skillId, fixture.s1)
        )
      )
      .all();
    expect(runs).toHaveLength(1);
    // pnl = realizedDaily(0) + unrealizedDaily(200) - feeDaily(1) = 199；K=1 skill → 199
    expect(runs[0]?.pnlDelta).toBe(199);
  });

  test("场景7：dryRun 不触发 skill attribution", async () => {
    await seedRecall(fixture.workflowRunId, fixture.s1, true);
    await seedSkillRun(fixture.workflowRunId, fixture.s1);

    const db = await getDb();
    const intentId = `oi_${randomUUID()}`;
    const orderId = `bo_${randomUUID()}`;
    await db
      .insert(orderIntent)
      .values({
        id: intentId,
        workflowRunId: fixture.workflowRunId,
        strategyVersionId: fixture.strategyVersionId,
        instrumentId: fixture.instrumentAAPL,
        side: "buy",
        qty: 100,
        orderType: "market",
        timeInForce: "day",
        market: "US",
        symbol: "AAPL",
        strategyRuntimeId: fixture.runtimeUSId,
      })
      .run();
    await db
      .insert(brokerOrder)
      .values({
        id: orderId,
        orderIntentId: intentId,
        accountId: BUILTIN_PAPER_TRADING_ACCOUNT_ID,
        connectorInstanceId: BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
        brokerOrderId: `bbo_${orderId}`,
        status: "filled",
      })
      .run();
    await db
      .insert(fill)
      .values({
        id: `f_${randomUUID()}`,
        brokerOrderId: orderId,
        fillQty: 100,
        fillPrice: 150,
        fee: 1,
        filledAt: "2026-06-01T14:00:00.000Z",
      })
      .run();
    await db
      .insert(dailyMarkPrice)
      .values({
        id: `dmp_${randomUUID()}`,
        market: "US",
        symbol: "AAPL",
        tradingDay: "2026-06-01",
        close: 152,
        source: "test_fixture",
      })
      .run();

    const pa = createPnlAttributor(db);
    const summary = await pa.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
      dryRun: true,
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.skillAttribution).toBeNull();
    const apa = await (await getDb()).select().from(agentPnlAttribution).all();
    expect(apa).toHaveLength(0);
  });
});
