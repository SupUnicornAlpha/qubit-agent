/**
 * Extractor Pipe — Memory V2 P1（详见 docs/MEMORY_V2_DESIGN.md §6.4）。
 *
 * 唯一职责：workflow 走到终态后，从 episodic 出发，**按规则**提炼出
 * semantic / procedural 候选 experience 并写回 Store，同时用 `derive_from`
 * 链回 episodic 源头建立可追溯关系。
 *
 * 关键设计：
 *   - **规则胜出，不调 LLM**：保持 `consolidateFromWorkflow` 的心智 —— 每次
 *     workflow 完成都跑 LLM 是奢侈品；规则跑 < 20ms 即可。
 *   - **可注入 loader**：把"从 DB / Store 读 workflow + steps + episodic"抽象成
 *     `ExtractorLoader` 接口，使生产用真实 DB / 单测用内存 fake 同源。
 *   - **只生 candidate**：semantic 不直接 active；与 Janitor / Curator 配合，
 *     7 天观察期内被召回 + execute success → 升 quality；否则被衰减。
 *   - **失败不抛错**：单条规则失败被 catch + warn，不影响其它规则。
 *
 * 规则集（P1 起跑 3 条；后续按 `subKind` 扩展）：
 *
 *   R1 [semantic · factor_archive]
 *      mode=backtest 且 final_answer 中含 RankIC / IR / Sharpe 等量化指标
 *      → 写一条 semantic({sub_kind:factor_archive})，summary=指标摘要
 *
 *   R2 [procedural · workflow_play]
 *      ≥5 次 tool_call 且 ≥3 distinct tool 且有 final_answer
 *      → 写一条 procedural({sub_kind:workflow_play})，body=工具链伪 markdown
 *      （与 skill candidate 是同一信号源，未来 P2 合并）
 *
 *   R3 [semantic · iteration_summary]
 *      role ∈ {research, orchestrator} 且 final_answer 非空
 *      → 写一条 semantic({sub_kind:iteration_summary})，summary=goal + final_answer 截断
 *
 *   R4 [semantic · regime]（Context Protocol P1）
 *   R5 [semantic · research_conclusion]（Context Protocol P1 · zod 门禁）
 */

import type { Experience, ExperienceContent, ExperienceScope } from "../../../types/entities";
import type { WorkingMemory } from "../../context/types";
import {
  defaultVisibilityForWriteScope,
  resolveExperienceWriteScope,
} from "../experience-scope";
import type { ExperienceBus, Unsubscribe } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";

// ───────────────────────── Loader 契约 ─────────────────────────

export interface ExtractorWorkflowSummary {
  workflowRunId: string;
  projectId: string;
  /** FS Workspace id；有值时写入 scope=workspace */
  fsWorkspaceId?: string | null;
  goal: string;
  mode: "research" | "backtest" | "simulation" | "live";
  status: "completed" | "failed";
  startedAt: string;
  endedAt: string | null;
  /** workflow 涉及的 agent，按 role 排序 */
  participants: Array<{
    definitionId: string;
    role: string;
    toolsUsed: Record<string, number>;
    toolChain: string[]; // 折叠相邻重复后的有序工具链
    finalAnswer: string;
    stepCount: number;
    /** 最新 checkpoint 中的 WorkingMemory（若有） */
    workingMemory?: WorkingMemory | null;
  }>;
  /** 已由 Writer 落下的 episodic（用于建立 derive_from 链；可空） */
  episodicIds: string[];
}

/** Prefer workspace scope when FS workspace id is present. */
function writeScope(summary: ExtractorWorkflowSummary): {
  scope: ExperienceScope;
  scopeId: string;
} {
  return resolveExperienceWriteScope({
    projectId: summary.projectId,
    fsWorkspaceId: summary.fsWorkspaceId,
  });
}

function writeVisibility(summary: ExtractorWorkflowSummary) {
  const { scope } = writeScope(summary);
  return defaultVisibilityForWriteScope(scope);
}

export interface ExtractorLoader {
  /** 读 workflow + agent_step + episodic 并归纳成 ExtractorWorkflowSummary */
  loadWorkflowSummary(workflowRunId: string): Promise<ExtractorWorkflowSummary | null>;
}

// ───────────────────────── Pipe 启动 ─────────────────────────

export interface ExtractorOptions {
  store: ExperienceStore;
  bus: ExperienceBus;
  loader: ExtractorLoader;
}

export interface ExtractorHandle {
  detach(): void;
  /**
   * 同步触发一次提炼。返回新写入的 experience id 列表。
   * 直接给 onWorkflowTerminal 串行调用 / 单测断言用。
   */
  extractOnce(workflowRunId: string): Promise<string[]>;
}

export function startExtractorPipe(opts: ExtractorOptions): ExtractorHandle {
  const off = opts.bus.subscribe("workflow_terminal", async (ev) => {
    try {
      await extractOnceInternal(opts, ev.workflowRunId);
    } catch (err) {
      warn("workflow_terminal", err);
    }
  });

  return {
    detach() {
      off();
    },
    extractOnce(workflowRunId: string) {
      return extractOnceInternal(opts, workflowRunId);
    },
  };
}

async function extractOnceInternal(
  opts: ExtractorOptions,
  workflowRunId: string
): Promise<string[]> {
  const summary = await opts.loader.loadWorkflowSummary(workflowRunId);
  if (!summary) return [];
  const written: string[] = [];
  const writtenExps: Awaited<ReturnType<typeof opts.store.insert>>[] = [];

  // 每条 rule 都用独立 try/catch，单条失败不影响其它
  for (const participant of summary.participants) {
    const ctx: RuleCtx = { summary, participant, store: opts.store };

    for (const rule of RULES) {
      try {
        const exp = await rule(ctx);
        if (exp) {
          written.push(exp.id);
          writtenExps.push(exp);
          // 链回 episodic 源头（若有）
          for (const episodicId of summary.episodicIds) {
            try {
              await opts.store.linkAdd(exp.id, episodicId, "derive_from", 1.0);
            } catch (e) {
              warn("linkAdd", e);
            }
          }
        }
      } catch (e) {
        warn(`rule:${rule.name}`, e);
      }
    }
  }

  // §4.4 B：高质量 Experience → FS memory/entries（Workspace 面板可见）
  if (writtenExps.length > 0) {
    try {
      const { onExperiencesWritten } = await import("../../memory/long-term-memory");
      await onExperiencesWritten({
        experiences: writtenExps,
        ...(summary.fsWorkspaceId != null ? { fsWorkspaceId: summary.fsWorkspaceId } : {}),
        projectId: summary.projectId,
      });
    } catch (e) {
      warn("project_to_fs", e);
    }
  }

  return written;
}

// ───────────────────────── 规则定义 ─────────────────────────

interface RuleCtx {
  summary: ExtractorWorkflowSummary;
  participant: ExtractorWorkflowSummary["participants"][number];
  store: ExperienceStore;
}

type Rule = ((ctx: RuleCtx) => Promise<Experience | null>) & { ruleName: string };

const RULES: Rule[] = [];

function defineRule(name: string, fn: (ctx: RuleCtx) => Promise<Experience | null>): void {
  const wrapped = fn as Rule;
  wrapped.ruleName = name;
  Object.defineProperty(wrapped, "name", { value: name });
  RULES.push(wrapped);
}

// ── R1: backtest + 量化指标 → semantic.factor_archive ─────────────────────────

const QUANT_METRIC_REGEX = /\b(rank\s*ic|sharpe|ir|max\s*drawdown|cagr|turnover)\b/i;

defineRule("R1_factor_archive", async (ctx) => {
  if (ctx.summary.mode !== "backtest") return null;
  if (!ctx.participant.finalAnswer) return null;
  if (!QUANT_METRIC_REGEX.test(ctx.participant.finalAnswer)) return null;

  // 去重：同 scope + 同 goal 半小时内只写一条
  const scope = writeScope(ctx.summary);
  const recent = await ctx.store.query({
    kind: "semantic",
    subKind: "factor_archive",
    ...scope,
    limit: 20,
    orderBy: "created_desc",
  });
  if (recent.some((r) => r.contentJson.goal === ctx.summary.goal)) return null;

  const summaryLine = `[backtest] ${truncate(ctx.summary.goal, 80)} → ${truncate(
    ctx.participant.finalAnswer,
    300
  )}`;

  return ctx.store.insert({
    kind: "semantic",
    subKind: "factor_archive",
    ...scope,
    definitionId: null, // semantic 默认共享 ← 用户决策 4
    visibility: writeVisibility(ctx.summary),
    contentJson: {
      summary: summaryLine,
      body: ctx.participant.finalAnswer,
      goal: ctx.summary.goal,
      role: ctx.participant.role,
      workflowRunId: ctx.summary.workflowRunId,
    },
    tagsJson: ["mode:backtest", `role:${ctx.participant.role}`, "rule:R1"],
    validFrom: ctx.summary.endedAt ?? new Date().toISOString(),
    sourceRunId: ctx.summary.workflowRunId,
    qualityScore: 0.6, // 由 Janitor 后续重算
  });
});

// ── R2: 5+ tool_call & 3+ distinct & 有 final_answer → procedural.workflow_play ──

const PROCEDURAL_MIN_TOTAL_CALLS = 5;
const PROCEDURAL_MIN_DISTINCT = 3;

defineRule("R2_workflow_play", async (ctx) => {
  const totalCalls = Object.values(ctx.participant.toolsUsed).reduce((a, b) => a + b, 0);
  const distinct = Object.keys(ctx.participant.toolsUsed).length;
  if (totalCalls < PROCEDURAL_MIN_TOTAL_CALLS) return null;
  if (distinct < PROCEDURAL_MIN_DISTINCT) return null;
  if (!ctx.participant.finalAnswer) return null;
  if (ctx.participant.toolChain.length < PROCEDURAL_MIN_DISTINCT) return null;

  const signature = ctx.participant.toolChain.join(">");

  // 同 scope + 同 signature 不重复
  const scope = writeScope(ctx.summary);
  const recent = await ctx.store.query({
    kind: "procedural",
    subKind: "workflow_play",
    ...scope,
    limit: 50,
    orderBy: "created_desc",
  });
  if (recent.some((r) => r.metadataJson.signature === signature)) return null;

  const body = renderProceduralBody({
    role: ctx.participant.role,
    goal: ctx.summary.goal,
    toolChain: ctx.participant.toolChain,
  });

  return ctx.store.insert({
    kind: "procedural",
    subKind: "workflow_play",
    ...scope,
    definitionId: ctx.participant.definitionId, // 起始归属是产生者；project_shared 让别人也能用
    visibility: writeVisibility(ctx.summary),
    contentJson: {
      summary: `auto-play(${ctx.participant.role}): ${ctx.participant.toolChain
        .slice(0, 6)
        .join(" → ")}${ctx.participant.toolChain.length > 6 ? " → …" : ""}`,
      body,
    },
    tagsJson: ["rule:R2", `role:${ctx.participant.role}`],
    metadataJson: { signature },
    validFrom: ctx.summary.endedAt ?? new Date().toISOString(),
    sourceRunId: ctx.summary.workflowRunId,
    qualityScore: 0.5,
  });
});

// ── R3: research / orchestrator + 有 final_answer → semantic.iteration_summary ─

const ITERATION_ROLES = new Set(["research", "orchestrator", "analyst", "analyst_research_job"]);

defineRule("R3_iteration_summary", async (ctx) => {
  if (!ITERATION_ROLES.has(ctx.participant.role.toLowerCase())) return null;
  if (!ctx.participant.finalAnswer.trim()) return null;

  const summary = `[${ctx.participant.role}] ${truncate(ctx.summary.goal, 80)} → ${truncate(
    ctx.participant.finalAnswer,
    300
  )}`;

  return ctx.store.insert({
    kind: "semantic",
    subKind: "iteration_summary",
    ...writeScope(ctx.summary),
    definitionId: null,
    visibility: writeVisibility(ctx.summary),
    contentJson: {
      summary,
      body: ctx.participant.finalAnswer,
      goal: ctx.summary.goal,
      role: ctx.participant.role,
    },
    tagsJson: ["rule:R3", `role:${ctx.participant.role}`, `mode:${ctx.summary.mode}`],
    validFrom: ctx.summary.endedAt ?? new Date().toISOString(),
    sourceRunId: ctx.summary.workflowRunId,
    qualityScore: 0.4,
  });
});

// ── R4: regime 关键词 → semantic.regime ───────────────────────────────────────

const REGIME_REGEX = /\b(risk[\s_-]?on|risk[\s_-]?off|高波|低波|牛市|熊市|震荡市|regime)\b/i;

defineRule("R4_regime", async (ctx) => {
  const answer = ctx.participant.finalAnswer?.trim() ?? "";
  if (!answer || !REGIME_REGEX.test(answer)) return null;

  const asof = (ctx.summary.endedAt ?? new Date().toISOString()).slice(0, 10);
  let label = "unknown";
  const lower = answer.toLowerCase();
  if (/risk[\s_-]?off|熊市|避险/.test(lower)) label = "risk_off";
  else if (/risk[\s_-]?on|牛市|风险偏好/.test(lower)) label = "risk_on";
  else if (/震荡|高波|低波/.test(lower)) label = "range";

  return ctx.store.insert({
    kind: "semantic",
    subKind: "regime",
    ...writeScope(ctx.summary),
    definitionId: null,
    visibility: writeVisibility(ctx.summary),
    contentJson: {
      summary: `[regime] ${label} · ${truncate(answer, 200)}`,
      body: answer,
    },
    tagsJson: ["rule:R4", `regime:${label}`, "tier:intermediate"],
    metadataJson: {
      market: "unknown",
      label,
      asof,
      confidence: 0.55,
      memoryTier: "intermediate",
    },
    validFrom: ctx.summary.endedAt ?? new Date().toISOString(),
    sourceRunId: ctx.summary.workflowRunId,
    qualityScore: 0.5,
  });
});

// ── R5: research_conclusion（需过 zod；缺字段则跳过）──────────────────────────

defineRule("R5_research_conclusion", async (ctx) => {
  if (!ITERATION_ROLES.has(ctx.participant.role.toLowerCase())) return null;
  const answer = ctx.participant.finalAnswer?.trim() ?? "";
  if (!answer) return null;

  const { validateResearchConclusionMeta } = await import("../../context/finance-memory-schemas");

  const symbols = extractSymbolsFromText(`${ctx.summary.goal}\n${answer}`);
  if (symbols.length === 0) return null;

  let stance: "bull" | "bear" | "neutral" | "hold" | "unknown" = "unknown";
  const lower = answer.toLowerCase();
  if (/看多|做多|bullish|\bbull\b|上破|买入/.test(lower)) stance = "bull";
  else if (/看空|做空|bearish|\bbear\b|下破|卖出/.test(lower)) stance = "bear";
  else if (/中性|观望|hold|震荡/.test(lower)) stance = "neutral";

  const asof = (ctx.summary.endedAt ?? new Date().toISOString()).slice(0, 10);
  const meta = {
    symbols,
    stance,
    confidence: 0.55,
    asof,
    thesis: truncate(answer, 400),
    workflowRunId: ctx.summary.workflowRunId,
    memoryTier: "intermediate" as const,
  };
  const validated = validateResearchConclusionMeta(meta);
  if (!validated.ok) return null;

  return ctx.store.insert({
    kind: "semantic",
    subKind: "research_conclusion",
    ...writeScope(ctx.summary),
    definitionId: null,
    visibility: writeVisibility(ctx.summary),
    contentJson: {
      summary: `[conclusion/${stance}] ${symbols.slice(0, 3).join(",")} · ${truncate(answer, 160)}`,
      body: answer,
    },
    tagsJson: [
      "rule:R5",
      `stance:${stance}`,
      "tier:intermediate",
      ...symbols.slice(0, 5).map((s) => `symbol:${s}`),
    ],
    metadataJson: validated.data,
    validFrom: ctx.summary.endedAt ?? new Date().toISOString(),
    sourceRunId: ctx.summary.workflowRunId,
    qualityScore: 0.55,
  });
});

// ── R6: WorkingMemory snapshot → semantic.research_state ─────────────────────

defineRule("R6_research_state", async (ctx) => {
  const wm = ctx.participant.workingMemory;
  if (!wm) return null;

  const hasContent =
    wm.hypotheses.length > 0 || wm.decisions.length > 0 || wm.open_questions.length > 0;
  if (!hasContent) return null;

  const scope = writeScope(ctx.summary);
  const recent = await ctx.store.query({
    kind: "semantic",
    subKind: "research_state",
    scope: scope.scope,
    scopeId: scope.scopeId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 10,
  });
  const dup = recent.find(
    (e) => e.sourceRunId === ctx.summary.workflowRunId && e.definitionId === ctx.participant.definitionId
  );
  if (dup) return null;

  const summaryParts: string[] = [];
  if (wm.decisions.length > 0) summaryParts.push(`decisions: ${wm.decisions.slice(0, 3).join("; ")}`);
  if (wm.hypotheses.length > 0) {
    summaryParts.push(`hypotheses: ${wm.hypotheses.map((h) => h.text).slice(0, 3).join("; ")}`);
  }
  if (wm.open_questions.length > 0) {
    summaryParts.push(`open: ${wm.open_questions.slice(0, 3).join("; ")}`);
  }

  const symbolTags = wm.finance_refs.symbols
    .slice(0, 5)
    .map((s) => `symbol:${s.toUpperCase()}`);

  return ctx.store.insert({
    kind: "semantic",
    subKind: "research_state",
    ...scope,
    definitionId: ctx.participant.definitionId,
    visibility: writeVisibility(ctx.summary),
    contentJson: {
      summary: `[research_state/${ctx.participant.role}] ${truncate(summaryParts.join(" · "), 200)}`,
      body: renderWorkingMemoryBody(wm),
      workflowRunId: ctx.summary.workflowRunId,
    },
    tagsJson: [
      "rule:R6",
      `role:${ctx.participant.role}`,
      "tier:intermediate",
      ...symbolTags,
    ],
    metadataJson: {
      memoryTier: "intermediate",
      financeRefs: wm.finance_refs,
      role: ctx.participant.role,
    },
    validFrom: ctx.summary.endedAt ?? new Date().toISOString(),
    sourceRunId: ctx.summary.workflowRunId,
    qualityScore: 0.55,
  });
});

// ───────────────────────── 工具函数 ─────────────────────────

function extractSymbolsFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const patterns = [/\b[0-9]{6}(?:\.(?:SH|SZ|BJ))?\b/g, /\b[0-9]{5}\.HK\b/gi, /\b[A-Z]{1,5}\b/g];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const s = m[0]?.toUpperCase();
      if (s.length < 2) continue;
      if (["THE", "AND", "FOR", "WITH", "FROM", "THIS"].includes(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function renderWorkingMemoryBody(wm: WorkingMemory): string {
  const lines: string[] = ["# WorkingMemory snapshot"];
  if (wm.hypotheses.length > 0) {
    lines.push("", "## Hypotheses");
    for (const h of wm.hypotheses.slice(0, 8)) {
      lines.push(`- ${h.text}${h.stance ? ` (${h.stance})` : ""}`);
    }
  }
  if (wm.open_questions.length > 0) {
    lines.push("", "## Open questions");
    for (const q of wm.open_questions.slice(0, 8)) lines.push(`- ${q}`);
  }
  if (wm.decisions.length > 0) {
    lines.push("", "## Decisions");
    for (const d of wm.decisions.slice(0, 8)) lines.push(`- ${d}`);
  }
  if (wm.finance_refs.symbols.length > 0) {
    lines.push("", "## Symbols", wm.finance_refs.symbols.join(", "));
  }
  return lines.join("\n");
}

function renderProceduralBody(input: {
  role: string;
  goal: string;
  toolChain: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# auto-play — ${input.role}`);
  lines.push("");
  lines.push("> 由 Extractor 从一次成功 workflow 自动抽取，待 Recall 命中后由 Janitor 评分。");
  lines.push("");
  lines.push("## 适用场景");
  lines.push(`此 play 由"${truncate(input.goal, 200)}"类目标触发，遇到相似目标可参考。`);
  lines.push("");
  lines.push("## 工具链");
  input.toolChain.forEach((t, i) => lines.push(`${i + 1}. \`${t}\``));
  return lines.join("\n");
}

function warn(eventOrRule: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[experience-extractor] ${eventOrRule} failed: ${msg}`);
}

// 内部 helper 类型；测试可见
export const _internal = { RULES };

// 类型导出
export type _ExtractorContent = ExperienceContent;
export type _ExtractorUnsub = Unsubscribe;
