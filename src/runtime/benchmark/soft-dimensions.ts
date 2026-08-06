/**
 * Soft 层多维打分（确定性，不依赖 LLM Judge）。
 *
 * 维度：
 *   tools         — 必备工具召回 + 轨迹健康度
 *   memory        — memory.recall / workspace.memory.search 尝试与命中
 *   orchestration — agent.invoke 成功率与叙事非 stub
 *   recipe        — scenario expectation 必备工具覆盖
 *   content       — 交付 / DeliveryVerdict 启发式（非 Judge）
 *
 * Soft 不可单独判定 pass；Hard fail 时总分仍为 0。缺遥测 → skipped，
 * 不得伪装成 pass（与 BENCHMARK_AND_FLYWHEEL_TECH_PLAN 一致）。
 */
import type {
  RunEnvelope,
  SoftDimensionScore,
} from "./contracts";

const MEMORY_TOOL_RE = /^(memory\.recall|workspace\.memory\.search)$/i;
const INVOKE_TOOL_RE = /^(agent\.invoke|call_team_)/i;

export function isMemoryToolName(name: string): boolean {
  return MEMORY_TOOL_RE.test(name.trim());
}

export function isInvokeToolName(name: string): boolean {
  return INVOKE_TOOL_RE.test(name.trim());
}

/** 叙事是否仍是 stub（投影层历史问题：invoke completed: <goal>）。 */
export function looksLikeStubNarrative(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^invoke\s+completed\s*:/i.test(t)) return true;
  if (/^invoke\s+(ok|done|success)\b/i.test(t)) return true;
  return false;
}

export function scoreSoftDimensions(envelope: RunEnvelope): {
  score: number | null;
  status: "scored" | "skipped";
  dimensions: SoftDimensionScore[];
} {
  const dimensions: SoftDimensionScore[] = [
    scoreToolsDimension(envelope),
    scoreMemoryDimension(envelope),
    scoreOrchestrationDimension(envelope),
    scoreRecipeDimension(envelope),
    scoreContentDimension(envelope),
  ];
  const scored = dimensions.filter((d) => d.status === "scored" && d.score !== null);
  if (scored.length === 0) {
    return { score: null, status: "skipped", dimensions };
  }
  const score =
    scored.reduce((sum, d) => sum + (d.score as number), 0) / scored.length;
  return { score, status: "scored", dimensions };
}

function scoreToolsDimension(envelope: RunEnvelope): SoftDimensionScore {
  const tools = envelope.tools;
  if (tools.length === 0) {
    return {
      id: "tools",
      score: null,
      status: "skipped",
      detail: "no_tool_calls_observed",
    };
  }
  const succeeded = tools.filter((t) => t.status === "success").length;
  const successRate = succeeded / tools.length;
  const fingerprints = new Map<string, number>();
  for (const tool of tools) {
    const key = `${tool.name}:${tool.requestFingerprint ?? "unknown"}`;
    fingerprints.set(key, (fingerprints.get(key) ?? 0) + 1);
  }
  const maxDup = Math.max(0, ...fingerprints.values());
  const dupScore = maxDup <= 2 ? 1 : maxDup <= 4 ? 0.5 : 0;
  const emptyRetries = tools.reduce((count, tool, index) => {
    const prev = tools[index - 1];
    return count + Number(Boolean(prev?.semanticEmpty && prev.name === tool.name));
  }, 0);
  const emptyScore = emptyRetries <= 1 ? 1 : emptyRetries <= 3 ? 0.4 : 0;
  const recipeRecall = recipeRecallRatio(envelope);
  const parts = [successRate, dupScore, emptyScore];
  if (recipeRecall !== null) parts.push(recipeRecall);
  const score = parts.reduce((a, b) => a + b, 0) / parts.length;
  return {
    id: "tools",
    score,
    status: "scored",
    detail: `success=${successRate.toFixed(2)} maxDup=${maxDup} emptyRetries=${emptyRetries}`,
    metrics: {
      toolSuccessRate: successRate,
      maxDuplicateCalls: maxDup,
      semanticEmptyRetries: emptyRetries,
      requiredToolRecall: recipeRecall,
    },
  };
}

function scoreMemoryDimension(envelope: RunEnvelope): SoftDimensionScore {
  const mem = envelope.memory;
  if (!mem?.telemetryAvailable) {
    // Derive from tools when envelope.memory omitted (older fixtures / partial projection).
    const memoryTools = envelope.tools.filter((t) => isMemoryToolName(t.name));
    if (memoryTools.length === 0) {
      return {
        id: "memory",
        score: null,
        status: "skipped",
        detail: "memory_telemetry_unavailable",
      };
    }
    return scoreMemoryFromTools(memoryTools);
  }
  const attempts = mem.recallAttempts + mem.searchAttempts;
  if (attempts === 0) {
    return {
      id: "memory",
      score: null,
      status: "not_applicable",
      detail: "no_memory_tools_called",
      metrics: {
        recallAttempts: 0,
        searchAttempts: 0,
        recallHits: 0,
        searchHits: 0,
      },
    };
  }
  const successes = mem.recallSuccesses + mem.searchSuccesses;
  const successRate = successes / attempts;
  const hits = mem.recallHits + mem.searchHits;
  // 有 hit 更好，但空库诚实 0 hit 不应零分：成功调用给基础分，有 hit 加分。
  const hitScore = hits > 0 ? Math.min(1, 0.5 + Math.log1p(hits) / 4) : 0.45;
  const errorPenalty = mem.errorCount > 0 ? Math.max(0, 1 - mem.errorCount / attempts) : 1;
  const score = clamp01(0.55 * successRate + 0.35 * hitScore + 0.1 * errorPenalty);
  return {
    id: "memory",
    score,
    status: "scored",
    detail: `attempts=${attempts} successes=${successes} hits=${hits} errors=${mem.errorCount}`,
    metrics: {
      recallAttempts: mem.recallAttempts,
      searchAttempts: mem.searchAttempts,
      recallHits: mem.recallHits,
      searchHits: mem.searchHits,
      errorCount: mem.errorCount,
      successRate,
    },
  };
}

function scoreMemoryFromTools(
  memoryTools: RunEnvelope["tools"]
): SoftDimensionScore {
  const attempts = memoryTools.length;
  const successes = memoryTools.filter((t) => t.status === "success").length;
  const hits = memoryTools.reduce((sum, t) => sum + (t.memoryHitCount ?? 0), 0);
  const errors = attempts - successes;
  const successRate = successes / attempts;
  const hitScore = hits > 0 ? Math.min(1, 0.5 + Math.log1p(hits) / 4) : 0.45;
  const score = clamp01(0.6 * successRate + 0.4 * hitScore);
  return {
    id: "memory",
    score,
    status: "scored",
    detail: `derived_from_tools attempts=${attempts} hits=${hits}`,
    metrics: {
      recallAttempts: attempts,
      recallHits: hits,
      errorCount: errors,
      successRate,
    },
  };
}

function scoreOrchestrationDimension(envelope: RunEnvelope): SoftDimensionScore {
  const orch = envelope.orchestration;
  if (!orch?.telemetryAvailable) {
    const invokeTools = envelope.tools.filter((t) => isInvokeToolName(t.name));
    if (invokeTools.length === 0) {
      return {
        id: "orchestration",
        score: null,
        status: "skipped",
        detail: "orchestration_telemetry_unavailable",
      };
    }
    const successRate =
      invokeTools.filter((t) => t.status === "success").length / invokeTools.length;
    return {
      id: "orchestration",
      score: successRate,
      status: "scored",
      detail: `derived_from_tools invokes=${invokeTools.length}`,
      metrics: {
        invokeAttempts: invokeTools.length,
        invokeSuccessRate: successRate,
      },
    };
  }
  if (orch.invokeAttempts === 0) {
    return {
      id: "orchestration",
      score: null,
      status: "not_applicable",
      detail: "no_specialist_invoke",
      metrics: { invokeAttempts: 0 },
    };
  }
  const successRate = orch.invokeSuccesses / orch.invokeAttempts;
  const stubRate = orch.stubNarrativeCount / Math.max(1, orch.invokeSuccesses || orch.invokeAttempts);
  const stubScore = 1 - Math.min(1, stubRate);
  const narrativeScore =
    orch.narrativeChars >= 200 ? 1 : orch.narrativeChars >= 80 ? 0.7 : orch.narrativeChars > 0 ? 0.4 : 0;
  const score = clamp01(0.5 * successRate + 0.3 * stubScore + 0.2 * narrativeScore);
  return {
    id: "orchestration",
    score,
    status: "scored",
    detail: `invokes=${orch.invokeAttempts} ok=${orch.invokeSuccesses} stubs=${orch.stubNarrativeCount} chars=${orch.narrativeChars}`,
    metrics: {
      invokeAttempts: orch.invokeAttempts,
      invokeSuccesses: orch.invokeSuccesses,
      stubNarrativeCount: orch.stubNarrativeCount,
      narrativeChars: orch.narrativeChars,
      invokeSuccessRate: successRate,
      stubRate,
    },
  };
}

function scoreRecipeDimension(envelope: RunEnvelope): SoftDimensionScore {
  const recall = recipeRecallRatio(envelope);
  if (recall === null) {
    return {
      id: "recipe",
      score: null,
      status: "skipped",
      detail: envelope.recipe?.telemetryAvailable
        ? "no_required_tools_configured"
        : "recipe_telemetry_unavailable",
    };
  }
  const missed = envelope.recipe?.missedTools ?? [];
  return {
    id: "recipe",
    score: recall,
    status: "scored",
    detail:
      missed.length === 0
        ? `required_tools_full_recall=${recall.toFixed(2)}`
        : `missed:${missed.slice(0, 6).join(",")}`,
    metrics: {
      requiredToolRecall: recall,
      requiredCount: envelope.recipe?.requiredTools.length ?? null,
      matchedCount: envelope.recipe?.matchedTools.length ?? null,
    },
  };
}

function scoreContentDimension(envelope: RunEnvelope): SoftDimensionScore {
  // Deterministic delivery heuristic — not an LLM judge.
  if (!envelope.delivery.observed) {
    return {
      id: "content",
      score: null,
      status: "skipped",
      detail: "delivery_projection_unavailable",
    };
  }
  let score = 0;
  let parts = 0;
  if (envelope.delivery.hasUserFinalAnswer) {
    score += 1;
    parts += 1;
  } else if (envelope.terminal.status === "completed") {
    score += 0;
    parts += 1;
  }
  const verdict = envelope.deliveryVerdict;
  if (verdict?.available && verdict.state) {
    parts += 1;
    if (verdict.state === "delivered") score += 1;
    else if (verdict.state === "delivered_with_gaps") score += 0.75;
    else if (verdict.state === "partial") score += 0.4;
    else score += 0;
  }
  if (envelope.artifactGate.available) {
    parts += 1;
    score += envelope.artifactGate.ok ? 1 : 0.2;
  }
  if (parts === 0) {
    return {
      id: "content",
      score: null,
      status: "skipped",
      detail: "no_content_signals",
    };
  }
  return {
    id: "content",
    score: clamp01(score / parts),
    status: "scored",
    detail: `answer=${Boolean(envelope.delivery.hasUserFinalAnswer)} verdict=${verdict?.state ?? "na"} artifacts=${envelope.artifactGate.ok ?? "na"}`,
  };
}

function recipeRecallRatio(envelope: RunEnvelope): number | null {
  const recipe = envelope.recipe;
  if (!recipe?.telemetryAvailable) return null;
  if (recipe.requiredTools.length === 0) return null;
  return recipe.matchedTools.length / recipe.requiredTools.length;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
