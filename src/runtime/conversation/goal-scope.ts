/**
 * Session vs workflow goal scope — detect topic/intent shifts so a new user
 * utterance does not inherit execution playbooks from an unrelated prior run.
 */

export type GoalIntent = "knowledge" | "execution" | "neutral";

export type ContextIsolationState = {
  version: 1;
  reason: string;
  priorGoal?: string;
  isolatedAt: string;
};

const KNOWLEDGE_MARKERS: RegExp[] = [
  /怎么选/,
  /如何选/,
  /选股方法/,
  /投资理念/,
  /方法论/,
  /是什么/,
  /有哪些/,
  /什么类型/,
  /有哪些类型/,
  /介绍一下/,
  /梳理/,
  /总结/,
  /查下/,
  /帮我查/,
  /沉淀.*skill/i,
  /巴菲特/,
  /芒格/,
  /牛散/,
  /区别是什么/,
  /分类/,
  /原理/,
  /框架/,
  /学习/,
  /了解/,
  /一般.*之中/,
];

const EXECUTION_MARKERS: RegExp[] = [
  /回测/,
  /因子/,
  /策略/,
  /落地/,
  /编写.*脚本/,
  /注册因子/,
  /compose/,
  /compile/,
  /order_intent/,
  /下单/,
  /做多/,
  /做空/,
  /long.?short/i,
  /配对/,
  /调仓/,
  /持仓/,
  /给我做.*策略/,
  /生成.*策略/,
  /写.*策略/,
  /对策略回测/,
  /在我自选/,
  /自选上/,
];

const EXECUTION_SKILL_PATTERN =
  /quant:factor-compose|auto-play|backtest-fastpath|factor-compose-backtest/i;

/** Short follow-ups that mean "keep going on the current goal", not a topic change. */
const CONTINUATION_CUE =
  /^(继续|请继续|接着|接着做|往下|然后呢|下一步|go on|continue|keep going)[.。!！?？…\s]*$/i;

export function isContinuationCue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (CONTINUATION_CUE.test(t)) return true;
  // Ultra-short neutral nudges ("好的", "嗯") should not wipe session context.
  return t.length <= 6 && classifyGoalIntent(t) === "neutral";
}

export function classifyGoalIntent(text: string): GoalIntent {
  const t = text.trim();
  if (!t) return "neutral";
  let knowledge = 0;
  let execution = 0;
  for (const re of KNOWLEDGE_MARKERS) {
    if (re.test(t)) knowledge += 1;
  }
  for (const re of EXECUTION_MARKERS) {
    if (re.test(t)) execution += 1;
  }
  // Taxonomy / explainer prompts often mention "策略" without asking for implementation.
  if (/有哪些|什么类型|分类|梳理|原理|方法论|是什么/.test(t)) {
    knowledge += 1;
  }
  if (knowledge > 0 && execution === 0) return "knowledge";
  if (execution > 0 && knowledge === 0) return "execution";
  if (knowledge > execution) return "knowledge";
  if (execution > knowledge) return "execution";
  return "neutral";
}

export function tokenizeGoalText(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi) ?? []) {
    tokens.add(m);
  }
  return tokens;
}

export function goalTokenOverlap(a: string, b: string): number {
  const left = tokenizeGoalText(a);
  const right = tokenizeGoalText(b);
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const t of left) {
    if (right.has(t)) inter += 1;
  }
  return inter / (left.size + right.size - inter);
}

export function detectGoalTopicShift(
  priorGoal: string,
  currentMessage: string
): { shifted: boolean; reason?: string } {
  const prior = priorGoal.trim();
  const current = currentMessage.trim();
  if (!prior || !current) return { shifted: false };
  if (prior === current) return { shifted: false };
  if (isContinuationCue(current)) return { shifted: false };

  const priorIntent = classifyGoalIntent(prior);
  const currentIntent = classifyGoalIntent(current);

  if (priorIntent === "execution" && currentIntent === "knowledge") {
    return { shifted: true, reason: "intent_execution_to_knowledge" };
  }
  if (priorIntent === "knowledge" && currentIntent === "execution") {
    return { shifted: true, reason: "intent_knowledge_to_execution" };
  }

  const overlap = goalTokenOverlap(prior, current);
  // Same-intent short follow-ups ("对策略回测", "再归纳一下") keep the thread.
  if (priorIntent === currentIntent && currentIntent !== "neutral" && current.length <= 32) {
    return { shifted: false };
  }
  if (overlap < 0.08) {
    return { shifted: true, reason: "low_topic_overlap" };
  }
  if (
    overlap < 0.15 &&
    priorIntent !== "neutral" &&
    currentIntent !== "neutral" &&
    priorIntent !== currentIntent
  ) {
    return { shifted: true, reason: "intent_mismatch_with_low_overlap" };
  }
  return { shifted: false };
}

export function parseContextIsolation(raw: unknown): ContextIsolationState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  const reason = typeof o.reason === "string" ? o.reason.trim() : "";
  const isolatedAt = typeof o.isolatedAt === "string" ? o.isolatedAt.trim() : "";
  if (!reason || !isolatedAt) return null;
  const priorGoal = typeof o.priorGoal === "string" ? o.priorGoal.trim() : undefined;
  return { version: 1, reason, isolatedAt, ...(priorGoal ? { priorGoal } : {}) };
}

export function buildContextIsolationState(input: {
  reason: string;
  priorGoal?: string;
}): ContextIsolationState {
  return {
    version: 1,
    reason: input.reason,
    ...(input.priorGoal?.trim() ? { priorGoal: input.priorGoal.trim().slice(0, 240) } : {}),
    isolatedAt: new Date().toISOString(),
  };
}

export function buildGoalTopicResetNotice(isolation: ContextIsolationState): string {
  const prior = isolation.priorGoal
    ? `Prior goal (obsolete): ${isolation.priorGoal.slice(0, 160)}`
    : "Prior workflow goal is obsolete.";
  return [
    "GOAL_TOPIC_RESET: session reused a chat thread but the user goal changed.",
    `Reason: ${isolation.reason}`,
    prior,
    "Execute CURRENT_USER_TASK only. Do NOT continue factor/strategy/backtest work from prior runs unless the current user explicitly asks for implementation.",
  ].join(" ");
}

export function buildKnowledgeIntentGuard(goal: string): string | null {
  if (classifyGoalIntent(goal) !== "knowledge") return null;
  return [
    "INTENT_GUARD: knowledge / methodology question.",
    "Deliver structured research, citations where possible, and optional skill drafts.",
    "Do NOT register factors, compose strategies, invoke strategy_coder, or run backtests unless the user explicitly requests implementation.",
  ].join(" ");
}

export function shouldSuppressWorkflowPlayRecall(input: {
  query: string;
  hitTitle: string;
  hitSummary: string;
  hitSubKind?: string;
  contextIsolation?: ContextIsolationState | null;
}): boolean {
  if (input.hitSubKind !== "workflow_play") return false;
  if (input.contextIsolation) return true;
  if (classifyGoalIntent(input.query) === "knowledge") return true;
  const blob = `${input.hitTitle}\n${input.hitSummary}`;
  if (/auto-play|factor\.|strategy\.|backtest\./i.test(blob) && classifyGoalIntent(input.query) === "knowledge") {
    return true;
  }
  return goalTokenOverlap(input.query, blob) < 0.06;
}

export function shouldSuppressExecutionSkill(skillName: string, query: string): boolean {
  if (!EXECUTION_SKILL_PATTERN.test(skillName)) return false;
  return classifyGoalIntent(query) === "knowledge";
}

export function resolveRecallPolicy(input: {
  goal: string;
  contextIsolation?: ContextIsolationState | null;
}): {
  includeSkillRecall: boolean;
  recallTopK: number;
  suppressWorkflowPlay: boolean;
} {
  const knowledge = classifyGoalIntent(input.goal) === "knowledge";
  const isolated = Boolean(input.contextIsolation);
  if (isolated || knowledge) {
    return {
      includeSkillRecall: false,
      recallTopK: 2,
      suppressWorkflowPlay: true,
    };
  }
  return {
    includeSkillRecall: true,
    recallTopK: 3,
    suppressWorkflowPlay: false,
  };
}
