/**
 * WorkingMemory — Context Protocol L2（05 §4.3）
 * GraphState 一等字段的创建 / 工具结果更新 / Prompt 渲染。
 */

import { incContextMetric } from "./context-metrics";
import { isWorkingMemorySummarizeEnabled } from "./axioms";
import type { WorkingMemory, WorkingMemoryFinanceRefs } from "./types";

export function createEmptyWorkingMemory(now = new Date()): WorkingMemory {
  return {
    version: 1,
    hypotheses: [],
    openQuestions: [],
    decisions: [],
    financeRefs: {},
    trailStub: [],
    updatedAt: now.toISOString(),
  };
}

export function ensureWorkingMemory(
  wm: WorkingMemory | null | undefined
): WorkingMemory {
  if (wm && wm.version === 1 && Array.isArray(wm.trailStub)) return wm;
  // 迁移期：可读 contextMemory.working
  return createEmptyWorkingMemory();
}

export interface ToolWorkingMemoryUpdate {
  step: number;
  tool?: string;
  ok: boolean;
  oneLiner?: string;
  /** 工具返回体（builtinResult / connectorResult / …） */
  result?: unknown;
  errorMessage?: string;
}

/** 从任意 JSON 树抽取 finance refs */
export function extractFinanceRefsFromPayload(
  payload: unknown,
  acc: WorkingMemoryFinanceRefs = {}
): WorkingMemoryFinanceRefs {
  const out: WorkingMemoryFinanceRefs = {
    factorIds: [...(acc.factorIds ?? [])],
    compositionIds: [...(acc.compositionIds ?? [])],
    evaluationIds: [...(acc.evaluationIds ?? [])],
    symbols: [...(acc.symbols ?? [])],
  };
  const seen = {
    f: new Set(out.factorIds),
    c: new Set(out.compositionIds),
    e: new Set(out.evaluationIds),
    s: new Set(out.symbols),
  };

  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 40)) visit(item, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const push = (key: keyof typeof seen, val: unknown) => {
      if (typeof val !== "string" || !val.trim()) return;
      const id = val.trim();
      if (seen[key].has(id)) return;
      seen[key].add(id);
      if (key === "f") out.factorIds!.push(id);
      if (key === "c") out.compositionIds!.push(id);
      if (key === "e") out.evaluationIds!.push(id);
      if (key === "s") out.symbols!.push(id);
    };
    push("f", o.factorId ?? o.factor_id);
    push("c", o.compositionId ?? o.composition_id);
    push("e", o.evaluationId ?? o.evaluation_id);
    if (typeof o.symbol === "string") push("s", o.symbol);
    if (typeof o.ticker === "string") push("s", o.ticker);
    if (Array.isArray(o.symbols)) {
      for (const s of o.symbols) push("s", s);
    }
    for (const child of Object.values(o).slice(0, 30)) visit(child, depth + 1);
  };
  visit(payload, 0);
  return out;
}

export function applyToolResultToWorkingMemory(
  prev: WorkingMemory | null | undefined,
  update: ToolWorkingMemoryUpdate
): WorkingMemory {
  const wm = ensureWorkingMemory(prev);
  const oneLiner =
    update.oneLiner ??
    (update.ok
      ? `${update.tool ?? "tool"} ok`
      : `${update.tool ?? "tool"} fail: ${(update.errorMessage ?? "").slice(0, 80)}`);

  const trailStub = [
    ...wm.trailStub,
    {
      step: update.step,
      ...(update.tool ? { tool: update.tool } : {}),
      ok: update.ok,
      oneLiner: oneLiner.slice(0, 160),
    },
  ].slice(-40);

  const openQuestions = [...wm.openQuestions];
  if (!update.ok && update.errorMessage) {
    const q = `工具 ${update.tool ?? "?"} 失败：${update.errorMessage.slice(0, 120)}`;
    if (!openQuestions.includes(q) && openQuestions.length < 8) openQuestions.push(q);
  }

  const financeRefs = update.result
    ? extractFinanceRefsFromPayload(update.result, wm.financeRefs)
    : wm.financeRefs;

  const next: WorkingMemory = {
    ...wm,
    trailStub,
    openQuestions,
    financeRefs,
    updatedAt: new Date().toISOString(),
  };
  incContextMetric("context.working_claim_count", next.hypotheses.length);
  return next;
}

/** Prompt 主路径：结构化 WorkingMemory，而非全量 observations */
export function renderWorkingMemoryForPrompt(wm: WorkingMemory | null | undefined): string {
  const m = ensureWorkingMemory(wm);
  const lines: string[] = ["**工作记忆（WorkingMemory）**"];

  if (m.debate) {
    lines.push("- debate:");
    if (m.debate.bullPoints.length) {
      lines.push(`  - bull: ${m.debate.bullPoints.slice(0, 5).join(" | ")}`);
    }
    if (m.debate.bearPoints.length) {
      lines.push(`  - bear: ${m.debate.bearPoints.slice(0, 5).join(" | ")}`);
    }
    if (m.debate.resolution) lines.push(`  - resolution: ${m.debate.resolution}`);
  }

  if (m.hypotheses.length) {
    lines.push("- hypotheses:");
    for (const h of m.hypotheses.slice(0, 6)) {
      const conf = h.confidence != null ? ` conf=${h.confidence.toFixed(2)}` : "";
      lines.push(`  - [${h.status}${h.stance ? `/${h.stance}` : ""}] ${h.text.slice(0, 160)}${conf}`);
    }
  }

  if (m.decisions.length) {
    lines.push(`- decisions: ${m.decisions.slice(0, 8).join(" · ")}`);
  }
  if (m.openQuestions.length) {
    lines.push(`- openQuestions: ${m.openQuestions.slice(0, 8).join(" · ")}`);
  }

  const refs = m.financeRefs;
  const refBits: string[] = [];
  if (refs.factorIds?.length) refBits.push(`factors=${refs.factorIds.slice(0, 6).join(",")}`);
  if (refs.compositionIds?.length)
    refBits.push(`compositions=${refs.compositionIds.slice(0, 4).join(",")}`);
  if (refs.symbols?.length) refBits.push(`symbols=${refs.symbols.slice(0, 8).join(",")}`);
  if (refBits.length) lines.push(`- financeRefs: ${refBits.join(" · ")}`);

  if (m.trailStub.length) {
    lines.push("- trail (recent):");
    for (const t of m.trailStub.slice(-8)) {
      lines.push(`  - #${t.step} ${t.ok ? "✓" : "✗"} ${t.tool ?? "?"} — ${t.oneLiner}`);
    }
  }

  if (lines.length <= 1) {
    lines.push("_（本轮尚无结构化工作记忆）_");
  }
  return lines.join("\n");
}

export function isWorkingMemoryEmpty(wm: WorkingMemory | null | undefined): boolean {
  const m = ensureWorkingMemory(wm);
  return (
    m.trailStub.length === 0 &&
    m.hypotheses.length === 0 &&
    m.openQuestions.length === 0 &&
    m.decisions.length === 0 &&
    !m.debate &&
    !(m.financeRefs.factorIds?.length || m.financeRefs.symbols?.length)
  );
}

/**
 * P2：可选折叠（默认关）。`CONTEXT_WORKING_SUMMARIZE=1` 时压缩 trail / 假设，
 * 热路径仍不做 LLM；真正 LLM 摘要留给终态 Reflector。
 */
export function maybeFoldWorkingMemory(
  wm: WorkingMemory | null | undefined,
  opts?: { force?: boolean; maxTrail?: number; maxHypotheses?: number }
): WorkingMemory {
  const m = ensureWorkingMemory(wm);
  if (!opts?.force && !isWorkingMemorySummarizeEnabled()) return m;

  const maxTrail = opts?.maxTrail ?? 6;
  const maxHypotheses = opts?.maxHypotheses ?? 4;
  const keptStatus = new Set(["open", "supported"]);
  const hypotheses = m.hypotheses
    .filter((h) => keptStatus.has(h.status))
    .slice(0, maxHypotheses)
    .map((h) => ({
      ...h,
      text: h.text.slice(0, 120),
    }));

  const trailStub = m.trailStub.slice(-maxTrail).map((t) => ({
    ...t,
    oneLiner: t.oneLiner.slice(0, 100),
  }));

  const next: WorkingMemory = {
    ...m,
    hypotheses,
    openQuestions: m.openQuestions.slice(0, 4).map((q) => q.slice(0, 100)),
    decisions: m.decisions.slice(0, 6).map((d) => d.slice(0, 80)),
    trailStub,
    updatedAt: new Date().toISOString(),
  };
  incContextMetric("context.working_fold", 1);
  return next;
}
