/**
 * ContextHandoffV1 — A1 结构化交接（05 §4.6）
 */

import { renderHandoffForPrompt } from "./assemble-context-prompt";
import { incContextMetric } from "./context-metrics";
import type { ContextHandoffV1, WorkingClaim } from "./types";

export function isContextHandoffV1(v: unknown): v is ContextHandoffV1 {
  return Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (v as ContextHandoffV1).version === 1 &&
      typeof (v as ContextHandoffV1).goal === "string"
  );
}

/** 从 TaskAssign params.context（string | object）解析 */
export function parseSlotContextParam(raw: unknown): {
  handoff: ContextHandoffV1 | null;
  narrative: string;
  unstructured: boolean;
} {
  if (typeof raw === "string") {
    const narrative = raw.trim();
    if (!narrative) return { handoff: null, narrative: "", unstructured: false };
    incContextMetric("handoff.unstructured", 1);
    return { handoff: null, narrative, unstructured: true };
  }
  if (isContextHandoffV1(raw)) {
    const hasStructured =
      Boolean(raw.symbols?.length) ||
      Boolean(raw.asof) ||
      Boolean(raw.claims?.length) ||
      Boolean(raw.financeRefs) ||
      Boolean(raw.evidence);
    if (!hasStructured && raw.narrative?.trim()) {
      incContextMetric("handoff.unstructured", 1);
      return { handoff: raw, narrative: raw.narrative.trim(), unstructured: true };
    }
    return {
      handoff: raw,
      narrative: raw.narrative?.trim() ?? "",
      unstructured: false,
    };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const narrative =
      typeof o.narrative === "string"
        ? o.narrative
        : typeof o.context === "string"
          ? o.context
          : typeof o.text === "string"
            ? o.text
            : JSON.stringify(raw).slice(0, 6000);
    const goal = typeof o.goal === "string" ? o.goal : "";
    const handoff: ContextHandoffV1 = {
      version: 1,
      goal,
      ...(Array.isArray(o.symbols) ? { symbols: o.symbols.map(String) } : {}),
      ...(typeof o.asof === "string" ? { asof: o.asof } : {}),
      ...(narrative ? { narrative } : {}),
    };
    const unstructured = !handoff.symbols?.length && !handoff.asof;
    if (unstructured) incContextMetric("handoff.unstructured", 1);
    return { handoff, narrative, unstructured };
  }
  return { handoff: null, narrative: "", unstructured: false };
}

/** 渲染进 reason slot 槽（字段优先） */
export function renderSlotContextForPrompt(raw: unknown): string {
  const { handoff, narrative } = parseSlotContextParam(raw);
  if (handoff) {
    return renderHandoffForPrompt({
      goal: handoff.goal || undefined,
      symbols: handoff.symbols,
      asof: handoff.asof,
      narrative: handoff.narrative ?? narrative,
      claims: handoff.claims?.map((c: WorkingClaim) => ({
        text: c.text,
        confidence: c.confidence,
        stance: c.stance,
      })),
    });
  }
  return narrative ? `**任务上下文**：\n${narrative}` : "";
}

/** MSA / A2A 双写：结构化 + 兼容旧 string 读方 */
export function buildContextHandoffV1(input: {
  goal: string;
  symbols?: string[];
  asof?: string;
  narrative?: string;
  claims?: WorkingClaim[];
  financeRefs?: ContextHandoffV1["financeRefs"];
  evidence?: ContextHandoffV1["evidence"];
}): ContextHandoffV1 {
  return {
    version: 1,
    goal: input.goal,
    ...(input.symbols?.length ? { symbols: input.symbols } : {}),
    ...(input.asof ? { asof: input.asof } : {}),
    ...(input.narrative ? { narrative: input.narrative } : {}),
    ...(input.claims?.length ? { claims: input.claims } : {}),
    ...(input.financeRefs ? { financeRefs: input.financeRefs } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

/**
 * 写进 TaskAssign params：同时提供 string（兼容）与 structured。
 * 读路径认 string 或 ContextHandoffV1。
 */
export function encodeContextParamForDispatch(handoff: ContextHandoffV1): ContextHandoffV1 {
  // 直接传对象；旧消费者若只认 string，需在写端另附 narrative 字符串字段
  return handoff;
}

export function handoffToLegacyContextString(handoff: ContextHandoffV1): string {
  return renderHandoffForPrompt({
    goal: handoff.goal,
    symbols: handoff.symbols,
    asof: handoff.asof,
    narrative: handoff.narrative,
    claims: handoff.claims?.map((c) => ({
      text: c.text,
      confidence: c.confidence,
      stance: c.stance,
    })),
  });
}
