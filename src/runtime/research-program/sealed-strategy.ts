import type { Database } from "bun:sqlite";
import { assessFactorDataIntegrity } from "../factor/factor-data-integrity";
import { EventDrivenBacktestProvider } from "../provider/impls/backtest/event-driven-backtest-provider";
import type { BacktestDataset } from "../provider/types";
import type { SealedDatasetDescriptor } from "./evaluator-client";
import { evidenceDigest } from "./evidence-checksum";
import { frozenStrategyRequest } from "./strategy-types";
import {
  type StrategyValidationReceipt,
  type StrategyValidationRequest,
  strategyValidationReceiptSchema,
  strategyValidationRequestSchema,
} from "./strategy-validation-types";

export function strategyReceipt(
  request: StrategyValidationRequest,
  status: StrategyValidationReceipt["status"],
  reasonCodes: string[],
  metrics: StrategyValidationReceipt["metrics"] = {
    totalReturn: null,
    benchmarkReturn: null,
    maxDrawdown: null,
    observations: 0,
    tradeCount: 0,
  }
): StrategyValidationReceipt {
  return strategyValidationReceiptSchema.parse({
    version: "sealed-strategy-v1",
    attemptId: request.attemptId,
    protocolFingerprint: request.protocolFingerprint,
    planFingerprint: request.planFingerprint,
    strategyFingerprint: request.strategyFingerprint,
    datasetFingerprint: request.datasetFingerprint,
    policyFingerprint: request.policyFingerprint,
    status,
    metrics,
    reasonCodes,
    evaluatedAt: new Date().toISOString(),
  });
}
export async function handleSealedStrategy(
  body: string,
  db: Database,
  datasets: Map<
    string,
    { descriptor: SealedDatasetDescriptor; dataset: BacktestDataset; hasPitEvidence: boolean }
  >
) {
  let input: StrategyValidationRequest;
  try {
    input = strategyValidationRequestSchema.parse(JSON.parse(body));
  } catch {
    return Response.json({ error: "strategy_request_invalid" }, { status: 400 });
  }
  const entry = datasets.get(input.datasetId);
  if (!entry) return Response.json({ error: "sealed_dataset_not_found" }, { status: 404 });
  const policy = entry.descriptor.strategyPolicy;
  if (
    !policy ||
    evidenceDigest(policy) !== input.policyFingerprint ||
    entry.descriptor.datasetFingerprint !== input.datasetFingerprint ||
    evidenceDigest(input.recipe) !== input.strategyFingerprint
  )
    return Response.json({ error: "sealed_strategy_contract_changed" }, { status: 409 });
  // Shared content quota with factor evaluations: changing endpoint never resets exposure.
  const requestHash = evidenceDigest(input);
  const reservation = db
    .transaction(() => {
      const old = db
        .query<{ request_hash: string; receipt_json: string | null }, [string]>(
          "SELECT request_hash,receipt_json FROM sealed_evaluation WHERE id=?"
        )
        .get(input.attemptId);
      if (old)
        return old.request_hash !== requestHash
          ? { error: "idempotency_conflict" }
          : old.receipt_json
            ? { prior: old.receipt_json }
            : { error: "evaluation_in_progress" };
      if (
        db
          .query("UPDATE sealed_quota SET used=used+1 WHERE fingerprint=? AND used<allowance")
          .run(input.datasetFingerprint).changes !== 1
      )
        return { error: "sealed_evaluation_budget_exhausted" };
      db.query(
        "INSERT INTO sealed_evaluation (id,request_hash,request_json,dataset_fingerprint,status) VALUES (?,?,?,?,'running')"
      ).run(input.attemptId, requestHash, JSON.stringify(input), input.datasetFingerprint);
      return { reserved: true };
    })
    .immediate();
  if (reservation.error) return Response.json({ error: reservation.error }, { status: 409 });
  if (reservation.prior)
    return Response.json(strategyValidationReceiptSchema.parse(JSON.parse(reservation.prior)));
  let result: StrategyValidationReceipt;
  try {
    const integrity = assessFactorDataIntegrity({
      factorId: input.attemptId,
      expr: input.recipe.factor.expr,
      lang: "qlib_expr",
      providerKey: "qlib_expr",
      dataset: entry.dataset,
      startDate: entry.descriptor.startDate,
      endDate: entry.descriptor.endDate,
    });
    if (integrity.status === "failed")
      result = strategyReceipt(input, "rejected", ["data_integrity_failed"]);
    else if (!entry.hasPitEvidence || integrity.status !== "passed")
      result = strategyReceipt(input, "insufficient_evidence", ["verified_pit_evidence_required"]);
    else if (input.recipe.development.endDate >= entry.descriptor.startDate)
      result = strategyReceipt(input, "rejected", ["sealed_period_must_follow_development"]);
    else {
      const symbols = input.recipe.development.symbols;
      if (
        symbols.some((symbol) => !entry.dataset.barsBySymbol[symbol]) ||
        input.recipe.execution.topN > symbols.length
      )
        throw new Error("universe_mismatch");
      const request = {
        ...frozenStrategyRequest(
          input.strategyFingerprint,
          input.recipe,
          input.strategyFingerprint,
          "frozen"
        ),
        dataset: entry.dataset,
        startDate: entry.descriptor.startDate,
        endDate: entry.descriptor.endDate,
        captureTrace: false,
      };
      const engine = new EventDrivenBacktestProvider();
      const candidate = await engine.run(request);
      const benchmark = await engine.run({
        ...request,
        signals: { kind: "factor_score", expr: "1", lang: "qlib_expr" },
        topN: symbols.length,
        rebalance: "daily",
      });
      if (candidate.error || benchmark.error) throw new Error("execution_failed");
      const m = {
        totalReturn: candidate.metrics.totalReturn,
        benchmarkReturn: benchmark.metrics.totalReturn,
        maxDrawdown: candidate.metrics.maxDrawdown,
        observations: candidate.equityCurve.length,
        tradeCount: candidate.trades.length,
      };
      const sufficient =
        m.observations >= policy.minObservations && m.tradeCount >= policy.minTrades;
      const passed =
        sufficient &&
        m.totalReturn > 0 &&
        m.totalReturn - m.benchmarkReturn > policy.minExcessReturn &&
        m.maxDrawdown <= policy.maxDrawdown;
      result = strategyReceipt(
        input,
        !sufficient ? "insufficient_evidence" : passed ? "passed" : "rejected",
        [
          !sufficient
            ? "insufficient_observations_or_trades"
            : passed
              ? "predeclared_strategy_gate_passed"
              : "predeclared_strategy_gate_not_met",
        ],
        m
      );
    }
  } catch {
    result = strategyReceipt(input, "insufficient_evidence", ["sealed_strategy_execution_failed"]);
  }
  const update = db
    .query(
      "UPDATE sealed_evaluation SET status='completed',receipt_json=? WHERE id=? AND status='running'"
    )
    .run(JSON.stringify(result), input.attemptId);
  if (update.changes !== 1)
    return Response.json({ error: "evaluation_state_conflict" }, { status: 409 });
  return Response.json(result);
}
