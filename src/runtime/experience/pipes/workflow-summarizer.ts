/**
 * WorkflowSummarizer Pipe — Wave-1（2026-06-10）。
 *
 * 解决的问题：
 *   - Reflector 只覆盖 failed workflow（completed 抽 10%，且语义是"反思错误"）
 *   - Extractor 是规则式提炼，捕不到"研究员 30 步推理得出的微妙结论"
 *   - 结果：completed workflow 的 narrative 总结基本丢失，后续策略迭代缺乏跨 run 的语义记忆
 *
 * 本 pipe 的策略：
 *   1. 订阅 `workflow_terminal`；只处理 `status=completed`
 *   2. 按 `sampleRate`（默认 100%）+ 单 project 日 token 预算 抽样
 *   3. 从 DB 拉 workflow_run + 最后 N 个 agent_step（带 final_answer/reason）作素材
 *   4. 调 LLM 输出 5 段式 JSON：goal_recap / key_findings / artifacts / lessons / followups
 *   5. 落 `experience(kind=semantic, subKind=workflow_summary, visibility=workspace_shared)`
 *
 * 关键设计：
 *   - **与 Reflector 解耦**：Reflector 是 reflective kind（错误后学习）；本 pipe 是
 *     semantic kind（this workflow 做了什么、得出了什么、可复用什么）
 *   - **可注入 LlmCallFn**：单测 stub；生产用 invokeWithFallback 适配器
 *   - **失败仅 warn**：任何阶段（DB 读 / LLM / store 写）失败都不抛出 caller
 *   - **预算控制**：默认 30k token/project/day（与 reflector 同尺度），从 reflection_run.budget 借用
 *
 * 与 ExtractorWorkflowSummary 的区别：
 *   Extractor 是把"工具链 → procedural"做信号摘要；本 pipe 是 LLM 自然语言总结
 *   前者无 LLM、后者要 LLM；两条路径都跑、互不替代
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  workflowRun,
} from "../../../db/sqlite/schema";
import type { ExperienceBus } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";

// ───────────────────────── 类型 ─────────────────────────

export interface SummarizerWorkflowContext {
  workflowRunId: string;
  projectId: string;
  goal: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
  /** 最后 N 个 step 的 reason / final_answer 简介（最多 30 步） */
  recentStepsText: string;
  /** 涉及的 role 集合（去重） */
  rolesInvolved: string[];
  /** 总 step 数 */
  stepCount: number;
}

export interface SummarizerLoader {
  loadContext(workflowRunId: string): Promise<SummarizerWorkflowContext | null>;
}

export type SummarizerLlmCallFn = (prompt: {
  system: string;
  user: string;
}) => Promise<{ text: string; tokensUsed: number }>;

export interface ParsedSummary {
  goalRecap: string;
  keyFindings: string[];
  artifacts: string[];
  lessons: string[];
  followups: string[];
}

export interface SummarizerOptions {
  store: ExperienceStore;
  bus: ExperienceBus;
  loader: SummarizerLoader;
  llm: SummarizerLlmCallFn;
  /** 单 project 日 token 预算；超出走 skipped */
  dailyBudgetTokens?: number;
  /** completed 采样率 0..1，默认 1.0（全采） */
  sampleRate?: number;
  /** 采样源；单测可 stub */
  random?: () => number;
  /** 单测可 mock；生产用 () => new Date() */
  now?: () => Date;
}

export interface SummarizerHandle {
  detach(): void;
  /** 手动触发一次；返回写入的 experience id */
  summarizeOnce(workflowRunId: string): Promise<string | null>;
}

export const DEFAULT_DAILY_BUDGET = 30_000;
export const DEFAULT_SAMPLE_RATE = 1.0;
export const EST_SUMMARY_TOKENS = 1_200;
export const MAX_STEPS_FOR_PROMPT = 30;

// ───────────────────────── 全局预算计数（单进程） ─────────────────────────

/**
 * 单进程内的日 token 预算账本。每天 UTC 0 点重置（按 dateKey 重置）。
 * 注：与 reflector 的 `reflectionRunRepo.sumDailyBudgetUsed` 不共享 ——
 * summarizer 不写 reflection_run 表；保留内存账本最简单，重启后归零的代价可接受
 * （日预算本质是流量保护，重启后短暂超额一次不致命）。
 */
const _budgetState: { dateKey: string; usedByProject: Map<string, number> } = {
  dateKey: "",
  usedByProject: new Map(),
};

function dateKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getBudgetUsed(projectId: string, now: Date): number {
  const key = dateKeyOf(now);
  if (key !== _budgetState.dateKey) {
    _budgetState.dateKey = key;
    _budgetState.usedByProject.clear();
  }
  return _budgetState.usedByProject.get(projectId) ?? 0;
}

function addBudgetUsed(projectId: string, tokens: number, now: Date): void {
  const key = dateKeyOf(now);
  if (key !== _budgetState.dateKey) {
    _budgetState.dateKey = key;
    _budgetState.usedByProject.clear();
  }
  _budgetState.usedByProject.set(
    projectId,
    (_budgetState.usedByProject.get(projectId) ?? 0) + tokens
  );
}

/** 仅供单测：清空预算账本 */
export function _resetSummarizerBudgetForTesting(): void {
  _budgetState.dateKey = "";
  _budgetState.usedByProject.clear();
}

// ───────────────────────── 公共启动入口 ─────────────────────────

export function startWorkflowSummarizerPipe(opts: SummarizerOptions): SummarizerHandle {
  const off = opts.bus.subscribe("workflow_terminal", async (ev) => {
    if (ev.status !== "completed") return;
    try {
      await summarizeOnceInternal(opts, ev.workflowRunId);
    } catch (err) {
      console.warn(`[workflow-summarizer] handler failed wf=${ev.workflowRunId}: ${errToStr(err)}`);
    }
  });
  return {
    detach() {
      off();
    },
    summarizeOnce: (id) => summarizeOnceInternal(opts, id),
  };
}

// ───────────────────────── 核心 ─────────────────────────

async function summarizeOnceInternal(
  opts: SummarizerOptions,
  workflowRunId: string
): Promise<string | null> {
  const now = (opts.now ?? (() => new Date()))();
  const rand = (opts.random ?? Math.random)();
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const dailyBudget = opts.dailyBudgetTokens ?? DEFAULT_DAILY_BUDGET;

  if (rand > sampleRate) return null;

  const ctx = await opts.loader.loadContext(workflowRunId);
  if (!ctx) return null;

  const used = getBudgetUsed(ctx.projectId, now);
  if (used + EST_SUMMARY_TOKENS > dailyBudget) {
    console.log(
      `[workflow-summarizer] skipped wf=${workflowRunId} project=${ctx.projectId} ` +
        `used=${used} budget=${dailyBudget}`
    );
    return null;
  }

  let llmRes: { text: string; tokensUsed: number };
  try {
    llmRes = await opts.llm(buildSummaryPrompt(ctx));
  } catch (err) {
    console.warn(`[workflow-summarizer] llm failed wf=${workflowRunId}: ${errToStr(err)}`);
    return null;
  }
  addBudgetUsed(ctx.projectId, llmRes.tokensUsed, now);

  const parsed = parseSummaryJson(llmRes.text);
  if (!parsed) {
    console.warn(
      `[workflow-summarizer] llm output unparsable wf=${workflowRunId}; first 200 chars: ${llmRes.text.slice(0, 200)}`
    );
    return null;
  }

  try {
    const inserted = await opts.store.insert({
      kind: "semantic",
      subKind: "workflow_summary",
      scope: "project",
      scopeId: ctx.projectId,
      visibility: "workspace_shared",
      contentJson: {
        summary: parsed.goalRecap,
        body: renderSummaryBody(parsed, ctx),
        workflowRunId,
        sourceStatus: "completed",
        keyFindings: parsed.keyFindings,
        artifacts: parsed.artifacts,
        lessons: parsed.lessons,
        followups: parsed.followups,
      },
      tagsJson: [
        "workflow_summary",
        `mode:${ctx.mode}`,
        `roles:${ctx.rolesInvolved.join("+")}`,
      ],
      validFrom: now.toISOString(),
      sourceRunId: workflowRunId,
      // semantic 总结质量中等；后续 Janitor 会按召回 / 执行重算
      qualityScore: 0.6,
    });
    return inserted.id;
  } catch (err) {
    console.warn(`[workflow-summarizer] store.insert failed wf=${workflowRunId}: ${errToStr(err)}`);
    return null;
  }
}

// ───────────────────────── Prompt / Parse ─────────────────────────

const SUMMARY_SYSTEM_PROMPT = `你是一位资深量化研究 PM 助理。
你的任务：阅读一个 workflow 的目标和关键步骤，把它浓缩成可被其它 agent 召回复用的 5 段式总结。

输出严格遵守以下 JSON schema，禁止任何多余文字。所有字段必填，键名英文。`;

const SUMMARY_SCHEMA_HINT = `\`\`\`json
{
  "goal_recap": "用 1-2 句话复述这个 workflow 解决了什么问题",
  "key_findings": ["关键发现 1（具体、可量化）", "关键发现 2", "..."],
  "artifacts": ["产出的因子/策略/报告/order_intent 名（最多 5 个）"],
  "lessons": ["执行过程中验证有效的招式 1", "招式 2", "..."],
  "followups": ["下一步可探索的方向 1", "方向 2"]
}
\`\`\``;

export function buildSummaryPrompt(ctx: SummarizerWorkflowContext): {
  system: string;
  user: string;
} {
  const stepsBlock = ctx.recentStepsText.slice(0, 6_000);
  const user = [
    `# Workflow ${ctx.workflowRunId.slice(0, 8)} 总结请求`,
    "",
    `- mode: ${ctx.mode}`,
    `- 涉及 role：${ctx.rolesInvolved.join(", ") || "n/a"}`,
    `- 步数：${ctx.stepCount}`,
    `- 起止：${ctx.startedAt} → ${ctx.endedAt ?? "n/a"}`,
    "",
    `## 目标`,
    ctx.goal.slice(0, 800),
    "",
    `## 最后 ${MAX_STEPS_FOR_PROMPT} 步素材（reason + final_answer 摘要）`,
    stepsBlock || "[no_steps]",
    "",
    `## 输出要求`,
    SUMMARY_SCHEMA_HINT,
  ].join("\n");
  return { system: SUMMARY_SYSTEM_PROMPT, user };
}

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/;

export function parseSummaryJson(raw: string): ParsedSummary | null {
  const m = raw.match(FENCED_JSON_RE);
  const blob = m?.[1]?.trim() ?? raw.trim();
  try {
    const obj = JSON.parse(blob) as Record<string, unknown>;
    const goalRecap = String(obj["goal_recap"] ?? "").trim();
    if (!goalRecap) return null;
    const asArr = (k: string): string[] => {
      const v = obj[k];
      if (!Array.isArray(v)) return [];
      return v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
    };
    return {
      goalRecap,
      keyFindings: asArr("key_findings"),
      artifacts: asArr("artifacts"),
      lessons: asArr("lessons"),
      followups: asArr("followups"),
    };
  } catch {
    return null;
  }
}

function renderSummaryBody(parsed: ParsedSummary, ctx: SummarizerWorkflowContext): string {
  return [
    `## Goal`,
    parsed.goalRecap,
    "",
    `## Key Findings`,
    parsed.keyFindings.map((s) => `- ${s}`).join("\n") || "(none)",
    "",
    `## Artifacts`,
    parsed.artifacts.map((s) => `- ${s}`).join("\n") || "(none)",
    "",
    `## Lessons`,
    parsed.lessons.map((s) => `- ${s}`).join("\n") || "(none)",
    "",
    `## Followups`,
    parsed.followups.map((s) => `- ${s}`).join("\n") || "(none)",
    "",
    `---`,
    `mode=${ctx.mode} · roles=${ctx.rolesInvolved.join(",")} · steps=${ctx.stepCount}`,
  ].join("\n");
}

// ───────────────────────── 默认 Sqlite loader ─────────────────────────

/**
 * 默认 loader：直接从 DB 读 workflow_run + 最后 N 个 agent_step。
 * 单测可换成 InMemory fake。
 */
export const sqliteSummarizerLoader: SummarizerLoader = {
  async loadContext(workflowRunId: string): Promise<SummarizerWorkflowContext | null> {
    try {
      const db = await getDb();
      const wfRow = await db
        .select({
          id: workflowRun.id,
          projectId: workflowRun.projectId,
          goal: workflowRun.goal,
          mode: workflowRun.mode,
          status: workflowRun.status,
          startedAt: workflowRun.startedAt,
          endedAt: workflowRun.endedAt,
        })
        .from(workflowRun)
        .where(eq(workflowRun.id, workflowRunId))
        .limit(1);
      const wf = wfRow[0];
      if (!wf || wf.status !== "completed") return null;

      /**
       * 修复（P0 2026-06）：agent_step 没有 role / reasonText / finalAnswer 列（原实现引用
       * 不存在列，运行时取到 undefined）。role 改走 agent_instance→agent_definition join；
       * reason 用 agent_step.thought；final_answer 文本只能 best-effort 从 actionJson 取。
       */
      const defs = await db
        .select({ id: agentDefinition.id, role: agentDefinition.role })
        .from(agentDefinition);
      const defRole = new Map(defs.map((d) => [d.id, d.role]));
      const instRows = await db
        .select({ id: agentInstance.id, definitionId: agentInstance.definitionId })
        .from(agentInstance)
        .where(eq(agentInstance.workflowRunId, workflowRunId));
      const instRole = new Map(
        instRows.map((i) => [i.id, defRole.get(i.definitionId) ?? "unknown"])
      );

      const stepRows = await db
        .select({
          agentInstanceId: agentStep.agentInstanceId,
          thought: agentStep.thought,
          actionType: agentStep.actionType,
          actionJson: agentStep.actionJson,
          createdAt: agentStep.createdAt,
        })
        .from(agentStep)
        .where(eq(agentStep.workflowRunId, workflowRunId))
        .orderBy(desc(agentStep.createdAt))
        .limit(MAX_STEPS_FOR_PROMPT);

      // 按时间正序还原
      stepRows.reverse();
      const rolesInvolved = [
        ...new Set(stepRows.map((s) => instRole.get(s.agentInstanceId) ?? "unknown")),
      ];
      const recentStepsText = stepRows
        .map((s, i) => {
          const role = instRole.get(s.agentInstanceId) ?? "unknown";
          const reason = (s.thought ?? "").slice(0, 280);
          const final =
            s.actionType === "final_answer"
              ? (typeof s.actionJson === "string"
                  ? s.actionJson
                  : JSON.stringify(s.actionJson ?? "")
                ).slice(0, 280)
              : "";
          const parts = [`### step ${i + 1} · ${role}`];
          if (reason) parts.push(`reason: ${reason}`);
          if (final) parts.push(`final_answer: ${final}`);
          return parts.join("\n");
        })
        .join("\n\n");

      return {
        workflowRunId,
        projectId: wf.projectId,
        goal: wf.goal ?? "",
        mode: wf.mode ?? "",
        startedAt: wf.startedAt instanceof Date ? wf.startedAt.toISOString() : String(wf.startedAt),
        endedAt: wf.endedAt instanceof Date ? wf.endedAt.toISOString() : (wf.endedAt as string | null),
        recentStepsText,
        rolesInvolved,
        stepCount: stepRows.length,
      };
    } catch (err) {
      console.warn(
        `[workflow-summarizer] sqlite loader failed wf=${workflowRunId}: ${errToStr(err)}`
      );
      return null;
    }
  },
};

// ───────────────────────── helpers ─────────────────────────

function errToStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
