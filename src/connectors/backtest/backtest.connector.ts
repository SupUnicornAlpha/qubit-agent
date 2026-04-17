import type { ConnectorMeta } from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * BacktestConnector — abstract base for backtest engine adapters.
 * Concrete implementations: BacktraderConnector, VnpyConnector, LeanConnector, etc.
 */
export abstract class BacktestConnector extends BaseConnector {
  abstract readonly meta: ConnectorMeta;

  abstract runBacktest(params: RunBacktestParams): Promise<BacktestResult>;
  abstract getStatus(runId: string): Promise<BacktestRunStatus>;
  abstract cancelRun(runId: string): Promise<void>;

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    switch (operation) {
      case "run_backtest":
        return this.runBacktest(payload as RunBacktestParams) as unknown as TOutput;
      case "get_status":
        return this.getStatus((payload as { runId: string }).runId) as unknown as TOutput;
      case "cancel_run":
        await this.cancelRun((payload as { runId: string }).runId);
        return undefined as TOutput;
      default:
        throw new Error(`BacktestConnector: unknown operation "${operation}"`);
    }
  }
}

// ─── Parameter / result types ─────────────────────────────────────────────────

export interface RunBacktestParams {
  strategyCode: string;
  strategyParams: Record<string, unknown>;
  datasetUri: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  commission: number;
  slippage: number;
  benchmarkSymbol?: string;
}

export interface BacktestResult {
  runId: string;
  status: "completed" | "failed";
  performance: BacktestPerformance;
  outputUri: string;
  completedAt: string;
}

export interface BacktestPerformance {
  totalReturn: number;
  annualReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
  calmarRatio: number;
  sortinoRatio: number;
  turnover: number;
  winRate: number;
  tradeCount: number;
  alpha: number;
  beta: number;
}

export interface BacktestRunStatus {
  runId: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  message?: string;
}
