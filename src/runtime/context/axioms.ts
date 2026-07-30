/**
 * Context Protocol 公理 A1–A6（docs/agent-contracts/05 §3.1）
 */

import type { ContextAxiomId, ContextSlotBudget, ContextSlotId } from "./types";

export const CONTEXT_AXIOMS: Record<
  ContextAxiomId,
  { title: string; summary: string }
> = {
  A1: {
    title: "结构化交接",
    summary: "Handoff 字段优先；辩论隔离，不当 finance 真相",
  },
  A2: {
    title: "分层衰减",
    summary: "MemoryTier working/shallow/intermediate/deep + 差异衰减",
  },
  A3: {
    title: "决策可后验",
    summary: "DecisionRecord：confidence + asof + outcome/Brier",
  },
  A4: {
    title: "结果加权召回",
    summary: "recall_finance 合分含 outcomeWeight",
  },
  A5: {
    title: "工具定真",
    summary: "Experience 只存 ref/摘要；计算走 ToolContract",
  },
  A6: {
    title: "防前视 PIT",
    summary: "强制 asof；decisionCutoff 硬过滤",
  },
};

/** CONTEXT_PROTOCOL_V1=0 关闭；缺省开启 */
export function isContextProtocolEnabled(): boolean {
  return process.env["CONTEXT_PROTOCOL_V1"] !== "0";
}

/** 回测/仿真建议开；缺省跟协议总闸 */
export function isPitCutoffEnabled(): boolean {
  if (process.env["CONTEXT_AXIOM_PIT"] === "0") return false;
  if (process.env["CONTEXT_AXIOM_PIT"] === "1") return true;
  return isContextProtocolEnabled();
}

export function isFinanceMemoryStrict(): boolean {
  // 缺省严格；显式 FINANCE_MEMORY_STRICT=0 关闭
  return process.env["FINANCE_MEMORY_STRICT"] !== "0";
}

/** P2：market_snapshot 默认关；FINANCE_MARKET_SNAPSHOT_WRITE=1 开启 */
export function isMarketSnapshotWriteEnabled(): boolean {
  return process.env["FINANCE_MARKET_SNAPSHOT_WRITE"] === "1";
}

/** P2：WorkingMemory LLM/规则折叠默认关；CONTEXT_WORKING_SUMMARIZE=1 开启 */
export function isWorkingMemorySummarizeEnabled(): boolean {
  return process.env["CONTEXT_WORKING_SUMMARIZE"] === "1";
}

/** 05 §4.2 默认槽位预算 */
export const DEFAULT_SLOT_BUDGETS: Record<ContextSlotId, ContextSlotBudget> = {
  identity: { maxChars: 8_000, compress: "truncate", priority: 100 },
  tools: { maxChars: 6_000, compress: "truncate", priority: 95 },
  goal: { maxChars: 2_000, compress: "truncate", priority: 90 },
  slot: { maxChars: 6_000, compress: "truncate", priority: 85 },
  recall_finance: { maxChars: 4_000, compress: "truncate", priority: 80 },
  recall_skill: { maxChars: 3_500, compress: "truncate", priority: 75 },
  working: { maxChars: 5_000, compress: "stub", priority: 70 },
  session: { maxChars: 4_000, compress: "truncate", priority: 60 },
  recall_general: { maxChars: 2_500, compress: "truncate", priority: 50 },
  control: { maxChars: 1_500, compress: "truncate", priority: 40 },
};

/** User 拼装顺序（05） */
export const USER_SLOT_ORDER: ContextSlotId[] = [
  "goal",
  "slot",
  "recall_finance",
  "recall_skill",
  "recall_general",
  "session",
  "working",
  "control",
];

export const SYSTEM_SLOT_ORDER: ContextSlotId[] = ["identity", "tools", "control"];

export function allAxioms(): ContextAxiomId[] {
  return ["A1", "A2", "A3", "A4", "A5", "A6"];
}
