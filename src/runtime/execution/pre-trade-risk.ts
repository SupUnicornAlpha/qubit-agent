import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  instrument,
  orderIntent,
  riskDecision,
  riskHitLog,
  riskRule,
  strategy,
  strategyPnlSnapshot,
  strategyPositionSnapshot,
  strategyVersion,
} from "../../db/sqlite/schema";

export type PreTradeOutcome = "allow" | "block" | "review";

export interface PreTradeEvaluationSummary {
  outcome: PreTradeOutcome;
  reason: string;
}

interface ParsedRuleExpr {
  kind: string;
  max?: number;
  maxPct?: number;
  portfolioValue?: number;
  capital?: number;
}

function signingKey(): string {
  return process.env.QUBIT_RISK_SIGNING_KEY ?? "dev-secret";
}

export function signRiskDecision(
  orderIntentId: string,
  riskRuleId: string,
  decision: string
): string {
  return createHmac("sha256", signingKey())
    .update(`${orderIntentId}:${riskRuleId}:${decision}`)
    .digest("hex");
}

export function parseRuleExpr(ruleExpr: string): ParsedRuleExpr | null {
  try {
    const j = JSON.parse(ruleExpr.trim()) as unknown;
    if (
      j &&
      typeof j === "object" &&
      j !== null &&
      "kind" in j &&
      typeof (j as ParsedRuleExpr).kind === "string"
    ) {
      return j as ParsedRuleExpr;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function readContractMultiplier(metaJson: unknown): number {
  if (!metaJson || typeof metaJson !== "object") return 1;
  const m = metaJson as Record<string, unknown>;
  const direct =
    typeof m.contract_multiplier === "number"
      ? m.contract_multiplier
      : typeof m.multiplier === "number"
        ? m.multiplier
        : null;
  if (direct !== null && Number.isFinite(direct) && direct > 0) return direct;
  return 1;
}

export function computeNotionalUsd(
  qty: number,
  price: number | null,
  multiplier: number
): number | null {
  if (!Number.isFinite(qty) || qty <= 0) return null;
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  return qty * price * multiplier;
}

function mapHitSeverity(
  ruleSeverity: "block" | "warn" | "info",
  violated: boolean
): "info" | "warn" | "block" | "critical" {
  if (!violated) return "info";
  if (ruleSeverity === "block") return "block";
  if (ruleSeverity === "warn") return "warn";
  return "info";
}

export function ruleDecisionForViolation(
  ruleSeverity: "block" | "warn" | "info",
  violated: boolean
): "allow" | "block" | "review" {
  if (!violated) return "allow";
  if (ruleSeverity === "block") return "block";
  if (ruleSeverity === "warn") return "review";
  return "allow";
}

export async function evaluatePreTradeForIntent(
  db: DbClient,
  orderIntentId: string,
  nowIso = new Date().toISOString()
): Promise<PreTradeEvaluationSummary> {
  const intents = await db
    .select()
    .from(orderIntent)
    .where(eq(orderIntent.id, orderIntentId))
    .limit(1);
  const intentRow = intents[0];
  if (!intentRow) {
    throw new Error(`order_intent not found: ${orderIntentId}`);
  }

  const versions = await db
    .select()
    .from(strategyVersion)
    .where(eq(strategyVersion.id, intentRow.strategyVersionId))
    .limit(1);
  const ver = versions[0];
  if (!ver) throw new Error(`strategy_version not found: ${intentRow.strategyVersionId}`);

  const strategies = await db
    .select()
    .from(strategy)
    .where(eq(strategy.id, ver.strategyId))
    .limit(1);
  const strat = strategies[0];
  if (!strat) throw new Error(`strategy not found: ${ver.strategyId}`);

  const projectId = strat.projectId;

  const instruments = await db
    .select()
    .from(instrument)
    .where(eq(instrument.id, intentRow.instrumentId))
    .limit(1);
  const inst = instruments[0];
  if (!inst) throw new Error(`instrument not found: ${intentRow.instrumentId}`);

  const mult = readContractMultiplier(inst.metaJson);
  const notional = computeNotionalUsd(intentRow.qty, intentRow.price, mult);
  const runtimePositions = intentRow.strategyRuntimeId
    ? await db
        .select()
        .from(strategyPositionSnapshot)
        .where(eq(strategyPositionSnapshot.strategyRuntimeId, intentRow.strategyRuntimeId))
    : [];

  const rules = await db
    .select()
    .from(riskRule)
    .where(
      and(
        eq(riskRule.projectId, projectId),
        eq(riskRule.scope, "pre_trade"),
        eq(riskRule.enabled, true)
      )
    );

  let blocked = false;
  let needsReview = false;
  const aggregateNotes: string[] = [];

  const killEnv = process.env.QUBIT_KILL_SWITCH === "1";

  for (const rule of rules) {
    const parsed = parseRuleExpr(rule.ruleExpr);
    let violated = false;
    let hitValue: number | undefined;
    let thresholdValue: number | undefined;
    let message = "";

    if (!parsed) {
      violated = true;
      message = "invalid_or_unsupported_rule_expr";
      blocked = true;
      aggregateNotes.push(`${rule.name}: ${message}`);
      await insertHitAndDecision(db, {
        orderIntentId,
        rule,
        violated,
        hitValue,
        thresholdValue,
        message,
        nowIso,
        decisionOverride: "block",
        hitSeverityOverride: "block",
      });
      continue;
    }

    if (parsed.kind === "kill_switch") {
      violated = killEnv;
      message = violated ? "kill_switch_engaged" : "kill_switch_ok";
    } else if (parsed.kind === "max_notional") {
      thresholdValue =
        typeof parsed.max === "number" && Number.isFinite(parsed.max) ? parsed.max : undefined;
      if (thresholdValue === undefined) {
        violated = true;
        message = "max_notional_missing_threshold";
      } else if (notional === null) {
        violated = false;
        message = "notional_requires_positive_qty_and_price";
      } else {
        hitValue = notional;
        violated = notional > thresholdValue;
        message = violated
          ? `notional ${notional.toFixed(2)} exceeds max ${thresholdValue}`
          : `notional ${notional.toFixed(2)} within max ${thresholdValue}`;
      }
    } else if (parsed.kind === "max_position_concentration") {
      thresholdValue = parsed.maxPct;
      const portfolioValue = parsed.portfolioValue;
      if (
        notional == null ||
        thresholdValue == null ||
        portfolioValue == null ||
        portfolioValue <= 0
      ) {
        violated = true;
        message = "max_position_concentration_invalid_inputs";
      } else {
        const existing = runtimePositions
          .filter((position) => position.symbol === (intentRow.symbol ?? inst.symbol))
          .reduce((sum, position) => sum + position.qty * (position.avgPrice ?? 0), 0);
        const projected = Math.max(
          0,
          intentRow.side === "buy" ? existing + notional : existing - notional
        );
        hitValue = projected / portfolioValue;
        violated = hitValue > thresholdValue;
        message = violated
          ? `projected concentration ${hitValue.toFixed(4)} exceeds max ${thresholdValue}`
          : `projected concentration ${hitValue.toFixed(4)} within max ${thresholdValue}`;
      }
    } else if (parsed.kind === "max_drawdown") {
      thresholdValue = parsed.max;
      const capital = parsed.capital;
      if (!intentRow.strategyRuntimeId || !capital || capital <= 0 || thresholdValue == null) {
        violated = true;
        message = "max_drawdown_invalid_inputs";
      } else {
        const snapshots = await db
          .select()
          .from(strategyPnlSnapshot)
          .where(eq(strategyPnlSnapshot.strategyRuntimeId, intentRow.strategyRuntimeId));
        hitValue = computeRuntimeDrawdown(
          snapshots.map((snapshot) => ({
            day: snapshot.tradingDay,
            pnl: snapshot.realizedPnlDaily + snapshot.unrealizedPnlDaily - snapshot.feeDaily,
          })),
          capital
        );
        violated = hitValue > thresholdValue;
        message = violated
          ? `runtime drawdown ${hitValue.toFixed(4)} exceeds max ${thresholdValue}`
          : `runtime drawdown ${hitValue.toFixed(4)} within max ${thresholdValue}`;
      }
    } else {
      message = `unknown_rule_kind:${parsed.kind}`;
      violated = false;
    }

    const decision = ruleDecisionForViolation(rule.severity, violated);

    if (decision === "block") blocked = true;
    if (decision === "review") needsReview = true;

    await insertHitAndDecision(db, {
      orderIntentId,
      rule,
      violated,
      hitValue,
      thresholdValue,
      message,
      nowIso,
    });

    if (violated && rule.severity !== "info") {
      aggregateNotes.push(`${rule.name}: ${message}`);
    }
  }

  let outcome: PreTradeOutcome = "allow";
  let reason = "all_clear";

  if (blocked) {
    outcome = "block";
    reason = aggregateNotes.length ? aggregateNotes.join("; ") : "blocked_by_rule";
  } else if (needsReview) {
    outcome = "review";
    reason = aggregateNotes.length ? aggregateNotes.join("; ") : "manual_review_required";
  }

  return { outcome, reason };
}

export function computeRuntimeDrawdown(
  observations: Array<{ day: string; pnl: number }>,
  capital: number
): number {
  const daily = new Map<string, number>();
  for (const observation of observations) {
    daily.set(observation.day, (daily.get(observation.day) ?? 0) + observation.pnl);
  }
  let equity = capital;
  let peak = capital;
  let drawdown = 0;
  for (const [, pnl] of [...daily.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return drawdown;
}

async function insertHitAndDecision(
  db: DbClient,
  input: {
    orderIntentId: string;
    rule: typeof riskRule.$inferSelect;
    violated: boolean;
    hitValue?: number;
    thresholdValue?: number;
    message: string;
    nowIso: string;
    decisionOverride?: "allow" | "block" | "review";
    hitSeverityOverride?: "info" | "warn" | "block" | "critical";
  }
): Promise<void> {
  const {
    rule,
    violated,
    hitValue,
    thresholdValue,
    message,
    nowIso,
    decisionOverride,
    hitSeverityOverride,
  } = input;

  const decision = decisionOverride ?? ruleDecisionForViolation(rule.severity, violated);

  await db.insert(riskHitLog).values({
    id: randomUUID(),
    orderIntentId: input.orderIntentId,
    riskRuleId: rule.id,
    hit: violated,
    hitValue,
    thresholdValue,
    severity: hitSeverityOverride ?? mapHitSeverity(rule.severity, violated),
    message,
    evaluatedAt: nowIso,
  });

  await db.insert(riskDecision).values({
    id: randomUUID(),
    orderIntentId: input.orderIntentId,
    riskRuleId: rule.id,
    agentInstanceId: null,
    decision,
    reason: message,
    evaluatedAt: nowIso,
    signature: signRiskDecision(input.orderIntentId, rule.id, decision),
  });
}
