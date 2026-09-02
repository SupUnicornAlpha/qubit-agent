import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { dateToTradingDay } from "../attribution/time-util";
import { createFinalHoldoutContract } from "../backtest/final-holdout-contract";
import { paperEvaluationService } from "../effect-validation/paper-evaluation-service";
import { shadowEvaluationService } from "../effect-validation/shadow-evaluation-service";
import { strategyPromotionService } from "../effect-validation/strategy-promotion-service";
import { processExecutionTasks } from "../execution/execution-worker";
import {
  approveRiskReviewTicket,
  createOrderIntentWithExecution,
} from "../execution/order-intent-service";
import { setTradingModuleEnabled } from "../trader/trading-module-control";
import { evaluateSignalCode } from "./signal-evaluator";
import { appendStrategyRuntimeLog } from "./strategy-runtime-log";
import {
  createStrategyRuntime,
  startStrategyRuntime,
  stopStrategyRuntime,
  submitRuntimeOrder,
} from "./strategy-runtime-service";

const liveCalendarRelease = {
  schemaVersion: 1 as const,
  sourceKind: "official_exchange" as const,
  source: "test-exchange-calendar",
  version: "test-us-calendar-v1",
  venue: "US",
  timezone: "America/New_York",
  retrievedAt: "2024-01-01T00:00:00.000Z",
  effectiveFrom: "2024-01-01",
  effectiveThrough: "2030-12-31",
  sessions: { [dateToTradingDay(new Date(), "US")]: "open" as const },
};

const liveAccountRisk = {
  currency: "USD" as const,
  minAvailableCashUsd: 1_000,
  maxGrossNotionalUsd: 10_000,
  maxSymbolNotionalUsd: 5_000,
  maxOpenPositions: 3,
};

async function seedBase(db: ReturnType<typeof drizzle>) {
  const wid = randomUUID();
  const pid = randomUUID();
  const wrid = randomUUID();
  const sid = randomUUID();
  const svid = randomUUID();
  const iid = randomUUID();
  const sessionId = randomUUID();
  const scriptId = randomUUID();
  const sandboxPolicyId = randomUUID();
  const definitionId = randomUUID();

  await db.insert(schema.workspace).values({ id: wid, name: "w", owner: "t" });
  await db.insert(schema.project).values({
    id: pid,
    workspaceId: wid,
    name: "p",
    marketScope: "US",
    status: "active",
  });
  await db.insert(schema.workflowRun).values({
    id: wrid,
    projectId: pid,
    goal: "t",
    mode: "simulation",
    source: "api",
    status: "running",
  });
  await db.insert(schema.sandboxPolicy).values({ id: sandboxPolicyId, name: "test-policy" });
  await db.insert(schema.agentDefinition).values({
    id: definitionId,
    role: "research",
    name: "test-research-agent",
    version: "test-agent-v1",
    systemPrompt: "Use only audited evidence.",
    llmProvider: "test-provider",
    sandboxPolicyId,
  });
  await db.insert(schema.agentInstance).values({
    id: randomUUID(),
    definitionId,
    workflowRunId: wrid,
    status: "idle",
  });
  await db.insert(schema.chatSession).values({
    id: sessionId,
    workspaceId: wid,
    projectId: pid,
    title: "s",
    status: "active",
  });
  await db.insert(schema.strategy).values({
    id: sid,
    projectId: pid,
    name: "s",
    style: "low_freq",
    description: "",
  });
  await db.insert(schema.strategyVersion).values({
    id: svid,
    strategyId: sid,
    versionTag: "v1",
    logicHash: "x",
    paramSchemaJson: {},
  });
  await db.insert(schema.instrument).values({
    id: iid,
    symbol: "TEST",
    assetClass: "stock",
    exchange: "US",
    metaJson: {},
  });
  await db.insert(schema.riskRule).values({
    id: randomUUID(),
    projectId: pid,
    name: "cap",
    scope: "pre_trade",
    ruleExpr: JSON.stringify({ kind: "max_notional", max: 1_000_000 }),
    severity: "block",
    enabled: true,
    version: 1,
  });
  await db.insert(schema.indicatorStrategyScript).values({
    id: scriptId,
    sessionId,
    workflowRunId: wrid,
    name: "sma",
    ideCode: "",
    signalCode: `
buy = [False] * len(closes)
sell = [False] * len(closes)
if len(closes) >= 2 and closes[-1] > closes[-2]:
    buy[-1] = True
`,
    purpose: "both",
  });

  return { pid, wrid, svid, iid, scriptId, definitionId };
}

describe("strategy runtime", () => {
  test("evaluateSignalCode detects buy on rising close", async () => {
    const bars = [
      {
        symbol: "TEST",
        exchange: "US",
        timestamp: "2024-01-01",
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 100,
        turnover: 0,
      },
      {
        symbol: "TEST",
        exchange: "US",
        timestamp: "2024-01-02",
        open: 10,
        high: 12,
        low: 10,
        close: 11,
        volume: 100,
        turnover: 0,
      },
    ];
    const code = `
buy = [False] * len(closes)
sell = [False] * len(closes)
if len(closes) >= 2 and closes[-1] > closes[-2]:
    buy[-1] = True
`;
    const sig = await evaluateSignalCode(code, bars);
    expect(sig.buy).toBe(true);
    expect(sig.sell).toBe(false);
  });

  test("create runtime and unified execution pipeline", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../db/sqlite/migrations"
    );
    await migrate(db, { migrationsFolder });

    const { pid, scriptId, wrid, svid, iid, definitionId } = await seedBase(db);

    const runtime = await createStrategyRuntime(
      {
        strategyScriptId: scriptId,
        market: "US",
        symbol: "TEST",
        timeframe: "1d",
        executionMode: "paper",
        autoStart: false,
        params: { orderQty: 5 },
      },
      db
    );

    expect(runtime.status).toBe("stopped");
    for (let day = 1; day <= 20; day++) {
      await db.insert(schema.strategyPnlSnapshot).values({
        id: randomUUID(),
        strategyRuntimeId: runtime.id,
        tradingDay: `2024-01-${String(day).padStart(2, "0")}`,
        symbol: "TEST",
        realizedPnlDaily: 10,
        unrealizedPnlDaily: 0,
        feeDaily: 1,
        turnoverDaily: 100,
        source: "test",
      });
    }
    const paper = await paperEvaluationService.evaluate(runtime.id, db);
    expect(paper.tradingDays).toBe(20);
    expect(paper.netPnl).toBe(180);
    expect(paper.executionQuality).toMatchObject({
      orderCount: 0,
      filledOrderCount: 0,
      rejectedOrderCount: 0,
    });
    expect(paper.executionQualityAssessment).toMatchObject({
      status: "not_configured",
      pass: null,
    });
    expect(paper.pass).toBe(true);
    const paperAgain = await paperEvaluationService.evaluate(runtime.id, db);
    expect(paperAgain.id).toBe(paper.id);

    const liveBrokerAccountId = randomUUID();
    await db.insert(schema.brokerAccount).values({
      id: liveBrokerAccountId,
      provider: "futu",
      accountRef: "live-test",
      mode: "live",
      enabled: true,
      providerConfigJson: { market: "US" },
    });
    await db
      .update(schema.strategyRuntime)
      .set({ executionMode: "live", brokerAccountId: liveBrokerAccountId })
      .where(eq(schema.strategyRuntime.id, runtime.id));
    await expect(startStrategyRuntime(runtime.id, db)).rejects.toThrow(
      /live_runtime_evidence_missing/
    );
    await db
      .update(schema.strategyRuntime)
      .set({
        paramsJson: {
          orderQty: 5,
          thesisId: "thesis_runtime_test",
          snapshotId: "snapshot_validation_fixture",
          liveGuardrails: {
            schemaVersion: 2,
            allowedSymbols: ["TEST"],
            maxOrderNotionalUsd: 1_000,
            maxDailyNotionalUsd: 5_000,
            maxOrdersPerDay: 1,
            maxDailyLossUsd: 250,
            requireHumanConfirmation: true,
            accountRisk: liveAccountRisk,
          },
        },
      })
      .where(eq(schema.strategyRuntime.id, runtime.id));
    await expect(startStrategyRuntime(runtime.id, db)).rejects.toThrow(
      /live_runtime_calendar_release_missing/
    );
    await db
      .update(schema.strategyRuntime)
      .set({
        paramsJson: {
          orderQty: 5,
          thesisId: "thesis_runtime_test",
          snapshotId: "snapshot_validation_fixture",
          liveGuardrails: {
            schemaVersion: 2,
            allowedSymbols: ["TEST"],
            maxOrderNotionalUsd: 1_000,
            maxDailyNotionalUsd: 5_000,
            maxOrdersPerDay: 1,
            maxDailyLossUsd: 250,
            requireHumanConfirmation: true,
            accountRisk: liveAccountRisk,
          },
          calendarRelease: liveCalendarRelease,
        },
      })
      .where(eq(schema.strategyRuntime.id, runtime.id));
    await expect(startStrategyRuntime(runtime.id, db)).rejects.toThrow(
      /live_promotion_gate_blocked/
    );
    const comparisonCohort = { id: "strategy_cohort_0123456789abcdef01234567" };
    const backtestRunId = randomUUID();
    const datasetSnapshotId = "snapshot_validation_fixture";
    await db.insert(schema.backtestRun).values({
      id: backtestRunId,
      strategyVersionId: paper.strategyVersionId,
      connectorInstanceId: "test",
      datasetSnapshotId,
      configJson: {},
      status: "completed",
    });
    for (const evalKind of ["backtest", "walk_forward"] as const) {
      await db.insert(schema.strategyEvalRun).values({
        id: randomUUID(),
        workflowRunId: wrid,
        projectId: pid,
        strategyVersionId: paper.strategyVersionId,
        evalKind,
        ...(evalKind === "backtest" ? { backtestRunId } : {}),
        metricsJson:
          evalKind === "backtest"
            ? {
                datasetQualification: {
                  useClass: "strategy_validation",
                  universeHistory: "verified",
                  corporateActions: "verified",
                  pointInTime: "verified",
                },
                antiLeakageReport: { status: "passed" },
                pitReport: { pass: true, verdict: "point_in_time_clean" },
                statisticalValidationReport: { status: "passed" },
                datasetSnapshotId,
                comparisonCohort,
              }
            : { comparisonCohort },
        pass: true,
      });
    }
    await db.insert(schema.strategyEvalRun).values({
      id: randomUUID(),
      workflowRunId: wrid,
      projectId: pid,
      strategyVersionId: paper.strategyVersionId,
      evalKind: "paper",
      metricsJson: { comparisonCohort },
      pass: true,
    });
    await expect(strategyPromotionService.approveRuntime(runtime.id, "tester", db)).rejects.toThrow(
      "finalHoldout"
    );
    await db.insert(schema.strategyEvalRun).values({
      id: randomUUID(),
      workflowRunId: wrid,
      projectId: pid,
      strategyVersionId: paper.strategyVersionId,
      backtestRunId,
      evalKind: "holdout",
      metricsJson: {
        contract: createFinalHoldoutContract({
          strategyVersionId: paper.strategyVersionId,
          datasetSnapshotId,
          trainEnd: "2026-01-31",
          holdoutStart: "2026-02-06",
          holdoutEnd: "2026-02-28",
          purgeDays: 5,
          embargoDays: 5,
        }),
      },
      pass: true,
    });
    await expect(
      strategyPromotionService.assertStrategyVersionLiveEligible(paper.strategyVersionId, db)
    ).rejects.toThrow("live_promotion_gate_blocked");
    const approved = await strategyPromotionService.approveRuntime(runtime.id, "tester", db);
    expect(approved.liveEligible).toBe(true);
    await strategyPromotionService.assertStrategyVersionLiveEligible(paper.strategyVersionId, db);
    await startStrategyRuntime(runtime.id, db);
    const runningLive = await db
      .select()
      .from(schema.strategyRuntime)
      .where(eq(schema.strategyRuntime.id, runtime.id))
      .limit(1);
    expect(runningLive[0]?.status).toBe("running");
    await startStrategyRuntime(runtime.id, db);

    const previousOrderThesisGate = process.env.QUBIT_ORDER_REQUIRE_THESIS;
    const previousMarketQualityGate = process.env.QUBIT_MARKET_QUALITY_GATE;
    process.env.QUBIT_ORDER_REQUIRE_THESIS = "0";
    process.env.QUBIT_MARKET_QUALITY_GATE = "0";
    try {
      const confirmation = await createOrderIntentWithExecution(db, {
        workflowRunId: wrid,
        strategyVersionId: paper.strategyVersionId,
        instrumentId: iid,
        side: "buy",
        qty: 1,
        orderType: "limit",
        price: 100,
        timeInForce: "day",
        strategyRuntimeId: runtime.id,
        dispatchMode: "live",
        brokerAccountId: liveBrokerAccountId,
        requireHumanConfirmation: true,
      });
      expect(confirmation.riskOutcome).toBe("review");
      expect(confirmation.riskReason).toBe("live_confirmation_required");
      expect(confirmation.riskReviewTicketId).toBeTruthy();
      const pendingConfirmationTask = (
        await db
          .select()
          .from(schema.executionTask)
          .where(eq(schema.executionTask.id, confirmation.executionTaskId ?? ""))
      )[0];
      expect(pendingConfirmationTask?.status).toBe("awaiting_review");
      await expect(
        createOrderIntentWithExecution(db, {
          workflowRunId: wrid,
          strategyVersionId: paper.strategyVersionId,
          instrumentId: iid,
          side: "buy",
          qty: 1,
          orderType: "limit",
          price: 100,
          timeInForce: "day",
          strategyRuntimeId: runtime.id,
          dispatchMode: "live",
          brokerAccountId: liveBrokerAccountId,
          requireHumanConfirmation: true,
        })
      ).rejects.toThrow("live_runtime_max_orders_per_day_exceeded");
      const rejectedEnvelopeAudit = (
        await db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.action, "live_runtime_guardrail_rejected"))
      )[0];
      expect(rejectedEnvelopeAudit?.resourceType).toBe("strategy_runtime");
      expect(rejectedEnvelopeAudit?.resourceId).toBe(runtime.id);
      expect((rejectedEnvelopeAudit?.detailJson as { reason?: string } | undefined)?.reason).toBe(
        "live_runtime_max_orders_per_day_exceeded"
      );
      await db
        .update(schema.strategyRuntime)
        .set({
          paramsJson: {
            orderQty: 5,
            thesisId: "thesis_runtime_test",
            snapshotId: "snapshot_validation_fixture",
            liveGuardrails: {
              schemaVersion: 2,
              allowedSymbols: ["TEST"],
              maxOrderNotionalUsd: 1_000,
              maxDailyNotionalUsd: 5_000,
              maxOrdersPerDay: 3,
              maxDailyLossUsd: 250,
              requireHumanConfirmation: true,
              accountRisk: liveAccountRisk,
            },
            calendarRelease: liveCalendarRelease,
          },
        })
        .where(eq(schema.strategyRuntime.id, runtime.id));
      await db.insert(schema.strategyPnlSnapshot).values({
        id: randomUUID(),
        strategyRuntimeId: runtime.id,
        tradingDay: dateToTradingDay(new Date(), "US"),
        symbol: "TEST",
        realizedPnlDaily: -250,
        source: "test_live_guardrail",
      });
      await expect(
        createOrderIntentWithExecution(db, {
          workflowRunId: wrid,
          strategyVersionId: paper.strategyVersionId,
          instrumentId: iid,
          side: "buy",
          qty: 1,
          orderType: "limit",
          price: 100,
          timeInForce: "day",
          strategyRuntimeId: runtime.id,
          dispatchMode: "live",
          brokerAccountId: liveBrokerAccountId,
          requireHumanConfirmation: true,
        })
      ).rejects.toThrow("live_runtime_max_daily_loss_exceeded");
      await processExecutionTasks(db);
      const stillHeldForConfirmation = (
        await db
          .select()
          .from(schema.executionTask)
          .where(eq(schema.executionTask.id, confirmation.executionTaskId ?? ""))
      )[0];
      expect(stillHeldForConfirmation?.status).toBe("awaiting_review");
      const ticketId = confirmation.riskReviewTicketId;
      if (!ticketId) throw new Error("test expected canonical live confirmation ticket");
      expect((await approveRiskReviewTicket(db, ticketId, "operator")).ok).toBe(true);
      const approvedForDispatch = (
        await db
          .select()
          .from(schema.executionTask)
          .where(eq(schema.executionTask.id, confirmation.executionTaskId ?? ""))
      )[0];
      expect(approvedForDispatch?.status).toBe("pending");
    } finally {
      if (previousOrderThesisGate === undefined) delete process.env.QUBIT_ORDER_REQUIRE_THESIS;
      else process.env.QUBIT_ORDER_REQUIRE_THESIS = previousOrderThesisGate;
      if (previousMarketQualityGate === undefined) delete process.env.QUBIT_MARKET_QUALITY_GATE;
      else process.env.QUBIT_MARKET_QUALITY_GATE = previousMarketQualityGate;
    }

    // A paper evaluation on the already-verified frozen cohort is the only
    // accepted source of `paper` component evidence. The model call is real
    // workflow provenance, not a client-provided assertion.
    await db.insert(schema.llmCallLog).values({
      id: randomUUID(),
      workflowRunId: wrid,
      provider: "test-provider",
      model: "test-model-v1",
      latencyMs: 1,
      status: "success",
    });
    await db
      .update(schema.strategyRuntime)
      .set({
        executionMode: "paper",
        paramsJson: { orderQty: 5, comparisonCohortId: comparisonCohort.id },
      })
      .where(eq(schema.strategyRuntime.id, runtime.id));
    const cohortPaper = await paperEvaluationService.evaluate(runtime.id, db);
    expect(cohortPaper.componentEvidenceRecorded).toBeGreaterThanOrEqual(1);
    const paperComponentRows = await db
      .select()
      .from(schema.componentEvalRun)
      .where(eq(schema.componentEvalRun.workflowRunId, wrid));
    expect(
      paperComponentRows.some(
        (row) =>
          row.componentKind === "model" &&
          row.componentId === "test-provider" &&
          row.versionId === "test-model-v1" &&
          row.evalKind === "paper" &&
          row.comparisonCohortId === comparisonCohort.id
      )
    ).toBe(true);
    expect(
      paperComponentRows.some(
        (row) =>
          row.componentKind === "prompt" &&
          row.componentId === definitionId &&
          row.versionId.startsWith("prompt_sha256_") &&
          row.evalKind === "paper"
      )
    ).toBe(true);
    expect((await paperEvaluationService.evaluate(runtime.id, db)).componentEvidenceRecorded).toBe(
      0
    );

    const created = await createOrderIntentWithExecution(db, {
      workflowRunId: wrid,
      strategyVersionId: svid,
      instrumentId: iid,
      side: "buy",
      qty: 5,
      orderType: "limit",
      price: 100,
      timeInForce: "day",
      strategyRuntimeId: runtime.id,
      signalBarTime: "2024-01-02",
      dispatchMode: "paper",
    });

    expect(created.riskOutcome).toBe("allow");
    await processExecutionTasks(db);
    const executionTaskId = created.executionTaskId;
    if (!executionTaskId) throw new Error("test expected execution task");
    const tasks = await db
      .select()
      .from(schema.executionTask)
      .where(eq(schema.executionTask.id, executionTaskId));
    expect(tasks[0]?.status).toBe("filled");

    await stopStrategyRuntime(runtime.id, db);
    const stopped = await db
      .select()
      .from(schema.strategyRuntime)
      .where(eq(schema.strategyRuntime.id, runtime.id))
      .limit(1);
    expect(stopped[0]?.status).toBe("stopped");
  });

  test("sim runtime only accepts an enabled sandbox or mock broker account", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../db/sqlite/migrations"
    );
    await migrate(db, { migrationsFolder });
    const { scriptId } = await seedBase(db);

    await expect(
      createStrategyRuntime(
        {
          strategyScriptId: scriptId,
          market: "US",
          symbol: "TEST",
          executionMode: "sim",
        },
        db
      )
    ).rejects.toThrow(/sim_execution_requires_broker_account/);

    const brokerAccountId = randomUUID();
    await db.insert(schema.brokerAccount).values({
      id: brokerAccountId,
      provider: "futu",
      accountRef: "sandbox-test",
      mode: "sandbox",
      enabled: true,
      isDefault: true,
      providerConfigJson: { market: "US" },
    });
    const runtime = await createStrategyRuntime(
      {
        strategyScriptId: scriptId,
        market: "US",
        symbol: "TEST",
        executionMode: "sim",
        brokerAccountId,
        autoStart: false,
      },
      db
    );
    expect(runtime.executionMode).toBe("sim");
    expect(runtime.brokerAccountId).toBe(brokerAccountId);

    await db
      .update(schema.brokerAccount)
      .set({ mode: "mock" })
      .where(eq(schema.brokerAccount.id, brokerAccountId));
    const autoResolved = await createStrategyRuntime(
      {
        strategyScriptId: scriptId,
        market: "US",
        symbol: "TEST",
        executionMode: "sim",
        autoStart: false,
      },
      db
    );
    expect(autoResolved.brokerAccountId).toBe(brokerAccountId);
  });

  test("shadow runtime records no executable order path", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../db/sqlite/migrations"
    );
    await migrate(db, { migrationsFolder });
    const { scriptId } = await seedBase(db);
    await setTradingModuleEnabled(false, { reason: "shadow_research_only", db });
    const runtime = await createStrategyRuntime(
      {
        strategyScriptId: scriptId,
        market: "US",
        symbol: "TEST",
        executionMode: "shadow",
      },
      db
    );

    expect(runtime.brokerAccountId).toBeNull();
    await startStrategyRuntime(runtime.id, db);
    await expect(
      submitRuntimeOrder(db, runtime, {
        side: "buy",
        qty: 1,
        price: 100,
        signalBarTime: "2024-01-02T00:00:00.000Z",
      })
    ).rejects.toThrow("shadow_runtime_does_not_submit_orders");
    expect(await db.select().from(schema.orderIntent)).toHaveLength(0);
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: runtime.id,
      level: "info",
      message: "shadow_signal_observed",
      payload: {
        barTime: "2024-01-02T00:00:00.000Z",
        side: "buy",
        executionGuarantee: "no_order_intent_no_execution_task_no_broker_request",
      },
    });
    const shadowEvaluation = await shadowEvaluationService.evaluate(runtime.id, db);
    expect(shadowEvaluation).toMatchObject({
      observedSignalCount: 1,
      buySignalCount: 1,
      orderIntentCount: 0,
      safetyStatus: "clean",
      promotionEligible: false,
      pass: null,
    });
    const [shadowRow] = await db
      .select()
      .from(schema.strategyEvalRun)
      .where(eq(schema.strategyEvalRun.id, shadowEvaluation.id));
    expect(shadowRow).toMatchObject({ evalKind: "shadow", pass: null });
  });

  test("live runtime creation requires persisted thesis evidence", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../db/sqlite/migrations"
    );
    await migrate(db, { migrationsFolder });
    const { scriptId } = await seedBase(db);

    await expect(
      createStrategyRuntime(
        {
          strategyScriptId: scriptId,
          market: "US",
          symbol: "TEST",
          executionMode: "live",
        },
        db
      )
    ).rejects.toThrow(/live_runtime_evidence_missing/);
  });
});
