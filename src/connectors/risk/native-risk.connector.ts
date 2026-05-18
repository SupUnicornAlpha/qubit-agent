import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { intentOrder } from "../../db/sqlite/schema";
import type {
  ConnectorMeta,
  RiskCheckRequest as ConnectorRiskCheckRequest,
  RiskCheckResponse as ConnectorRiskCheckResponse,
} from "../../types/connector";
import { loadRiskConfig } from "../../runtime/config/risk-config";
import { evaluateRiskAndVeto } from "../../runtime/risk/veto-engine";
import type { AnalystSignalValue } from "../../types/entities";
import { RiskConnector, type RiskRuleSummary } from "./risk.connector";

/**
 * Built-in risk connector: rule config + MSA veto engine + intent sign-off.
 */
export class QubitNativeRiskConnector extends RiskConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-risk",
    version: "0.1.0",
    connectorType: "risk",
    capabilities: [
      "evaluate",
      "evaluate_risk",
      "sign_intent",
      "load_rules",
      "check_risk",
      "check_concentration",
      "assess_liquidity",
    ],
    assetClasses: ["stock"],
    latencyProfile: "realtime",
    description: "Built-in pre-trade risk rules and intent approval.",
  };

  protected async onInit(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
  protected async onHealthcheck() {
    return { status: "healthy" as const, message: "qubit-risk: rule engine ready" };
  }

  async evaluate(request: ConnectorRiskCheckRequest): Promise<ConnectorRiskCheckResponse> {
    const meta = request.metadata ?? {};
    const signal = (meta["signal"] ?? meta["fusedSignal"] ?? "hold") as AnalystSignalValue;
    const confidence = Number(meta["confidence"] ?? meta["fusedConfidence"] ?? 0.5);
    const result = await evaluateRiskAndVeto({
      workflowRunId: String(meta["workflowRunId"] ?? request.orderIntentId),
      ticker: String(meta["ticker"] ?? request.instrumentId),
      fusedSignal: signal,
      fusedConfidence: confidence,
      debateConsensusScore:
        typeof meta["debateConsensusScore"] === "number"
          ? meta["debateConsensusScore"]
          : undefined,
    });
    return {
      orderIntentId: request.orderIntentId,
      decision: result.approved ? "allow" : "block",
      reason: result.reason,
      signature: randomUUID(),
      evaluatedAt: new Date().toISOString(),
    };
  }

  async loadRules(_projectId: string): Promise<RiskRuleSummary[]> {
    const cfg = await loadRiskConfig();
    return [
      {
        id: "LOW_CONFIDENCE_BLOCK",
        name: "低置信度拦截",
        scope: "pre_trade",
        severity: "block",
        enabled: true,
        version: 1,
      },
      {
        id: "VETO_THRESHOLD",
        name: `风险评分否决阈值 ${cfg.vetoThreshold}`,
        scope: "pre_trade",
        severity: "block",
        enabled: true,
        version: 1,
      },
    ];
  }

  async reloadRules(_projectId: string): Promise<void> {
    await loadRiskConfig();
  }

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (
      operation === "evaluate" ||
      operation === "evaluate_risk" ||
      operation === "check_risk"
    ) {
      return this.evaluate({
        orderIntentId: String(p.intentOrderId ?? p.orderIntentId ?? randomUUID()),
        strategyVersionId: String(p.strategyVersionId ?? ""),
        instrumentId: String(p.ticker ?? p.instrumentId ?? ""),
        side: p.side === "sell" ? "sell" : "buy",
        qty: Number(p.qty ?? p.quantity ?? 0),
        price: typeof p.price === "number" ? p.price : null,
        currentPositions: [],
        metadata: {
          workflowRunId: p.workflowRunId,
          ticker: p.ticker,
          signal: p.signal ?? p.fusedSignal,
          confidence: p.confidence ?? p.fusedConfidence,
          debateConsensusScore: p.debateConsensusScore,
        },
      }) as unknown as TOutput;
    }
    if (operation === "load_rules") {
      return this.loadRules(String(p.projectId ?? "")) as unknown as TOutput;
    }
    if (operation === "sign_intent") {
      const intentOrderId = String(p.intentOrderId ?? "");
      const approved = p.approved !== false;
      if (!intentOrderId) throw new Error("sign_intent: intentOrderId is required");
      const db = await getDb();
      await db
        .update(intentOrder)
        .set({
          status: approved ? "approved" : "rejected",
          riskApprovedAt: approved ? new Date().toISOString() : null,
        })
        .where(eq(intentOrder.id, intentOrderId));
      return { intentOrderId, status: approved ? "approved" : "rejected" } as unknown as TOutput;
    }
    if (operation === "check_concentration") {
      const positions = Array.isArray(p.positions) ? (p.positions as Array<{ weight?: number }>) : [];
      const maxWeight = positions.reduce((m, x) => Math.max(m, Number(x.weight ?? 0)), 0);
      const limit = Number(p.maxSingleWeight ?? 0.25);
      return {
        passed: maxWeight <= limit,
        maxWeight,
        limit,
        message:
          maxWeight > limit
            ? `单标的权重 ${(maxWeight * 100).toFixed(1)}% 超过上限 ${(limit * 100).toFixed(0)}%`
            : "集中度检查通过",
      } as unknown as TOutput;
    }
    if (operation === "assess_liquidity") {
      const avgVolume = Number(p.avgVolume ?? p.volume ?? 0);
      const orderSize = Number(p.orderSize ?? p.quantity ?? 0);
      const ratio = avgVolume > 0 ? orderSize / avgVolume : 1;
      const maxRatio = Number(p.maxVolumeParticipation ?? 0.05);
      return {
        passed: ratio <= maxRatio,
        participationRatio: ratio,
        maxAllowed: maxRatio,
        message:
          ratio > maxRatio
            ? `订单占日均成交量 ${(ratio * 100).toFixed(2)}% 过高`
            : "流动性检查通过",
      } as unknown as TOutput;
    }
    return super.onExecute<TOutput>(operation, payload);
  }
}
