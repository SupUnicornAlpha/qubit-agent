import { randomUUID } from "node:crypto";
import { getDb } from "../../db/sqlite/client";
import { riskVetoLog } from "../../db/sqlite/schema";
import { loadRiskConfig } from "../config/risk-config";
import type { AnalystSignalValue } from "../../types/entities";

export interface RiskCheckInput {
  workflowRunId: string;
  ticker: string;
  fusedSignal: AnalystSignalValue;
  fusedConfidence: number;
  debateConsensusScore?: number;
}

export interface RiskCheckResult {
  approved: boolean;
  riskScore: number;
  vetoed: boolean;
  reason: string;
  severity: "warning" | "block" | "critical";
  rulesTriggered: string[];
}

export async function evaluateRiskAndVeto(input: RiskCheckInput): Promise<RiskCheckResult> {
  const cfg = await loadRiskConfig();
  const rules: string[] = [];
  let riskScore = 0;

  // Rule 1: very low confidence should raise risk
  if (input.fusedConfidence < cfg.blockConfidenceThreshold) {
    rules.push("LOW_CONFIDENCE_BLOCK");
    riskScore += 0.5;
  } else if (input.fusedConfidence < 0.55) {
    rules.push("LOW_CONFIDENCE_WARN");
    riskScore += 0.2;
  }

  // Rule 2: hold signal is uncertain for action-taking
  if (input.fusedSignal === "hold") {
    rules.push("HOLD_SIGNAL_UNCERTAIN");
    riskScore += 0.15;
  }

  // Rule 3: weak debate consensus adds uncertainty
  if (typeof input.debateConsensusScore === "number" && input.debateConsensusScore < 0.35) {
    rules.push("WEAK_DEBATE_CONSENSUS");
    riskScore += 0.3;
  }

  // Severity mode tuning
  if (cfg.severityMode === "conservative") {
    riskScore *= 1.15;
  } else if (cfg.severityMode === "aggressive") {
    riskScore *= 0.9;
  }

  riskScore = Math.max(0, Math.min(1, riskScore));
  const vetoed = riskScore >= cfg.vetoThreshold;
  const severity: "warning" | "block" | "critical" =
    riskScore >= 0.85 ? "critical" : vetoed ? "block" : "warning";
  const reason = vetoed
    ? `风险评分 ${riskScore.toFixed(2)} 超过阈值 ${cfg.vetoThreshold.toFixed(2)}，触发一票否决`
    : `风险评分 ${riskScore.toFixed(2)} 未超过阈值 ${cfg.vetoThreshold.toFixed(2)}，允许继续`;

  if (vetoed) {
    const db = await getDb();
    await db.insert(riskVetoLog).values({
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      riskInstanceId: null,
      vetoTarget: `ticker:${input.ticker}`,
      vetoReason: reason,
      riskScore,
      riskRulesTriggeredJson: rules,
      severity,
    });
  }

  return {
    approved: !vetoed,
    riskScore,
    vetoed,
    reason,
    severity,
    rulesTriggered: rules,
  };
}
