/**
 * 五条产线"上线就绪度"端到端集成测试。
 *
 * 这里把"Agent 平台能输出达到上线标准的内容"翻译成可执行断言：
 *
 *   1) 行情研究    → signal_fusion_result + analyst_signal       （workflowRunId 关联）
 *   2) 股票推荐    → screener_run + screener_candidate            （workflowRunId 关联）
 *   3) 因子生成    → factor_definition                            （workflowRunId 关联，可被回查）
 *   4) 策略生成    → strategy + strategy_version                  （strategyVersion 关联到 workflowRunId）
 *   5) 实时交易    → order_intent + execution_task                （workflowRunId 关联，落预交易风控）
 *
 * 期望：单个 workflow_run 内能完成全部五条产线的最小闭环；通过 workflowRunId 把五段
 * 产物串成可审计的 lineage（"这条订单是从哪个研究 / 哪个推荐 / 哪个因子 / 哪个策略
 * 出来的"应该都能 SQL 查回来）。
 *
 * 这个测试不调 LLM，只走每条产线的 service 入口；保证：
 *   - 接口仍可调（防止改名或字段漂移）
 *   - 产物落到了正确的表
 *   - 五段产物能用 workflowRunId join 起来
 *
 * 作为"上线门禁"的可执行版本：CI 失败即代表"五产线契约破坏"。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-pipeline-readiness-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../db/sqlite/client");
const schema = await import("../../db/sqlite/schema");
const drizzle = await import("drizzle-orm");
const { fuseSignals } = await import("../msa/signal-fusion");
const { runStockScreener } = await import("../screener/stock-screener");
const { factorService } = await import("../factor/factor-service");
const { strategyComposer } = await import("../strategy/strategy-composer");
const { createOrderIntentFromReiaPayload } = await import("../execution/reia-bridge");

const WORKSPACE_ID = "ws-pipeline-readiness";
const PROJECT_ID = "proj-pipeline-readiness";
const SANDBOX_ID = "sb-pipeline-readiness";

describe("五产线就绪度（pipeline readiness）", () => {
  let workflowRunId: string;

  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "pr-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "pr-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "pr-sb", description: "" })
      .onConflictDoNothing();

    workflowRunId = `wf-${crypto.randomUUID()}`;
    await db.insert(schema.workflowRun).values({
      id: workflowRunId,
      projectId: PROJECT_ID,
      sessionId: null,
      goal: "pipeline readiness e2e",
      mode: "research",
      source: "api",
      status: "running",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  test("产线 1：行情研究 — fuseSignals 落 signal_fusion_result + analyst_signal", async () => {
    const db = await getDb();

    // 准备最小 agent_definition / agent_instance（analyst_signal.persistSignals 需要 instance）。
    const fundDefId = `def-fund-${crypto.randomUUID()}`;
    const macroDefId = `def-macro-${crypto.randomUUID()}`;
    await db.insert(schema.agentDefinition).values([
      {
        id: fundDefId,
        role: "analyst_fundamental",
        name: "FundAnalyst",
        version: "v1",
        systemPrompt: "",
        toolsJson: [] as never,
        mcpServersJson: [] as never,
        skillsJson: [] as never,
        subscriptionsJson: [] as never,
        llmProvider: "mock",
        maxIterations: 3,
        sandboxPolicyId: SANDBOX_ID,
        enabled: true,
      },
      {
        id: macroDefId,
        role: "analyst_macro",
        name: "MacroAnalyst",
        version: "v1",
        systemPrompt: "",
        toolsJson: [] as never,
        mcpServersJson: [] as never,
        skillsJson: [] as never,
        subscriptionsJson: [] as never,
        llmProvider: "mock",
        maxIterations: 3,
        sandboxPolicyId: SANDBOX_ID,
        enabled: true,
      },
    ]);
    const fundInstId = `inst-fund-${crypto.randomUUID()}`;
    const macroInstId = `inst-macro-${crypto.randomUUID()}`;
    await db.insert(schema.agentInstance).values([
      { id: fundInstId, definitionId: fundDefId, workflowRunId, status: "stopped" },
      { id: macroInstId, definitionId: macroDefId, workflowRunId, status: "stopped" },
    ]);

    const result = await fuseSignals({
      workflowRunId,
      signals: [
        {
          definitionId: fundDefId,
          analystRole: "analyst_fundamental",
          ticker: "AAPL",
          signal: "buy",
          confidence: 0.8,
          reasoning: "strong earnings",
        },
        {
          definitionId: macroDefId,
          analystRole: "analyst_macro",
          ticker: "AAPL",
          signal: "buy",
          confidence: 0.6,
          reasoning: "supportive macro",
        },
      ],
      persistSignals: [
        {
          agentInstanceId: fundInstId,
          signal: {
            definitionId: fundDefId,
            analystRole: "analyst_fundamental",
            ticker: "AAPL",
            signal: "buy",
            confidence: 0.8,
            reasoning: "strong earnings",
          },
        },
        {
          agentInstanceId: macroInstId,
          signal: {
            definitionId: macroDefId,
            analystRole: "analyst_macro",
            ticker: "AAPL",
            signal: "buy",
            confidence: 0.6,
            reasoning: "supportive macro",
          },
        },
      ],
    });

    expect(result.fusedSignal).toBe("buy");
    expect(result.ticker).toBe("AAPL");

    // 落库断言：signal_fusion_result + analyst_signal 都按 workflowRunId 关联
    const fusionRows = await db
      .select()
      .from(schema.signalFusionResult)
      .where(drizzle.eq(schema.signalFusionResult.workflowRunId, workflowRunId));
    expect(fusionRows.length).toBeGreaterThanOrEqual(1);
    expect(fusionRows.some((r) => r.ticker === "AAPL")).toBe(true);

    const sigRows = await db
      .select()
      .from(schema.analystSignal)
      .where(drizzle.eq(schema.analystSignal.workflowRunId, workflowRunId));
    expect(sigRows.length).toBe(2);
  });

  test("产线 2：股票推荐 — runStockScreener 落 screener_run + screener_candidate", async () => {
    const db = await getDb();
    const result = await runStockScreener({
      workflowRunId,
      universe: "US",
      topN: 5,
    });

    expect(result.candidateCount).toBeGreaterThan(0);
    expect(result.candidates.length).toBe(result.candidateCount);

    const runRows = await db
      .select()
      .from(schema.screenerRun)
      .where(drizzle.eq(schema.screenerRun.workflowRunId, workflowRunId));
    expect(runRows.length).toBeGreaterThanOrEqual(1);

    const lastRun = runRows[runRows.length - 1];
    if (!lastRun) throw new Error("expected screener_run row");
    const candidates = await db
      .select()
      .from(schema.screenerCandidate)
      .where(drizzle.eq(schema.screenerCandidate.screenerRunId, lastRun.id));
    expect(candidates.length).toBeGreaterThan(0);
  });

  test("产线 3：因子生成 — factorService.register 落 factor_definition + 关联 workflowRunId", async () => {
    const db = await getDb();
    const factor = await factorService.register({
      projectId: PROJECT_ID,
      name: `mom20-${Date.now()}`,
      category: "momentum",
      expr: "Mean($close, 20) - $close",
      lang: "qlib_expr",
      universe: "US",
      horizon: 5,
      workflowRunId,
    });

    expect(factor.id).toBeTruthy();
    expect(factor.name).toMatch(/^mom20-/);

    const rows = await db
      .select()
      .from(schema.factorDefinition)
      .where(drizzle.eq(schema.factorDefinition.id, factor.id));
    expect(rows.length).toBe(1);
    const factorRow = rows[0];
    if (!factorRow) throw new Error("expected factor_definition row");
    expect(factorRow.workflowRunId).toBe(workflowRunId);
    expect(factorRow.lang).toBe("qlib_expr");
  });

  test("产线 4：策略生成 — strategy + strategy_version 落库且关联 workflowRunId", async () => {
    const db = await getDb();

    const stratId = `strat-${crypto.randomUUID()}`;
    await db.insert(schema.strategy).values({
      id: stratId,
      projectId: PROJECT_ID,
      name: "pr-mom-strategy",
      style: "low_freq",
      description: "pipeline readiness strategy",
    });

    const versionId = `sv-${crypto.randomUUID()}`;
    await db.insert(schema.strategyVersion).values({
      id: versionId,
      strategyId: stratId,
      versionTag: "v1",
      logicHash: "pr-readiness",
      paramSchemaJson: {} as never,
      workflowRunId,
    });

    const versions = await db
      .select()
      .from(schema.strategyVersion)
      .where(drizzle.eq(schema.strategyVersion.workflowRunId, workflowRunId));
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.some((v) => v.strategyId === stratId)).toBe(true);
  });

  test("产线 5：实时交易 — createOrderIntentFromReiaPayload 落 order_intent + execution_task", async () => {
    const db = await getDb();
    const legacyBefore = (
      await db
        .select()
        .from(schema.intentOrder)
        .where(drizzle.eq(schema.intentOrder.workflowRunId, workflowRunId))
    ).length;
    const out = await createOrderIntentFromReiaPayload(
      {
        workflowRunId,
        ticker: "AAPL",
        direction: "long",
        quantity: 10,
        targetPrice: 180,
        rationale: "pipeline-readiness e2e",
        market: "us",
        timeframe: "1d",
        executionMode: "paper",
      },
      db
    );

    expect(out.orderIntentId).toBeTruthy();
    expect(out.legacyIntentOrderId).toBeUndefined();

    const oiRows = await db
      .select()
      .from(schema.orderIntent)
      .where(drizzle.eq(schema.orderIntent.workflowRunId, workflowRunId));
    expect(oiRows.length).toBeGreaterThanOrEqual(1);

    const taskRows = await db
      .select()
      .from(schema.executionTask)
      .where(drizzle.eq(schema.executionTask.orderIntentId, out.orderIntentId));
    expect(taskRows.length).toBeGreaterThanOrEqual(1);
    const legacyAfter = (
      await db
        .select()
        .from(schema.intentOrder)
        .where(drizzle.eq(schema.intentOrder.workflowRunId, workflowRunId))
    ).length;
    expect(legacyAfter).toBe(legacyBefore);
  });

  test("旧 intent_order 仅在显式兼容开关下双写", async () => {
    const db = await getDb();
    const out = await createOrderIntentFromReiaPayload(
      {
        workflowRunId,
        ticker: "MSFT",
        direction: "long",
        quantity: 2,
        targetPrice: 400,
        executionMode: "paper",
        legacyDualWrite: true,
      },
      db
    );
    expect(out.legacyIntentOrderId).toBeTruthy();
    const rows = await db
      .select()
      .from(schema.intentOrder)
      .where(drizzle.eq(schema.intentOrder.id, out.legacyIntentOrderId!));
    expect(rows).toHaveLength(1);
  });

  test("端到端 lineage：单 workflow 内五段产物可被串联", async () => {
    const db = await getDb();

    // 五条产线的产物计数（按 workflowRunId 反查）
    const counts = {
      fusion: (
        await db
          .select()
          .from(schema.signalFusionResult)
          .where(drizzle.eq(schema.signalFusionResult.workflowRunId, workflowRunId))
      ).length,
      screener: (
        await db
          .select()
          .from(schema.screenerRun)
          .where(drizzle.eq(schema.screenerRun.workflowRunId, workflowRunId))
      ).length,
      factor: (
        await db
          .select()
          .from(schema.factorDefinition)
          .where(drizzle.eq(schema.factorDefinition.workflowRunId, workflowRunId))
      ).length,
      strategyVersion: (
        await db
          .select()
          .from(schema.strategyVersion)
          .where(drizzle.eq(schema.strategyVersion.workflowRunId, workflowRunId))
      ).length,
      orderIntent: (
        await db
          .select()
          .from(schema.orderIntent)
          .where(drizzle.eq(schema.orderIntent.workflowRunId, workflowRunId))
      ).length,
    };

    // 上线标准 v1（基础门槛）：单个 workflow 内五段产物均 ≥ 1，任何一段缺失即视为"未达标"。
    expect(counts.fusion).toBeGreaterThanOrEqual(1);
    expect(counts.screener).toBeGreaterThanOrEqual(1);
    expect(counts.factor).toBeGreaterThanOrEqual(1);
    expect(counts.strategyVersion).toBeGreaterThanOrEqual(1);
    expect(counts.orderIntent).toBeGreaterThanOrEqual(1);
  });

  /**
   * 上线标准 v2（强 lineage）：策略 → 因子的显式父子关系应可在一条 SQL 反查回来。
   *
   * 这是从 "可审计 / 可回放" 角度推导的硬要求：
   *   - 风控 / 监管复盘要回答 "这条订单基于哪些因子" → 必须能从 order_intent
   *     反向推到 strategy_composition.factor_ids_json，并能在 factor_definition 命中。
   *   - factorIdsJson 是当前架构里唯一显式声明的 strategy ↔ factor 关系。
   */
  test("上线 v2 lineage：strategy_composition.factor_ids 能反查到 factor_definition", async () => {
    const db = await getDb();

    const factor = await factorService.register({
      projectId: PROJECT_ID,
      name: `lineage-mom-${Date.now()}`,
      category: "momentum",
      expr: "Rank(Mean($close, 10))",
      lang: "qlib_expr",
      universe: "US",
      horizon: 5,
      workflowRunId,
    });

    const versions = await db
      .select()
      .from(schema.strategyVersion)
      .where(drizzle.eq(schema.strategyVersion.workflowRunId, workflowRunId))
      .limit(1);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    const versionRow = versions[0];
    if (!versionRow) throw new Error("expected strategy_version row");
    const versionId = versionRow.id;

    const composition = await strategyComposer.define({
      strategyVersionId: versionId,
      kind: "factor_score",
      factorIds: [factor.id],
      weightMethod: "equal",
      universe: "US",
    });
    expect(composition.factorIds).toContain(factor.id);

    // 反向 lineage：strategyVersion.workflowRunId → strategy_composition.factor_ids
    //   → factor_definition.id
    const compRows = await db
      .select()
      .from(schema.strategyComposition)
      .where(drizzle.eq(schema.strategyComposition.strategyVersionId, versionId));
    expect(compRows.length).toBeGreaterThanOrEqual(1);

    const factorIds = compRows.flatMap(
      (r) => (r.factorIdsJson as string[] | null) ?? []
    );
    expect(factorIds).toContain(factor.id);

    const factorRows = await db
      .select()
      .from(schema.factorDefinition)
      .where(drizzle.inArray(schema.factorDefinition.id, factorIds));
    expect(factorRows.length).toBe(factorIds.length);
    expect(factorRows.every((r) => r.workflowRunId === workflowRunId)).toBe(true);
  });

  /**
   * 上线标准 v2（订单 → 策略 → 因子 全链）：从 order_intent 出发反查到原始 factor。
   *
   * 这是 "出事故能定位" 的最低门槛：监管 / 风控复盘 / TCA 都要求能从一笔成交
   * 反推到决策依据。
   */
  test("上线 v2 lineage：order_intent 可反查到 strategy_version → strategy_composition → factor", async () => {
    const db = await getDb();

    const oiRows = await db
      .select()
      .from(schema.orderIntent)
      .where(drizzle.eq(schema.orderIntent.workflowRunId, workflowRunId))
      .limit(1);
    expect(oiRows.length).toBe(1);
    const orderIntent = oiRows[0];
    if (!orderIntent) throw new Error("expected order_intent row");

    const svRows = await db
      .select()
      .from(schema.strategyVersion)
      .where(drizzle.eq(schema.strategyVersion.id, orderIntent.strategyVersionId));
    expect(svRows.length).toBe(1);
    const svRow = svRows[0];
    if (!svRow) throw new Error("expected strategy_version row");

    const compRows = await db
      .select()
      .from(schema.strategyComposition)
      .where(drizzle.eq(schema.strategyComposition.strategyVersionId, svRow.id));
    expect(compRows.length).toBeGreaterThanOrEqual(1);

    const factorIds = compRows.flatMap(
      (r) => (r.factorIdsJson as string[] | null) ?? []
    );
    expect(factorIds.length).toBeGreaterThanOrEqual(1);

    const factorRows = await db
      .select()
      .from(schema.factorDefinition)
      .where(drizzle.inArray(schema.factorDefinition.id, factorIds));
    expect(factorRows.length).toBe(factorIds.length);
  });
});
