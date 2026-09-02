import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDir } from "../../app-paths";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import * as schema from "../../../db/sqlite/schema";
import { _resetBootstrapForTests, bootstrapProviders } from "../../provider/bootstrap";
import { buildMarketSnapshotRecord } from "../../market/contracts/market-snapshot-service";
import { FactorServiceError, factorService } from "../factor-service";

let projectId = "";

function researchContract(expression: string) {
  return {
    version: "factor-research-contract-v1" as const,
    economicMechanism: "Persistent relative-strength reflects slow information diffusion.",
    dataAvailability: {
      sourceFields: ["close"],
      availableAtRule: "Use the close only after the bar is finalized.",
      pointInTime: true as const,
    },
    formula: {
      expression,
      frequency: "1d",
      expectedDirection: "higher_is_bullish" as const,
    },
    preprocessing: {
      missingValuePolicy: "drop" as const,
      winsorization: "cross-sectional 1%/99%",
      standardization: "cross-sectional z-score",
      neutralization: "sector neutral",
    },
    applicability: {
      universes: ["US"],
      horizonsDays: [5],
      invalidationConditions: ["Rank IC is no longer statistically positive out of sample."],
    },
    validation: {
      independentValidationPlan: "Freeze parameters, then evaluate on a separate snapshot.",
      minimumDailyObservations: 60,
    },
  };
}

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  const db = await getDb();
  const wid = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({ id: wid, name: "fs-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId: wid,
    name: "fs-proj",
    marketScope: "CN-A",
    status: "active",
  });
});

describe("FactorService", () => {
  test("independent validation purges training labels before its explicit OOS boundary", async () => {
    const internal = factorService as unknown as {
      evaluateIndependentHoldout: (input: Record<string, unknown>) => Promise<{
        split: { trainLabelEndExclusive: string };
        status: string;
      }>;
      resolveEval: () => Promise<{
        evaluate: (input: { values: Array<{ date: string }> }) => Promise<unknown>;
      }>;
    };
    const originalResolveEval = internal.resolveEval;
    const receivedDates: string[][] = [];
    internal.resolveEval = async () => ({
      evaluate: async (input) => {
        receivedDates.push(input.values.map((row) => row.date));
        return {
          ic: 0.05,
          rankIc: 0.05,
          ir: 1,
          turnover: 0,
          decayCurve: [],
          groupReturns: [],
          sampleSize: input.values.length,
          latencyMs: 0,
          statisticalReport: { status: "passed" },
        };
      },
    });
    const values = Array.from({ length: 10 }, (_, index) => ({
      symbol: `S${index % 3}`,
      date: `2025-01-${String(index + 1).padStart(2, "0")}`,
      value: index,
    }));
    try {
      const result = await internal.evaluateIndependentHoldout({
        factorId: "factor-holdout",
        universe: "US",
        values,
        mainFutures: values,
        byHorizon: { 2: values },
        horizon: 2,
        input: {
          factorId: "factor-holdout",
          startDate: "2025-01-01",
          endDate: "2025-01-10",
          validationStartDate: "2025-01-07",
        },
      });
      expect(result.split.trainLabelEndExclusive).toBe("2025-01-05");
      expect(receivedDates[0]).toEqual(["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04"]);
      expect(receivedDates[1]).toEqual(["2025-01-07", "2025-01-08", "2025-01-09", "2025-01-10"]);
      expect(result.status).toBe("passed");
    } finally {
      internal.resolveEval = originalResolveEval;
    }
  });

  test("register: 写库 + status=draft + 默认 provider 解析", async () => {
    const rec = await factorService.register({
      projectId,
      name: `mom_20_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close / Ref(close, 20) - 1",
      lang: "python",
      universe: "CN-A:hs300",
      horizon: 5,
    });
    expect(rec.id).toBeTruthy();
    expect(rec.status).toBe("draft");
    expect(rec.providerKey).toBe("python_inline");
    expect(rec.universe).toBe("CN-A:hs300");
  });

  test("register: 重名抛 duplicate_name", async () => {
    const name = `mom_dup_${randomUUID().slice(0, 6)}`;
    await factorService.register({
      projectId,
      name,
      category: "momentum",
      expr: "close",
    });
    await expect(
      factorService.register({
        projectId,
        name,
        category: "momentum",
        expr: "close",
      })
    ).rejects.toBeInstanceOf(FactorServiceError);
  });

  test("register: 含 banned token → 警告进 definition_json，注册仍成功", async () => {
    const rec = await factorService.register({
      projectId,
      name: `banned_${randomUUID().slice(0, 6)}`,
      category: "value",
      expr: "import os; close",
      lang: "python",
    });
    expect(rec.definition.providerValidationWarning).toBeDefined();
  });

  test("list: 按 category 过滤", async () => {
    const list = await factorService.list({ projectId, category: "momentum" });
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) expect(f.category).toBe("momentum");
  });

  /**
   * 研究产出侧栏契约：workflow_run_id 全局唯一，前端只用 workflowRunId 过滤
   * 就该拿到该 workflow 跨 project 的所有因子（实际场景是一个 workflow 必然
   * 在一个 project 下，但前端 UI 锁定的 projectId 可能与该 workflow 实际
   * project_id 不一致 —— 此时仍应正确返回）。
   *
   * 反例：若 service 在 workflowRunId 非空时仍强卡 projectId，研究产出侧栏
   * 切到任意非 "默认 project" 下的 workflow 都会得到空结果（即 round8/9 评测
   * 工作流"产物显示为 0"的根因）。
   */
  test("list: 仅传 workflowRunId（无 projectId）也能拿到该 workflow 跨 project 的因子", async () => {
    const db = await getDb();
    const otherProjectId = randomUUID();
    const existingProject = (await db.select().from(schema.project).limit(1))[0];
    if (!existingProject) throw new Error("factor_service_test_project_missing");
    await db.insert(schema.project).values({
      id: otherProjectId,
      workspaceId: existingProject.workspaceId,
      name: `fs-other-${randomUUID().slice(0, 6)}`,
      marketScope: "CN-A",
      status: "active",
    });
    const wfid = randomUUID();
    const recA = await factorService.register({
      projectId,
      name: `wf_only_a_${randomUUID().slice(0, 6)}`,
      category: "value",
      expr: "close",
      workflowRunId: wfid,
    });
    const recB = await factorService.register({
      projectId: otherProjectId,
      name: `wf_only_b_${randomUUID().slice(0, 6)}`,
      category: "value",
      expr: "close",
      workflowRunId: wfid,
    });
    const onlyByWorkflow = await factorService.list({ workflowRunId: wfid });
    const gotIds = onlyByWorkflow.map((f) => f.id).sort();
    expect(gotIds).toContain(recA.id);
    expect(gotIds).toContain(recB.id);
    // 不应混入其他 workflow / null 的存量因子
    expect(onlyByWorkflow.every((f) => f.workflowRunId === wfid)).toBe(true);
  });

  test("setStatus → active", async () => {
    const rec = await factorService.register({
      projectId,
      name: `q_${randomUUID().slice(0, 6)}`,
      category: "quality",
      expr: "close",
    });
    await factorService.setStatus(rec.id, "active");
    const fresh = await factorService.get(rec.id);
    expect(fresh.status).toBe("active");
  });

  test("research contract + frozen HAC evaluation are both required for strategy admission", async () => {
    const expr = "close / Ref(close, 20) - 1";
    const rec = await factorService.register({
      projectId,
      name: `admission_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr,
      lang: "qlib_expr",
      definition: { researchContract: researchContract(expr) },
    });
    expect(rec.researchContract?.version).toBe("factor-research-contract-v1");

    const db = await getDb();
    await db.insert(schema.factorEvaluation).values({
      id: randomUUID(),
      factorId: rec.id,
      asof: "2026-06-30",
      universe: "US",
      datasetSnapshotId: "snapshot-admission-v1",
      ic: 0.04,
      rankIc: 0.05,
      ir: 0.4,
      sampleSize: 120,
      latencyMs: 1,
      statisticalReportJson: {
        version: "factor-statistical-validation-v1",
        dailyObservations: 120,
        status: "passed",
      } as never,
    });
    expect(await factorService.assessStrategyEligibility([rec.id])).toEqual([
      expect.objectContaining({
        factorId: rec.id,
        eligible: true,
        datasetSnapshotId: "snapshot-admission-v1",
      }),
    ]);

    const legacy = await factorService.register({
      projectId,
      name: `admission_legacy_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr,
      lang: "qlib_expr",
    });
    const [legacyAssessment] = await factorService.assessStrategyEligibility([legacy.id]);
    expect(legacyAssessment?.eligible).toBe(false);
    expect(legacyAssessment?.reasons).toContain("factor_research_contract_missing_or_invalid");
    expect(legacyAssessment?.reasons).toContain("factor_evaluation_missing");
  });

  test("strategy admission selects the matching frozen snapshot instead of a newer unrelated evaluation", async () => {
    const expr = "close / Ref(close, 10) - 1";
    const rec = await factorService.register({
      projectId,
      name: `admission_snapshot_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr,
      lang: "qlib_expr",
      definition: { researchContract: researchContract(expr) },
    });
    const db = await getDb();
    for (const [snapshotId, status] of [
      ["snapshot-matching", "passed"],
      ["snapshot-newer-but-failed", "research_only"],
    ] as const) {
      await db.insert(schema.factorEvaluation).values({
        id: randomUUID(),
        factorId: rec.id,
        asof: "2026-07-01",
        universe: "US",
        datasetSnapshotId: snapshotId,
        sampleSize: 120,
        latencyMs: 1,
        statisticalReportJson: {
          version: "factor-statistical-validation-v1",
          dailyObservations: 120,
          status,
        } as never,
      });
    }
    const [assessment] = await factorService.assessStrategyEligibility([rec.id], {
      datasetSnapshotId: "snapshot-matching",
    });
    expect(assessment).toMatchObject({
      eligible: true,
      datasetSnapshotId: "snapshot-matching",
    });
  });

  test("rejects a research contract whose formula differs from the executable expression", async () => {
    await expect(
      factorService.register({
        projectId,
        name: `contract_mismatch_${randomUUID().slice(0, 6)}`,
        category: "momentum",
        expr: "close / Ref(close, 20) - 1",
        lang: "qlib_expr",
        definition: { researchContract: researchContract("close / Ref(close, 5) - 1") },
      })
    ).rejects.toThrow(/factor_research_contract_expression_mismatch/);
  });

  test("contract can be attached after discovery, but activation requires frozen statistical evidence", async () => {
    const expr = "close / Ref(close, 15) - 1";
    const rec = await factorService.register({
      projectId,
      name: `activate_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr,
      lang: "qlib_expr",
    });
    const withContract = await factorService.setResearchContract(rec.id, researchContract(expr));
    expect(withContract.researchContract?.formula.expression).toBe(expr);
    await expect(factorService.activate(rec.id)).rejects.toThrow(/factor_evaluation_missing/);

    const db = await getDb();
    await db.insert(schema.factorEvaluation).values({
      id: randomUUID(),
      factorId: rec.id,
      asof: "2026-06-30",
      universe: "US",
      datasetSnapshotId: "snapshot-activation-v1",
      sampleSize: 120,
      latencyMs: 1,
      statisticalReportJson: {
        version: "factor-statistical-validation-v1",
        dailyObservations: 120,
        status: "passed",
      } as never,
    });
    expect((await factorService.activate(rec.id)).status).toBe("active");
  });

  test("evaluate: 跑 builtin factor_eval Provider 写入 factor_evaluation", async () => {
    const rec = await factorService.register({
      projectId,
      name: `eval_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const values = Array.from({ length: 6 }, (_, i) => ({
      symbol: `S${i}`,
      date: "2026-05-01",
      value: i * 0.1,
    }));
    const future = values.map((v) => ({ ...v, value: (v.value ?? 0) * 0.6 + 0.01 }));
    const result = await factorService.evaluate({
      factorId: rec.id,
      values,
      futureReturns: future,
      datasetSnapshotId: "snapshot-eval-v1",
    });
    expect(result.evaluationId).toBeTruthy();
    expect(result.ic).toBeGreaterThan(0.9);
    expect(result.sampleSize).toBe(6);

    const logs = await factorService.listEvaluations(rec.id);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.factorId).toBe(rec.id);
    expect(logs[0]?.datasetSnapshotId).toBe("snapshot-eval-v1");
    expect(logs[0]?.statisticalReportJson).toMatchObject({
      version: "factor-statistical-validation-v2",
      dailyObservations: 1,
      status: "research_only",
    });
    const metric = await factorService.getLatestEvaluationMetric(
      [rec.id],
      "rankIc",
      "snapshot-eval-v1"
    );
    expect(metric.get(rec.id)).toBeGreaterThan(0.9);
    expect(
      await factorService.getLatestEvaluationMetric([rec.id], "rankIc", "snapshot-missing")
    ).toEqual(new Map());
  });

  test("compute: python_inline fallback 返回空 rows 但不抛错", async () => {
    const rec = await factorService.register({
      projectId,
      name: `compute_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close - Ref(close, 5)",
    });
    const res = await factorService.compute({
      factorId: rec.id,
      startDate: "2026-01-01",
      endDate: "2026-05-01",
      symbols: ["TEST"],
    });
    expect(res.meta.factorId).toBe(rec.id);
    expect(Array.isArray(res.rows)).toBe(true);
  });

  test("compute: 绑定快照时 qlib_expr 只消费快照数据并返回数据谱系", async () => {
    const rec = await factorService.register({
      projectId,
      name: `snapshot_compute_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close - Ref(close, 1)",
      lang: "qlib_expr",
      universe: "US",
    });
    const record = buildMarketSnapshotRecord({
      asOf: "2026-01-31T00:00:00.000Z",
      purpose: "backtest",
      instruments: [{ symbol: "AAA", venue: "US", assetClass: "equity" }],
      window: { start: "2026-01-01", end: "2026-01-31" },
      sources: [{ provider: "fixture", feed: "fixture", upstreamFamily: "fixture" }],
      barsByInstrument: {
        "US:AAA": [
          {
            timestamp: "2026-01-02T00:00:00.000Z",
            open: 100,
            high: 102,
            low: 99,
            close: 101,
            volume: 1000,
            turnover: 101000,
          },
          {
            timestamp: "2026-01-03T00:00:00.000Z",
            open: 101,
            high: 104,
            low: 100,
            close: 103,
            volume: 1100,
            turnover: 113300,
          },
        ],
      },
      timeframe: "1d",
      limit: 2,
    });
    const root = join(defaultDataDir(), "market-snapshots");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, `${record.snapshot.snapshotId}.json`),
      JSON.stringify(record),
      "utf8"
    );

    const result = await factorService.compute({
      factorId: rec.id,
      symbols: ["AAA"],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      datasetSnapshotId: record.snapshot.snapshotId,
    });

    expect(result.meta.datasetSnapshotId).toBe(record.snapshot.snapshotId);
    expect(result.meta.sourceIds).toEqual(["fixture"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.value).toBe(2);
    const persisted = await factorService.loadValues({
      factorId: rec.id,
      datasetSnapshotId: record.snapshot.snapshotId,
    });
    expect(persisted).toEqual(result.rows);
    // Snapshot values never leak into the unversioned compatibility table.
    expect(await factorService.loadValues({ factorId: rec.id })).toHaveLength(0);
  });

  test("loadValues + valuesStats：手工 upsert 后能查回", async () => {
    const rec = await factorService.register({
      projectId,
      name: `store_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
      lang: "qlib_expr",
    });
    // 通过底层 store 写入（模拟 compute 已发生）
    const { factorValueStore } = await import("../factor-value-store");
    await factorValueStore.upsert({
      factorId: rec.id,
      rows: [
        { symbol: "AAA", date: "2026-04-01", value: 1.1 },
        { symbol: "AAA", date: "2026-04-02", value: 1.2 },
        { symbol: "BBB", date: "2026-04-01", value: 2.1 },
      ],
    });

    const all = await factorService.loadValues({ factorId: rec.id });
    expect(all.length).toBe(3);

    const aaaOnly = await factorService.loadValues({ factorId: rec.id, symbols: ["AAA"] });
    expect(aaaOnly.length).toBe(2);
    expect(aaaOnly.every((r) => r.symbol === "AAA")).toBe(true);

    const stats = await factorService.valuesStats(rec.id);
    expect(stats.rowCount).toBe(3);
    expect(stats.symbolCount).toBe(2);
    expect(stats.minDate).toBe("2026-04-01");
    expect(stats.maxDate).toBe("2026-04-02");
  });

  test("lang=qlib_expr 默认 providerKey=qlib_expr", async () => {
    const rec = await factorService.register({
      projectId,
      name: `qlib_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "Mean(close, 20)",
      lang: "qlib_expr",
    });
    expect(rec.lang).toBe("qlib_expr");
    expect(rec.providerKey).toBe("qlib_expr");
  });

  // ─── P0-2: dry-run 闸门 ────────────────────────────────────────────────────

  test("dry-run pass: 正常 qlib_expr 表达式注册成功，definition.dryRun.ok=true", async () => {
    const rec = await factorService.register({
      projectId,
      name: `dr_pass_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close / Ref(close, 20) - 1",
      lang: "qlib_expr",
      dryRun: true,
    });
    expect(rec.id).toBeTruthy();
    const dr = rec.definition.dryRun as Record<string, unknown> | undefined;
    expect(dr).toBeTruthy();
    expect(dr?.ok).toBe(true);
    expect(typeof dr?.sampleSize).toBe("number");
  });

  test("dry-run reject: 语法错的表达式被拒（不入库）", async () => {
    const name = `dr_synerr_${randomUUID().slice(0, 6)}`;
    await expect(
      factorService.register({
        projectId,
        name,
        category: "momentum",
        expr: "close +",
        lang: "qlib_expr",
        dryRun: true,
      })
    ).rejects.toThrow(/dry_run_failed: parse_error/);
    const after = await factorService.list({ projectId });
    expect(after.some((f) => f.name === name)).toBe(false);
  });

  test("dry-run reject: 表达式退化为常数 → degenerate_constant 被拒", async () => {
    // close / close == 1，恒为常数
    await expect(
      factorService.register({
        projectId,
        name: `dr_const_${randomUUID().slice(0, 6)}`,
        category: "momentum",
        expr: "close / close",
        lang: "qlib_expr",
        dryRun: true,
      })
    ).rejects.toThrow(/dry_run_failed: degenerate_constant/);
  });

  /**
   * P3-1：lang=python 现在也走完整 dry-run（spawn code_sandbox_runner.py）。
   *
   * 测试环境的 python3 通常没 pandas/numpy，sandbox 会返回
   * `python_unavailable` / `python_deps_missing` —— 此时我们 graceful skip
   * 而不是 reject，因为「sandbox 系统级故障」≠「LLM 写错因子」。
   * 详细见 factor-service.ts:runPythonExprDryRun 的注释。
   */
  test("dry-run lang=python：sandbox 不可用时 graceful skip（不阻塞注册），detail 写明原因", async () => {
    const rec = await factorService.register({
      projectId,
      name: `dr_py_skip_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      /** Python 合约要求每根 bar 对应一个值，因此显式构造 20 日动量序列。 */
      expr: "factor_values = [None if i < 20 else close[i] / close[i - 20] - 1 for i in range(len(close))]",
      lang: "python",
      dryRun: true,
    });
    const dr = rec.definition.dryRun as Record<string, unknown> | undefined;
    /**
     * 两种合法结果：
     *   (a) sandbox 不可用（开发机 / CI）→ skipped=true + reason=sandbox_unavailable:*
     *   (b) sandbox 可用 + 通过 4 项检查 → pythonSandbox=true + sampleSize > 0
     * 任一即可；test 关心的是「不阻塞注册 + 给出可审计 reason」。
     */
    expect(dr).toBeDefined();
    const skipped = dr?.skipped === true;
    const sandboxRan = dr?.pythonSandbox === true;
    expect(skipped || sandboxRan).toBe(true);
    if (skipped) {
      expect(String(dr?.reason ?? "")).toMatch(/sandbox_unavailable/);
    }
    if (sandboxRan) {
      expect(typeof dr?.sampleSize).toBe("number");
      expect(Number(dr?.sampleSize)).toBeGreaterThanOrEqual(10);
    }
  });

  test("dry-run lang=python：未传 dryRun=false 时绕过整个 dry-run 闸门（旧 caller 不破）", async () => {
    /** dryRun: false 时不调 runPythonExprDryRun，避开测试环境 sandbox 缺失噪音 */
    const rec = await factorService.register({
      projectId,
      name: `dr_py_off_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
      lang: "python",
      dryRun: false,
    });
    expect(rec.definition.dryRun).toBeUndefined();
  });

  test("dry-run lang=sql / jsonlogic：保持 lang_unsupported skip（P3-1 范围只覆盖 python）", async () => {
    const rec = await factorService.register({
      projectId,
      name: `dr_sql_skip_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "SELECT close FROM bars",
      lang: "sql",
      dryRun: true,
    });
    const dr = rec.definition.dryRun as Record<string, unknown> | undefined;
    expect(dr?.skipped).toBe(true);
    expect(String(dr?.reason ?? "")).toContain("lang_unsupported");
  });
});
