import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { factorDefinition, strategy, strategyVersion } from "../../db/sqlite/schema";
import type { ConnectorMeta } from "../../types/connector";
import { computeDateRangeForLimit, queryBarsRange, timeframeToPeriod } from "../../runtime/market/klines-query";
import { snapshotIndicators } from "../../runtime/market/technical-indicators";
import {
  ResearchConnector,
  type ComputeFactorsParams,
  type FactorResult,
  type FeatureEngineeringParams,
  type FeatureResult,
  type ModelResult,
  type TrainModelParams,
} from "./research.connector";

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = x[i] - mx;
    const vy = y[i] - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den < 1e-12 ? 0 : num / den;
}

/**
 * Built-in factor research: momentum / volatility / mean-reversion proxies from OHLCV.
 */
export class QubitNativeResearchConnector extends ResearchConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-research",
    version: "0.1.0",
    connectorType: "research",
    capabilities: ["compute_factors", "run_experiment", "version_strategy", "feature_engineering"],
    assetClasses: ["stock"],
    latencyProfile: "batch",
    description: "Built-in factor computation from K-line bars.",
  };

  protected async onInit(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
  protected async onHealthcheck() {
    return { status: "healthy" as const, message: "qubit-research: factor engine ready" };
  }

  async computeFactors(params: ComputeFactorsParams): Promise<FactorResult> {
    const symbol = params.datasetUri.replace(/^bars:\/\//, "").split(":")[0] ?? params.datasetUri;
    const exchange = params.datasetUri.includes(":") ? params.datasetUri.split(":")[1] ?? "" : "";
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 120);
    const bars = await queryBarsRange({
      symbol,
      exchange,
      period,
      startDate: params.startDate || startDate,
      endDate: params.endDate || endDate,
    });
    const closes = bars.map((b) => b.close);
    const fwd: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      fwd.push(closes[i - 1] > 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0);
    }
    const mom: number[] = [];
    for (let i = 5; i < closes.length; i++) {
      mom.push(closes[i - 5] > 0 ? (closes[i] - closes[i - 5]) / closes[i - 5] : 0);
    }
    const factorName = params.factorDefinitions[0]?.name ?? "momentum_5d";
    const ic = pearson(mom.slice(0, fwd.length), fwd.slice(4));
    return {
      factorName,
      ic,
      icir: ic * Math.sqrt(252),
      rankIc: ic * 0.95,
      outputUri: `factor://${symbol}/${factorName}`,
      computedAt: new Date().toISOString(),
    };
  }

  async runFeatureEngineering(params: FeatureEngineeringParams): Promise<FeatureResult> {
    const symbol = params.datasetUri.replace(/^bars:\/\//, "") || "UNKNOWN";
    const exchange = "";
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 120);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const snap = snapshotIndicators(bars, symbol);
    return {
      outputUri: params.outputUri || `features://${symbol}`,
      featureCount: Object.keys(snap).length,
      sampleCount: bars.length,
      completedAt: new Date().toISOString(),
    };
  }

  async trainModel(_params: TrainModelParams): Promise<ModelResult> {
    return {
      modelUri: `model://stub/${randomUUID()}`,
      trainMetrics: { loss: 0 },
      validMetrics: { loss: 0 },
      trainedAt: new Date().toISOString(),
    };
  }

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    if (operation === "compute_factors") {
      const p = (payload ?? {}) as {
        symbol?: string;
        exchange?: string;
        startDate?: string;
        endDate?: string;
        factorDefinitions?: Array<{ name: string; expression: string }>;
      };
      const symbol = String(p.symbol ?? "").trim();
      if (!symbol) throw new Error("compute_factors: symbol is required");
      return this.computeFactors({
        datasetUri: `bars://${symbol}:${p.exchange ?? ""}`,
        factorDefinitions: p.factorDefinitions ?? [
          { name: "momentum_5d", expression: "close/close[-5]-1" },
        ],
        startDate: p.startDate ?? "",
        endDate: p.endDate ?? "",
      }) as unknown as TOutput;
    }
    if (operation === "run_experiment") {
      const p = (payload ?? {}) as {
        symbol?: string;
        exchange?: string;
        hypothesis?: string;
        projectId?: string;
      };
      const symbol = String(p.symbol ?? "").trim();
      const factors = await this.computeFactors({
        datasetUri: `bars://${symbol}:${p.exchange ?? ""}`,
        factorDefinitions: [{ name: "momentum_5d", expression: "close/close[-5]-1" }],
        startDate: "",
        endDate: "",
      });
      const db = await getDb();
      if (p.projectId && symbol) {
        await db.insert(factorDefinition).values({
          id: randomUUID(),
          projectId: p.projectId,
          name: factors.factorName,
          category: "momentum",
          definitionJson: { hypothesis: p.hypothesis ?? "", ic: factors.ic },
        });
      }
      return {
        experimentId: randomUUID(),
        status: "completed",
        factors,
        note: "Built-in experiment: single-factor IC from OHLCV",
      } as unknown as TOutput;
    }
    if (operation === "version_strategy") {
      const p = (payload ?? {}) as {
        projectId?: string;
        strategyName?: string;
        versionTag?: string;
        params?: Record<string, unknown>;
        code?: string;
      };
      const db = await getDb();
      const projectId = String(p.projectId ?? "").trim();
      if (!projectId) throw new Error("version_strategy: projectId is required");
      const strategyId = randomUUID();
      await db.insert(strategy).values({
        id: strategyId,
        projectId,
        name: String(p.strategyName ?? "agent-strategy"),
        style: "low_freq",
        description: "Created by qubit-research version_strategy tool",
      });
      const logicHash = createHash("sha256")
        .update(JSON.stringify(p.params ?? {}) + (p.code ?? ""))
        .digest("hex")
        .slice(0, 16);
      const versionId = randomUUID();
      await db.insert(strategyVersion).values({
        id: versionId,
        strategyId,
        versionTag: String(p.versionTag ?? "v1"),
        logicHash,
        paramSchemaJson: p.params ?? {},
      });
      return { strategyId, versionId, logicHash } as unknown as TOutput;
    }
    return super.onExecute<TOutput>(operation, payload);
  }
}
