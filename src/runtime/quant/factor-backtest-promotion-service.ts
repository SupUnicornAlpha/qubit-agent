import type { BacktestJobRecord } from "../backtest/backtest-job-service";
import { backtestJobService } from "../backtest/backtest-job-service";
import { factorService } from "../factor/factor-service";
import {
  type CompositionRecord,
  type StrategyVersionRecord,
  strategyComposer,
} from "../strategy/strategy-composer";

export interface FactorBacktestPromotionInput {
  projectId?: string;
  factorIds: string[];
  strategyName?: string;
  versionTag?: string;
  compositionName?: string;
  description?: string;
  symbols?: string[];
  universe?: string;
  timeframe?: string;
  startDate: string;
  endDate: string;
  /** 由 market.snapshot.get 预先冻结的回测数据。 */
  datasetSnapshotId?: string;
  capital?: number;
  costs?: { commissionBps: number; slippageBps: number; minCommission?: number };
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  providerKey?: string;
  experiment?: {
    parameterSelection: "fixed_before_run" | "full_sample_optimized" | "unknown";
    preRegistrationId?: string;
    candidateTrials?: number;
  };
  workflowRunId?: string | null;
  agentInstanceId?: string | null;
  createdBy?: string;
}

export interface FactorBacktestPromotionResult {
  strategyVersion: StrategyVersionRecord;
  composition: CompositionRecord;
  backtest: BacktestJobRecord;
  factorIds: string[];
  symbols: string[];
  universe: string;
}

const DEFAULT_SYMBOLS_BY_UNIVERSE: Record<string, string[]> = {
  "CN-A": ["600519", "000858", "300750", "601318", "600036", "000333", "601899", "601012"],
  "CN-A:hs300": ["600519", "000858", "300750", "601318", "600036", "000333", "601899", "601012"],
  "CN-A:csi500": ["600031", "600089", "600196", "600256", "600486", "600660", "000009", "000021"],
  US: ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "AVGO", "TSLA"],
  "US:sp500": ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "BRK-B", "JPM"],
};

export class FactorBacktestPromotionError extends Error {
  constructor(
    public code: "validation_failed" | "factor_project_mismatch" | "promotion_failed",
    message: string
  ) {
    super(message);
    this.name = "FactorBacktestPromotionError";
  }
}

export class FactorBacktestPromotionService {
  async promoteAndBacktest(
    input: FactorBacktestPromotionInput
  ): Promise<FactorBacktestPromotionResult> {
    const factorIds = [...new Set(input.factorIds.map((id) => id.trim()).filter(Boolean))];
    if (factorIds.length === 0) {
      throw new FactorBacktestPromotionError("validation_failed", "factor_ids_required");
    }
    if (!input.startDate || !input.endDate) {
      throw new FactorBacktestPromotionError("validation_failed", "start_date_end_date_required");
    }

    const factors = await Promise.all(factorIds.map((id) => factorService.get(id)));
    const projectId = input.projectId?.trim() || factors[0]?.projectId;
    if (!projectId) {
      throw new FactorBacktestPromotionError("validation_failed", "project_id_required");
    }
    const mismatched = factors.find((factor) => factor.projectId !== projectId);
    if (mismatched) {
      throw new FactorBacktestPromotionError(
        "factor_project_mismatch",
        `factor_project_mismatch: ${mismatched.id} belongs to ${mismatched.projectId}, expected ${projectId}`
      );
    }
    const eligibility = await factorService.assessStrategyEligibility(factorIds, {
      ...(input.datasetSnapshotId ? { datasetSnapshotId: input.datasetSnapshotId } : {}),
    });
    const rejected = eligibility.filter((item) => !item.eligible);
    if (rejected.length > 0) {
      throw new FactorBacktestPromotionError(
        "validation_failed",
        `factor_research_admission_failed: ${rejected
          .map((item) => `${item.factorId}[${item.reasons.join(",")}]`)
          .join("; ")}`
      );
    }
    if (factorIds.length > 1) {
      const correlation = await factorService.diagnoseCorrelation({
        factorIds,
        ...(input.datasetSnapshotId ? { datasetSnapshotId: input.datasetSnapshotId } : {}),
      });
      if (correlation.status !== "passed") {
        throw new FactorBacktestPromotionError(
          "validation_failed",
          `factor_correlation_admission_failed: ${correlation.reasons.join(",") || correlation.status}`
        );
      }
      const exposure = await factorService.diagnoseExposure({
        factorIds,
        ...(input.datasetSnapshotId ? { datasetSnapshotId: input.datasetSnapshotId } : {}),
      });
      if (exposure.status !== "passed") {
        throw new FactorBacktestPromotionError(
          "validation_failed",
          `factor_exposure_admission_failed: ${exposure.reasons.join(",") || exposure.status}`
        );
      }
    }

    const universe = input.universe?.trim() || factors[0]?.universe || "CN-A";
    const symbols = normalizeSymbols(input.symbols, universe);
    if (symbols.length === 0) {
      throw new FactorBacktestPromotionError(
        "validation_failed",
        `symbols_required: no symbols provided and universe ${universe} has no default sample`
      );
    }

    const workflowRunId =
      input.workflowRunId ?? factors.find((factor) => factor.workflowRunId)?.workflowRunId ?? null;
    const createdBy = input.createdBy?.trim() || "user";
    const factorLabel = factors
      .slice(0, 3)
      .map((factor) => factor.name)
      .join("+");
    const suffix = factorIds.length > 3 ? `+${factorIds.length - 3}` : "";

    const strategyVersion = await strategyComposer.createVersion({
      projectId,
      strategyName: input.strategyName?.trim() || `factor-backtest-${factorLabel}${suffix}`,
      versionTag: input.versionTag?.trim() || "v1",
      strategyStyle: "low_freq",
      workflowRunId,
      params: {
        source: "factor_backtest_promotion",
        factorIds,
        universe,
        symbols,
        timeframe: input.timeframe?.trim() || "1d",
      },
      hashSeed: `${workflowRunId ?? "manual"}:${factorIds.join(",")}:${input.startDate}:${input.endDate}`,
    });

    const composition = await strategyComposer.define({
      strategyVersionId: strategyVersion.id,
      kind: "factor_score",
      factorIds,
      weightMethod: "equal",
      rebalanceFreq: input.rebalance ?? "daily",
      universe,
      name: input.compositionName?.trim() || `Factor score · ${factorLabel}${suffix}`,
      description:
        input.description?.trim() ||
        `Auto-promoted from ${factorIds.length} factor(s) and submitted to backtest.`,
      workflowRunId,
      agentInstanceId: input.agentInstanceId ?? null,
      createdBy,
    });

    const backtest = await backtestJobService.submitAndRun({
      strategyVersionId: strategyVersion.id,
      compositionId: composition.id,
      symbols,
      universe,
      ...(input.timeframe ? { timeframe: input.timeframe } : {}),
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.datasetSnapshotId ? { datasetSnapshotId: input.datasetSnapshotId } : {}),
      ...(input.capital !== undefined ? { capital: input.capital } : {}),
      ...(input.costs ? { costs: input.costs } : {}),
      ...(input.rebalance ? { rebalance: input.rebalance } : {}),
      ...(input.topN !== undefined ? { topN: input.topN } : {}),
      ...(input.longShort !== undefined ? { longShort: input.longShort } : {}),
      ...(input.benchmark ? { benchmark: input.benchmark } : {}),
      ...(input.providerKey ? { providerKey: input.providerKey } : {}),
      ...(input.experiment ? { experiment: input.experiment } : {}),
      workflowRunId,
      agentInstanceId: input.agentInstanceId ?? null,
      createdBy,
    });

    return {
      strategyVersion,
      composition,
      backtest,
      factorIds,
      symbols,
      universe,
    };
  }
}

function normalizeSymbols(symbols: string[] | undefined, universe: string): string[] {
  const explicit = (symbols ?? []).map((symbol) => symbol.trim()).filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)];
  return DEFAULT_SYMBOLS_BY_UNIVERSE[universe] ?? [];
}

export const factorBacktestPromotionService = new FactorBacktestPromotionService();
