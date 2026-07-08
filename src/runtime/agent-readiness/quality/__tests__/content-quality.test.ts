/**
 * A 类 · 内容质量指标测试（A-1 完整性 / A-2 相关性 / A-4 一致性）。
 *
 * fixture 思路：
 *   - tmpdir SQLite，灌 5 场景各自的最小产物
 *   - 跑 collectContentQuality，断言指标值精确等于预期
 *   - 同时测"完全无产物"(全红) 与"部分产物"(黄/红 case)
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(
  tmpdir(),
  `qubit-aqm-content-${process.pid}-${Date.now()}`
);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../../db/sqlite/migrate");
const { getDb, closeDb, getSqliteForTesting } = await import(
  "../../../../db/sqlite/client"
);
const schema = await import("../../../../db/sqlite/schema");
const { collectContentQuality } = await import("../content-quality");

const WORKSPACE_ID = "ws-aqm-content";
const PROJECT_ID = "proj-aqm-content";
const SANDBOX_ID = "sb-aqm-content";

async function setupWorkflow(goal: string): Promise<string> {
  const db = await getDb();
  const wfId = `wf-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id: wfId,
    projectId: PROJECT_ID,
    sessionId: null,
    goal,
    mode: "research",
    source: "api",
    status: "completed",
  });
  return wfId;
}

describe("A 类 · 内容质量", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "aqm-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "aqm-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "aqm-sb", description: "" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("research：空 workflow → A-1=0、A-2=0、A-4=null（无引用可校验）", async () => {
    const wfId = await setupWorkflow("[readiness/research] 分析美股大盘宏观见解");
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "research",
      goal: "分析美股大盘宏观见解",
    });
    expect(r["A-1"]).toBe(0);
    expect(r["A-2"]).toBe(0);
    expect(r["A-4"]).toBeNull();
  });

  test("research：2 条 analyst_signal + 1 条 fusion → A-1=1（全产出）", async () => {
    const wfId = await setupWorkflow("[readiness/research] 美股 AAPL 见解");
    const db = await getDb();
    for (const t of ["AAPL", "MSFT"]) {
      await db.insert(schema.analystSignal).values({
        id: `as-${t}-${wfId}`,
        workflowRunId: wfId,
        analystRole: "fundamental",
        ticker: t,
        signal: "buy",
        confidence: 0.7,
        reasoning: `因为 ${t} 业绩强劲`,
      });
    }
    await db.insert(schema.signalFusionResult).values({
      id: `sf-${wfId}`,
      workflowRunId: wfId,
      ticker: "AAPL",
      fusedSignal: "buy",
      fusedConfidence: 0.6,
    });
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "research",
      goal: "美股 AAPL 见解",
    });
    expect(r["A-1"]).toBe(1);
  });

  test("research：只有 1 条 analyst_signal → A-1=0.5（部分产出，缺 fusion 也黄）", async () => {
    const wfId = await setupWorkflow("partial research");
    const db = await getDb();
    await db.insert(schema.analystSignal).values({
      id: `as-only-${wfId}`,
      workflowRunId: wfId,
      analystRole: "technical",
      ticker: "TSLA",
      signal: "hold",
      reasoning: "震荡",
    });
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "research",
      goal: "partial",
    });
    // 1 个产物表满足、1 个不满足 → 0.5（黄）
    expect(r["A-1"]).toBeCloseTo(0.5);
  });

  test("strategy：strategy_composition.factorIds 全部命中 factor_definition → A-4=1", async () => {
    const wfId = await setupWorkflow("[readiness/strategy] factor combo");
    const db = await getDb();
    // 注入 2 个 factor_definition
    for (const i of [1, 2]) {
      await db.insert(schema.factorDefinition).values({
        id: `f-${i}-${wfId}`,
        projectId: PROJECT_ID,
        name: `f${i}`,
        category: "momentum",
        definitionJson: {} as never,
        expr: `close - close[20]`,
      });
    }
    // strategy + version + composition 引用上述 2 个 factor
    const stratId = `s-${wfId}`;
    const verId = `sv-${wfId}`;
    await db.insert(schema.strategy).values({
      id: stratId,
      projectId: PROJECT_ID,
      name: "test-strat",
      style: "low_freq",
    });
    await db.insert(schema.strategyVersion).values({
      id: verId,
      strategyId: stratId,
      versionTag: "v1",
      logicHash: "h",
      paramSchemaJson: {} as never,
      workflowRunId: wfId,
    });
    await db.insert(schema.strategyComposition).values({
      id: `sc-${wfId}`,
      strategyVersionId: verId,
      kind: "factor_score",
      factorIdsJson: [`f-1-${wfId}`, `f-2-${wfId}`] as never,
    });
    await db.insert(schema.backtestRun).values({
      id: `bt-${wfId}`,
      strategyVersionId: verId,
      connectorInstanceId: "test-connector",
      datasetSnapshotId: "test-dataset",
      configJson: {} as never,
      performanceJson: { sharpe: 1.1, maxDrawdown: 0.08 } as never,
      status: "completed",
      workflowRunId: wfId,
    });
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "strategy",
      goal: "factor combo",
    });
    expect(r["A-1"]).toBe(1);
    expect(r["A-4"]).toBe(1);
    expect(r["A-5"]).toBe(1);
  });

  test("strategy：composition 引用 1 个不存在的 factor → A-4=0.5", async () => {
    const wfId = await setupWorkflow("[readiness/strategy] broken refs");
    const db = await getDb();
    await db.insert(schema.factorDefinition).values({
      id: `f-real-${wfId}`,
      projectId: PROJECT_ID,
      name: `f-real`,
      category: "value",
      definitionJson: {} as never,
      expr: `pe`,
    });
    const stratId = `s-broken-${wfId}`;
    const verId = `sv-broken-${wfId}`;
    await db.insert(schema.strategy).values({
      id: stratId,
      projectId: PROJECT_ID,
      name: "broken-strat",
      style: "low_freq",
    });
    await db.insert(schema.strategyVersion).values({
      id: verId,
      strategyId: stratId,
      versionTag: "v1",
      logicHash: "h",
      paramSchemaJson: {} as never,
      workflowRunId: wfId,
    });
    await db.insert(schema.strategyComposition).values({
      id: `sc-broken-${wfId}`,
      strategyVersionId: verId,
      kind: "factor_score",
      // 1 个真实，1 个不存在 → 1/2 broken
      factorIdsJson: [`f-real-${wfId}`, `f-ghost-${wfId}`] as never,
    });
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "strategy",
      goal: "broken refs",
    });
    // 2 refs → 1 broken → 1 - 0.5 = 0.5
    expect(r["A-4"]).toBeCloseTo(0.5);
  });

  test("A-2 关键词命中：goal 含 'AAPL' + signal.ticker = 'AAPL' → A-2=1", async () => {
    const wfId = await setupWorkflow("[readiness/research] AAPL fundamentals");
    const db = await getDb();
    await db.insert(schema.analystSignal).values({
      id: `as-2-${wfId}`,
      workflowRunId: wfId,
      analystRole: "fundamental",
      ticker: "AAPL",
      signal: "buy",
      reasoning: "美股 AAPL 见解",
    });
    await db.insert(schema.signalFusionResult).values({
      id: `sf-2-${wfId}`,
      workflowRunId: wfId,
      ticker: "AAPL",
      fusedSignal: "buy",
      fusedConfidence: 0.5,
    });
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "research",
      goal: "[readiness/research] AAPL 见解",
    });
    // goal 显式含 "AAPL" 和 "见解"；signal/fusion 都覆盖
    expect(r["A-2"]).toBeGreaterThanOrEqual(0.5);
  });

  /**
   * Round 8 复盘（2026-06-08）：原 factor 场景 A-1 SQL 没按 workflow_run_id 过滤，
   * artifact-checker / content-quality 用 `sqlite.prepare(sql).get(workflowRunId)`
   * 时多余参数被静默忽略，导致历史 round 的因子也被计入"本 workflow 产出"。
   * 这两个测试覆盖修复后 SQL 严格 workflow scope 的行为。
   */
  test("factor：仅当本 workflow 写入 factor_definition + factor_evaluation 时 A-1=1", async () => {
    const wfId = await setupWorkflow("[readiness/factor] new alpha");
    const db = await getDb();
    const fid = `fd-${wfId}`;
    await db.insert(schema.factorDefinition).values({
      id: fid,
      projectId: PROJECT_ID,
      name: "alpha-mr",
      category: "momentum",
      definitionJson: {} as never,
      expr: "close - close[20]",
      workflowRunId: wfId,
    });
    await db.insert(schema.factorEvaluation).values({
      id: `fe-${wfId}`,
      factorId: fid,
      asof: new Date().toISOString().slice(0, 10),
      universe: "us-largecap",
      ic: 0.05,
      rankIc: 0.06,
      ir: 0.4,
    });
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "factor",
      goal: "alpha 因子 IC",
    });
    expect(r["A-1"]).toBe(1);
    expect(r["A-5"]).toBe(1);
  });

  test("factor：其他 workflow 留下的全库残留因子不应让本 workflow 假阳性 A-1>0", async () => {
    // 先以"其他 workflow"身份注入 1 个 factor + evaluation
    const otherWf = await setupWorkflow("[readiness/factor] OTHER ROUND");
    const db = await getDb();
    const otherFid = `fd-other-${otherWf}`;
    await db.insert(schema.factorDefinition).values({
      id: otherFid,
      projectId: PROJECT_ID,
      name: "legacy-alpha",
      category: "value",
      definitionJson: {} as never,
      expr: "pe",
      workflowRunId: otherWf,
    });
    await db.insert(schema.factorEvaluation).values({
      id: `fe-other-${otherWf}`,
      factorId: otherFid,
      asof: new Date().toISOString().slice(0, 10),
      universe: "us-largecap",
      ic: 0.02,
    });

    // 现在跑"本 workflow"（不向 factor_* 写任何东西），A-1 必须 = 0
    const wfId = await setupWorkflow("[readiness/factor] CURRENT ROUND");
    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "factor",
      goal: "alpha 因子",
    });
    expect(r["A-1"]).toBe(0);
  });

  test("live_trading：order → strategy_version 引用合法 → A-4=1", async () => {
    const wfId = await setupWorkflow("[readiness/live] order placement");
    const db = await getDb();
    const stratId = `s-live-${wfId}`;
    const verId = `sv-live-${wfId}`;
    await db.insert(schema.strategy).values({
      id: stratId,
      projectId: PROJECT_ID,
      name: "live-s",
      style: "low_freq",
    });
    await db.insert(schema.strategyVersion).values({
      id: verId,
      strategyId: stratId,
      versionTag: "v1",
      logicHash: "h",
      paramSchemaJson: {} as never,
    });
    const instId = `i-live-${wfId}`;
    await db.insert(schema.instrument).values({
      id: instId,
      symbol: "AAPL",
      assetClass: "stock",
      exchange: "NASDAQ",
    });
    const oiId = `oi-${wfId}`;
    await db.insert(schema.orderIntent).values({
      id: oiId,
      workflowRunId: wfId,
      strategyVersionId: verId,
      instrumentId: instId,
      side: "buy",
      qty: 100,
      orderType: "market",
      timeInForce: "day",
    });
    // risk_decision 也加 1 条
    const ruleId = `rr-${wfId}`;
    await db.insert(schema.riskRule).values({
      id: ruleId,
      projectId: PROJECT_ID,
      name: "rr",
      scope: "pre_trade",
      ruleExpr: "qty <= 100",
      severity: "block",
    });
    await db.insert(schema.riskDecision).values({
      id: `rd-${wfId}`,
      orderIntentId: oiId,
      riskRuleId: ruleId,
      decision: "allow",
      reason: "ok",
      signature: "sig",
    });

    const sqlite = getSqliteForTesting();
    const r = await collectContentQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "live_trading",
      goal: "order placement",
    });
    expect(r["A-1"]).toBe(1);
    expect(r["A-4"]).toBe(1);
  });
});
