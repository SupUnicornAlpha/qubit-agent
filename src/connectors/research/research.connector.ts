import type { ConnectorMeta } from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * ResearchConnector — abstract base for feature engineering, factor computation,
 * and model training connectors.
 */
export abstract class ResearchConnector extends BaseConnector {
  abstract readonly meta: ConnectorMeta;

  abstract computeFactors(params: ComputeFactorsParams): Promise<FactorResult>;
  abstract runFeatureEngineering(params: FeatureEngineeringParams): Promise<FeatureResult>;
  abstract trainModel(params: TrainModelParams): Promise<ModelResult>;

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    switch (operation) {
      case "compute_factors":
        return this.computeFactors(payload as ComputeFactorsParams) as unknown as TOutput;
      case "feature_engineering":
        return this.runFeatureEngineering(payload as FeatureEngineeringParams) as unknown as TOutput;
      case "train_model":
        return this.trainModel(payload as TrainModelParams) as unknown as TOutput;
      default:
        throw new Error(`ResearchConnector: unknown operation "${operation}"`);
    }
  }
}

// ─── Parameter / result types ─────────────────────────────────────────────────

export interface ComputeFactorsParams {
  datasetUri: string;
  factorDefinitions: Array<{ name: string; expression: string }>;
  startDate: string;
  endDate: string;
}

export interface FactorResult {
  factorName: string;
  ic: number;
  icir: number;
  rankIc: number;
  outputUri: string;
  computedAt: string;
}

export interface FeatureEngineeringParams {
  datasetUri: string;
  transformations: string[];
  outputUri: string;
}

export interface FeatureResult {
  outputUri: string;
  featureCount: number;
  sampleCount: number;
  completedAt: string;
}

export interface TrainModelParams {
  featureUri: string;
  targetColumn: string;
  modelType: string;
  hyperparams: Record<string, unknown>;
  trainEndDate: string;
  validStartDate: string;
}

export interface ModelResult {
  modelUri: string;
  trainMetrics: Record<string, number>;
  validMetrics: Record<string, number>;
  trainedAt: string;
}
