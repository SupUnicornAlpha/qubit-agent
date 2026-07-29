/**
 * Context Protocol (docs/agent-contracts/05-context-protocol.md) — 核心类型。
 * P0：Envelope / Budget / Handoff / MemoryTier / DecisionRecord 形状；
 * WorkingMemory 类型先定义，GraphState 一等字段在 P1 接入。
 */

export type ContextProtocolVersion = "1";

export type ContextAxiomId = "A1" | "A2" | "A3" | "A4" | "A5" | "A6";

export type ContextSlotId =
  | "identity"
  | "goal"
  | "slot"
  | "working"
  | "session"
  | "recall_finance"
  | "recall_skill"
  | "recall_general"
  | "tools"
  | "control";

export type SlotCompressMode = "truncate" | "stub" | "summarize" | "omit";

export type MemoryTier = "working" | "shallow" | "intermediate" | "deep";

export interface ContextSlotBudget {
  maxChars: number;
  compress: SlotCompressMode;
  priority: number;
}

export interface ContextSlotContent {
  text: string;
  meta?: Record<string, unknown>;
}

export interface ContextEnvelope {
  version: ContextProtocolVersion;
  workflowRunId: string;
  definitionId: string;
  role: string;
  /** A6：回测/仿真 cutoff；召回过滤 asof > cutoff */
  decisionCutoff?: string;
  axiomsApplied: ContextAxiomId[];
  slots: Partial<Record<ContextSlotId, ContextSlotContent>>;
  budget: Record<ContextSlotId, ContextSlotBudget>;
  rendered?: { system: string; user: string };
}

export interface WorkingClaim {
  id: string;
  text: string;
  stance?: "bull" | "bear" | "neutral" | "unknown";
  symbols?: string[];
  evidenceRefs?: string[];
  confidence?: number;
  status: "open" | "supported" | "refuted" | "stale";
}

export interface WorkingDebate {
  bullPoints: string[];
  bearPoints: string[];
  resolution?: string;
}

export interface WorkingMemoryFinanceRefs {
  factorIds?: string[];
  compositionIds?: string[];
  evaluationIds?: string[];
  symbols?: string[];
}

export interface WorkingMemory {
  version: 1;
  hypotheses: WorkingClaim[];
  openQuestions: string[];
  decisions: string[];
  debate?: WorkingDebate;
  financeRefs: WorkingMemoryFinanceRefs;
  trailStub: Array<{ step: number; tool?: string; ok: boolean; oneLiner: string }>;
  updatedAt: string;
}

export interface DecisionRecordOutcome {
  label: "success" | "fail" | "partial" | "unknown";
  realizedReturn?: number;
  excessReturn?: number;
  brierContribution?: number;
  scoredAt: string;
}

export interface DecisionRecord {
  id: string;
  domain: "research" | "factor" | "strategy" | "trade" | "regime";
  symbols: string[];
  stance?: "bull" | "bear" | "neutral" | "hold" | "unknown";
  confidence: number;
  asof: string;
  decisionDate?: string;
  thesis: string;
  horizon?: string;
  quantAnchor?: {
    factorIds?: string[];
    compositionIds?: string[];
    evaluationIds?: string[];
  };
  sourceRunId: string;
  outcome?: DecisionRecordOutcome;
}

export interface ContextHandoffV1 {
  version: 1;
  goal: string;
  symbols?: string[];
  asof?: string;
  claims?: WorkingClaim[];
  financeRefs?: WorkingMemoryFinanceRefs;
  evidence?: {
    kind: "market_data" | "news" | "analysis" | "factor" | "none";
    verified: boolean;
    detail?: Record<string, unknown>;
  };
  debate?: WorkingDebate;
  narrative?: string;
}

/** Finance Experience 约定 subKind（05 §4.4.2） */
export const FINANCE_SUB_KINDS = [
  "factor_archive",
  "strategy_eval",
  "regime",
  "market_snapshot",
  "research_conclusion",
  "pnl_episode",
  "strategy_recipe",
  "playbook",
  "postmortem",
  "execution_profile",
] as const;

export type FinanceSubKind = (typeof FINANCE_SUB_KINDS)[number];

export function isFinanceSubKind(subKind: string): subKind is FinanceSubKind {
  return (FINANCE_SUB_KINDS as readonly string[]).includes(subKind);
}

/** 进入 recall_finance 高优池的 subKind */
export const FINANCE_RECALL_PREFER_SUB_KINDS: FinanceSubKind[] = [
  "research_conclusion",
  "factor_archive",
  "strategy_recipe",
  "regime",
  "strategy_eval",
  "playbook",
];
