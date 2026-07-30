/**
 * 按槽位预算拼装 Prompt（05 §4.2）
 */

import { truncatePromptText } from "../llm/token-budget";
import {
  DEFAULT_SLOT_BUDGETS,
  SYSTEM_SLOT_ORDER,
  USER_SLOT_ORDER,
  allAxioms,
} from "./axioms";
import { incContextMetric } from "./context-metrics";
import type {
  ContextAxiomId,
  ContextEnvelope,
  ContextSlotBudget,
  ContextSlotContent,
  ContextSlotId,
} from "./types";

export interface AssembleSlotsInput {
  workflowRunId: string;
  definitionId: string;
  role: string;
  sessionId?: string;
  turnId?: string;
  decisionCutoff?: string;
  slots: Partial<Record<ContextSlotId, string | ContextSlotContent>>;
  budget?: Partial<Record<ContextSlotId, ContextSlotBudget>>;
  /** soft budget 时按 priority 从低到高 omit */
  softOmitLowPriority?: boolean;
  /**
   * 硬上限（user 总字符）。槽裁后仍超限则按 priority omit；
   * 永不 omit goal / slot / recall_finance。
   */
  hardMaxUserChars?: number;
  axiomsApplied?: ContextAxiomId[];
}

function normalizeSlot(
  value: string | ContextSlotContent | undefined
): ContextSlotContent | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const t = value.trim();
    return t ? { text: t } : undefined;
  }
  const t = value.text?.trim() ?? "";
  return t ? { text: t, ...(value.meta ? { meta: value.meta } : {}) } : undefined;
}

function applySlotBudget(
  slotId: ContextSlotId,
  content: ContextSlotContent,
  budget: ContextSlotBudget
): ContextSlotContent | undefined {
  if (budget.compress === "omit") {
    incContextMetric("context.slot_truncated_rate", 1, { slot: slotId, mode: "omit" });
    return undefined;
  }
  if (content.text.length <= budget.maxChars) return content;
  if (budget.compress === "omit") return undefined;
  const truncated = truncatePromptText(content.text, budget.maxChars, `slot:${slotId}`);
  if (truncated.truncated) {
    incContextMetric("context.slot_truncated_rate", 1, { slot: slotId, mode: "truncate" });
  }
  return { ...content, text: truncated.text };
}

/**
 * 构建 Envelope：按槽裁剪，写出 user/system 拼接文本。
 * softOmitLowPriority：从低 priority 槽开始整槽 omit，直到总 user 字符降到 softMaxUserChars。
 */
export function assembleContextEnvelope(input: AssembleSlotsInput): ContextEnvelope {
  const budget: Record<ContextSlotId, ContextSlotBudget> = {
    ...DEFAULT_SLOT_BUDGETS,
    ...(input.budget as Record<ContextSlotId, ContextSlotBudget> | undefined),
  };

  const rawSlots: Partial<Record<ContextSlotId, ContextSlotContent>> = {};
  for (const id of Object.keys(input.slots) as ContextSlotId[]) {
    const n = normalizeSlot(input.slots[id]);
    if (n) rawSlots[id] = n;
  }

  let slots: Partial<Record<ContextSlotId, ContextSlotContent>> = {};
  for (const id of Object.keys(rawSlots) as ContextSlotId[]) {
    const c = rawSlots[id]!;
    const b = budget[id] ?? DEFAULT_SLOT_BUDGETS[id];
    const applied = applySlotBudget(id, c, b);
    if (applied) slots[id] = applied;
  }

  if (input.softOmitLowPriority) {
    const softMax =
      Number(process.env["QUBIT_SOFT_USER_PROMPT_CHARS"] ?? "20000") || 20_000;
    slots = omitUntilUnder(slots, budget, softMax, USER_SLOT_ORDER, "omit_soft");
  }

  const hardMax =
    input.hardMaxUserChars ??
    (Number(process.env["QUBIT_HARD_USER_PROMPT_CHARS"] ?? "24000") || 24_000);
  slots = omitUntilUnder(slots, budget, hardMax, USER_SLOT_ORDER, "omit_hard");

  const userParts: string[] = [];
  for (const id of USER_SLOT_ORDER) {
    const s = slots[id];
    if (s?.text) userParts.push(s.text);
  }
  const systemParts: string[] = [];
  for (const id of SYSTEM_SLOT_ORDER) {
    const s = slots[id];
    if (s?.text) systemParts.push(s.text);
  }

  return {
    version: "1",
    workflowRunId: input.workflowRunId,
    definitionId: input.definitionId,
    role: input.role,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.decisionCutoff ? { decisionCutoff: input.decisionCutoff } : {}),
    axiomsApplied: input.axiomsApplied ?? allAxioms(),
    slots,
    budget,
    rendered: {
      user: userParts.filter(Boolean).join("\n\n"),
      system: systemParts.filter(Boolean).join("\n\n"),
    },
  };
}

function omitUntilUnder(
  slots: Partial<Record<ContextSlotId, ContextSlotContent>>,
  budget: Record<ContextSlotId, ContextSlotBudget>,
  softMax: number,
  order: ContextSlotId[],
  metricMode: "omit_soft" | "omit_hard" = "omit_soft"
): Partial<Record<ContextSlotId, ContextSlotContent>> {
  const next = { ...slots };
  const total = () =>
    order.reduce((n, id) => n + (next[id]?.text.length ?? 0), 0);
  if (total() <= softMax) return next;

  const byPriority = [...order].sort(
    (a, b) => (budget[a]?.priority ?? 0) - (budget[b]?.priority ?? 0)
  );
  for (const id of byPriority) {
    if (total() <= softMax) break;
    // 永不 omit goal / slot / recall_finance
    if (id === "goal" || id === "slot" || id === "recall_finance") continue;
    if (next[id]) {
      delete next[id];
      incContextMetric("context.slot_truncated_rate", 1, { slot: id, mode: metricMode });
    }
  }
  return next;
}

/** 渲染 Handoff：字段优先，narrative 殿后（A1） */
export function renderHandoffForPrompt(handoff: {
  goal?: string;
  symbols?: string[];
  asof?: string;
  narrative?: string;
  claims?: Array<{ text: string; confidence?: number; stance?: string }>;
}): string {
  const lines: string[] = ["**任务上下文（结构化交接）**"];
  if (handoff.goal) lines.push(`- goal: ${handoff.goal}`);
  if (handoff.symbols?.length) lines.push(`- symbols: ${handoff.symbols.join(", ")}`);
  if (handoff.asof) lines.push(`- asof: ${handoff.asof}`);
  if (handoff.claims?.length) {
    lines.push("- claims:");
    for (const c of handoff.claims.slice(0, 6)) {
      const conf = c.confidence != null ? ` conf=${c.confidence.toFixed(2)}` : "";
      const st = c.stance ? ` [${c.stance}]` : "";
      lines.push(`  - ${st}${c.text.slice(0, 200)}${conf}`);
    }
  }
  if (handoff.narrative?.trim()) {
    lines.push("");
    lines.push(handoff.narrative.trim());
  }
  const hasStructured =
    Boolean(handoff.symbols?.length) ||
    Boolean(handoff.asof) ||
    Boolean(handoff.claims?.length);
  if (!hasStructured && handoff.narrative?.trim()) {
    incContextMetric("handoff.unstructured", 1);
  }
  return lines.join("\n");
}
