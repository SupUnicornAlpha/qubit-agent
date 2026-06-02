/**
 * Reflector Pipe — Memory V2 P1（详见 docs/MEMORY_V2_DESIGN.md §6.5）。
 *
 * 唯一职责：监听 workflow_terminal 与 hitl_feedback 事件，对 failed 工作流
 * **必反思**（带预算 + 24h 签名去重）；对 completed 抽样 10% 反思。
 * 反思产物落 `experience(kind=reflective, visibility=agent_private)`，
 * 与 episodic 用 `derive_from` 链建立可追溯关系。
 *
 * 三大约束（直接落进代码）：
 *   1. **agent_private 隔离**（用户决策 4）：reflective 必填 definitionId，
 *      visibility 强制 agent_private；Recall 层只放回给本 agent。
 *   2. **24h failure_signature 去重**：同 (role, tool_name, error_class, mode) 24h
 *      内只反思一次；其它命中走 reflection_run(status=skipped_dedup)。
 *   3. **project 级日预算**：默认 30k tokens/项目/天；超额走 skipped_budget。
 *
 * 与 LLM 的关系：
 *   - 注入 `LlmCallFn` 接口而不是直接 import gateway —— 单测可 stub；生产路径
 *     由 caller（onWorkflowTerminal 或 self-improve-loop 消费者）注入 invokeWithFallback。
 *   - LLM 输出必须是 fenced JSON block；解析失败重试 1 次后 status=failed。
 *
 * 与 ExperienceBus 的关系：
 *   仅订阅；不主动 emit（写完 experience 后由 Writer 自动统计 op_log 通过别的事件流）。
 */

import { createHash } from "node:crypto";
import type { ReflectionScope } from "../../../types/entities";
import type { ExperienceBus } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";
import { type ReflectionRunRepo, getReflectionRunRepo } from "../reflection-run-repo";

// ───────────────────────── 类型 ─────────────────────────

export interface ReflectorWorkflowContext {
  workflowRunId: string;
  projectId: string;
  status: "completed" | "failed";
  mode: string;
  goal: string;
  /** 失败时最常出现的 (role, tool_name, error_class) 组合，用于签名 */
  failureHint?: {
    role: string;
    toolName: string;
    errorClass: string;
  };
  /** 反思要写到哪个 agent 的私有空间；若为 null 则用 fallback 'orchestrator' */
  definitionId: string | null;
  /** 反思素材 —— Reflector 不再去 DB 重读 step，让 caller 喂熟 */
  episodicIds: string[];
  recentStepsText: string;
}

export interface ReflectorLoader {
  loadContext(workflowRunId: string): Promise<ReflectorWorkflowContext | null>;
}

/** caller 注入的 LLM 调用；返回原始文本（含 fenced json block） */
export type LlmCallFn = (prompt: { system: string; user: string }) => Promise<{
  text: string;
  tokensUsed: number;
}>;

export interface ReflectorOptions {
  store: ExperienceStore;
  bus: ExperienceBus;
  loader: ReflectorLoader;
  llm: LlmCallFn;
  /** 反思留痕存储；不传走 default Sqlite 实现 */
  reflectionRepo?: ReflectionRunRepo;
  /** 单测可 mock；生产用 () => new Date() */
  now?: () => Date;
  /** 单 project 日预算（tokens） */
  dailyBudgetTokens?: number;
  /** completed 抽样率 0..1 */
  sampleCompletedRate?: number;
  /** 抽样源；单测可 stub */
  random?: () => number;
}

export interface ReflectorHandle {
  detach(): void;
  /** 同步触发一次反思；返回 reflection_run.id + status */
  reflectOnce(
    workflowRunId: string
  ): Promise<{ runId: string; status: string; producedIds: string[] }>;
}

export const DEFAULT_DAILY_BUDGET = 30_000;
export const DEFAULT_SAMPLE_RATE = 0.1;
export const MAX_REFLECTIVE_PER_RUN = 5;
/** 单次反思的 token 估算上限；用于预算的"预扣减式"检查，避免最后一笔超额。 */
export const EST_REFLECTION_TOKENS = 1_500;

// ───────────────────────── 公共启动入口 ─────────────────────────

export function startReflectorPipe(opts: ReflectorOptions): ReflectorHandle {
  const off = opts.bus.subscribe("workflow_terminal", async (ev) => {
    try {
      await reflectOnceWithMetrics(opts, ev.workflowRunId);
    } catch (err) {
      warn("workflow_terminal", err);
    }
  });

  return {
    detach() {
      off();
    },
    reflectOnce: (id) => reflectOnceWithMetrics(opts, id),
  };
}

/**
 * 内部 wrapper：跑完 reflectOnce 后 emit 一条 `maintenance_run(kind=reflector_daily)`
 * 上 Bus，让 metrics collector 能按 status 计数。
 * 失败不阻塞 caller —— emit 自身只是同步发布给已订阅 handler。
 */
async function reflectOnceWithMetrics(
  opts: ReflectorOptions,
  workflowRunId: string
): Promise<{ runId: string; status: string; producedIds: string[] }> {
  const res = await reflectOnceInternal(opts, workflowRunId);
  try {
    opts.bus.emit({
      type: "maintenance_run",
      kind: "reflector_daily",
      actor: "reflector",
      summary: {
        status: res.status,
        producedCount: res.producedIds.length,
        workflowRunId,
      },
    });
  } catch (e) {
    warn("emit_maintenance", e);
  }
  return res;
}

// ───────────────────────── 核心流程 ─────────────────────────

async function reflectOnceInternal(
  opts: ReflectorOptions,
  workflowRunId: string
): Promise<{ runId: string; status: string; producedIds: string[] }> {
  const repo = opts.reflectionRepo ?? getReflectionRunRepo();
  const now = (opts.now ?? (() => new Date()))();
  const rand = (opts.random ?? Math.random)();
  const dailyBudget = opts.dailyBudgetTokens ?? DEFAULT_DAILY_BUDGET;
  const sampleRate = opts.sampleCompletedRate ?? DEFAULT_SAMPLE_RATE;

  const ctx = await opts.loader.loadContext(workflowRunId);
  if (!ctx) {
    const failed = await repo.insert({
      scope: "manual",
      subjectRunId: workflowRunId,
      status: "failed",
      errorMessage: "context_not_found",
      now,
    });
    return { runId: failed.runId, status: failed.status, producedIds: [] };
  }

  const scope: ReflectionScope = ctx.status === "failed" ? "workflow_failed" : "workflow_completed";

  // ─── 1. completed 抽样 ───
  if (ctx.status === "completed" && rand > sampleRate) {
    const out = await repo.insert({
      scope,
      subjectRunId: workflowRunId,
      definitionId: ctx.definitionId,
      status: "sampled_out",
      now,
    });
    return { runId: out.runId, status: out.status, producedIds: [] };
  }

  // ─── 2. failure 签名去重（24h 内同签名只反思一次） ───
  const failureSignature = ctx.status === "failed" ? computeFailureSignature(ctx) : null;
  if (failureSignature) {
    const dedupKey = `${ctx.projectId}|${failureSignature}`;
    const recent = await repo.findRecentBySignature(dedupKey, now, 24 * 60 * 60 * 1000);
    if (recent) {
      const out = await repo.insert({
        scope,
        subjectRunId: workflowRunId,
        definitionId: ctx.definitionId,
        failureSignature: dedupKey,
        status: "skipped_dedup",
        now,
      });
      return { runId: out.runId, status: out.status, producedIds: [] };
    }
  }

  // ─── 3. project 日 token 预算（预扣减式：已用 + 单次估算 > 预算 即跳过） ───
  const used = await repo.sumDailyBudgetUsed(ctx.projectId, now);
  if (used + EST_REFLECTION_TOKENS > dailyBudget) {
    const out = await repo.insert({
      scope,
      subjectRunId: workflowRunId,
      definitionId: ctx.definitionId,
      failureSignature: failureSignature ? `${ctx.projectId}|${failureSignature}` : null,
      status: "skipped_budget",
      now,
    });
    return { runId: out.runId, status: out.status, producedIds: [] };
  }

  // ─── 4. 真跑 LLM 反思 ───
  const runRow = await repo.insert({
    scope,
    subjectRunId: workflowRunId,
    definitionId: ctx.definitionId,
    failureSignature: failureSignature ? `${ctx.projectId}|${failureSignature}` : null,
    status: "running",
    now,
  });

  try {
    const prompt = buildReflectionPrompt(ctx);
    const llmRes = await opts.llm(prompt);
    let lessons = parseReflectionJson(llmRes.text);
    let totalTokens = llmRes.tokensUsed;
    if (lessons.length === 0) {
      const retry = await opts.llm({
        system: prompt.system,
        user: `${prompt.user}\n\n上一次输出无法解析；请严格按以下 JSON schema 重新输出：\n${REFLECTION_SCHEMA_HINT}`,
      });
      totalTokens += retry.tokensUsed;
      lessons = parseReflectionJson(retry.text);
      if (lessons.length === 0) {
        await repo.update(runRow.runId, {
          status: "failed",
          budgetTokensUsed: totalTokens,
          errorMessage: "llm_unparsable_twice",
          endedAt: nowIso(opts),
        });
        return { runId: runRow.runId, status: "failed", producedIds: [] };
      }
    }

    const producedIds: string[] = [];
    const cap = Math.min(MAX_REFLECTIVE_PER_RUN, lessons.length);
    for (let i = 0; i < cap; i++) {
      const lesson = lessons[i];
      if (!lesson) continue;
      try {
        const exp = await opts.store.insert({
          kind: "reflective",
          subKind: lesson.subKind,
          scope: "project",
          scopeId: ctx.projectId,
          // ← 用户决策 4：reflective 隔离到产生者 agent
          definitionId: ctx.definitionId ?? "orchestrator",
          visibility: "agent_private",
          contentJson: {
            summary: lesson.summary,
            body: lesson.body,
            workflowRunId,
            sourceStatus: ctx.status,
          },
          tagsJson: [
            ...lesson.tags,
            `workflow_status:${ctx.status}`,
            ...(failureSignature ? [`signature:${failureSignature}`] : []),
          ],
          validFrom: nowIso(opts),
          sourceRunId: workflowRunId,
          qualityScore: ctx.status === "failed" ? 0.7 : 0.5,
        });
        producedIds.push(exp.id);
        for (const epId of ctx.episodicIds) {
          try {
            await opts.store.linkAdd(exp.id, epId, "derive_from", 1.0);
          } catch (e) {
            warn("linkAdd", e);
          }
        }
      } catch (e) {
        warn("insert_reflective", e);
      }
    }

    await repo.update(runRow.runId, {
      status: "completed",
      budgetTokensUsed: totalTokens,
      producedExperienceIdsJson: producedIds,
      endedAt: nowIso(opts),
    });
    return { runId: runRow.runId, status: "completed", producedIds };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await repo.update(runRow.runId, {
      status: "failed",
      errorMessage: msg.slice(0, 800),
      endedAt: nowIso(opts),
    });
    return { runId: runRow.runId, status: "failed", producedIds: [] };
  }
}

// ───────────────────────── 失败签名 ─────────────────────────

export function computeFailureSignature(ctx: ReflectorWorkflowContext): string {
  if (!ctx.failureHint) return "no_hint";
  const seed = `${ctx.failureHint.role}|${ctx.failureHint.toolName}|${ctx.failureHint.errorClass}|${ctx.mode}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

function nowIso(opts: ReflectorOptions): string {
  return (opts.now ?? (() => new Date()))().toISOString();
}

// ───────────────────────── LLM prompt / parse ─────────────────────────

const REFLECTION_SCHEMA_HINT = `\`\`\`json
{
  "lessons": [
    {
      "subKind": "failure_mode" | "preference" | "playbook_correction",
      "summary": "一句话总结（≤ 80 字）",
      "body": "详细分析，可含 Markdown",
      "tags": ["tool:foo", "error:timeout"]
    }
  ]
}
\`\`\``;

/**
 * Few-shot 示例：给模型示范"什么是高质量 lesson"。
 * 选取原则：
 *   - 失败案例（让模型看清"什么错值得记")
 *   - 行动可立即落地（"调用前 assert universe>=20"，不是"要更细心"）
 *   - body 含错误链路，不是空泛建议
 */
export const REFLECTION_FEWSHOT = `
**示例 1（failed workflow）**
输入摘要：
  目标：评估 momentum_20d 在 CN-A 的有效性
  失败提示：role=research tool=factor.discoveryRun err=TimeoutError
  步骤：discoveryRun 在 universe=12 (CN-A 子集) 上跑了 95s 后 timeout

输出：
\`\`\`json
{
  "lessons": [
    {
      "subKind": "failure_mode",
      "summary": "factor.discoveryRun 在 universe<20 时容易 timeout",
      "body": "本次 universe=12, 时长 95s 后 timeout。下次调 discoveryRun 前先 assert universe.size >= 20；不满足时改用 fast_mode=true 或先 factor.list 拉宽再筛。",
      "tags": ["tool:factor.discoveryRun", "error:timeout", "fix:assert_universe_size"]
    }
  ]
}
\`\`\`

**示例 2（completed workflow，命中了某种 preference）**
输入摘要：
  目标：写一份 CSI300 周回顾
  步骤：用 Markdown 表格列了 5 个板块涨跌 → 用户改成 ascii 柱图后留下了

输出：
\`\`\`json
{
  "lessons": [
    {
      "subKind": "preference",
      "summary": "对 CSI300 类周报，用户偏好 ascii 柱图而非 Markdown 表格",
      "body": "user 把 Markdown 涨跌表改成 ascii bar chart 后保留。后续周回顾默认用 \\"sector | ▇▇▇▇ +1.2%\\" 这种形式。",
      "tags": ["report:weekly_review", "preference:ascii_chart"]
    }
  ]
}
\`\`\`

**反例（禁止输出空洞建议）**
\`\`\`json
{
  "lessons": [
    {
      "subKind": "failure_mode",
      "summary": "要更仔细",
      "body": "下次注意一点",
      "tags": []
    }
  ]
}
\`\`\`
（无具体动作 / 无 tags / 无可复用性 — 这种 lesson 价值为零，应输出 {"lessons": []}）
`.trim();

export interface BuildReflectionPromptOptions {
  /** 默认 true；单测 / playback 想 A/B 对比时可关掉 */
  includeFewShot?: boolean;
}

export function buildReflectionPrompt(
  ctx: ReflectorWorkflowContext,
  opts: BuildReflectionPromptOptions = {}
): { system: string; user: string } {
  const includeFewShot = opts.includeFewShot ?? true;

  const systemParts = [
    "你是一名负责复盘自身行为的反思 Agent。",
    "你的任务：对一次工作流执行（可能失败也可能完成）做结构化复盘，识别出**可下次重用**的 lesson。",
    "",
    "## 输出约束",
    " 1. 严格 JSON（包在 ```json fenced block 中），符合下方 schema；",
    " 2. lessons 数量 ≤ 5；每条 summary ≤ 80 字、body 尽量精炼但要写清楚『下次怎么做』；",
    " 3. 每条 lesson 必须满足 3 个要求：可复现的失败模式（或可复用的成功偏好） + 具体到工具/参数的纠偏动作 + 至少 1 个 tag；",
    ' 4. 禁止空洞反思（如『要更努力 / 注意一点 / 加强测试』之类）；这类一律输出 {"lessons": []}。',
    " 5. subKind 三选一：failure_mode（失败模式）/ preference（用户偏好）/ playbook_correction（已有 playbook 的修正）。",
    "",
    "## Schema",
    REFLECTION_SCHEMA_HINT,
  ];
  if (includeFewShot) {
    systemParts.push("", "## 示例", REFLECTION_FEWSHOT);
  }
  const system = systemParts.join("\n");

  const user = [
    `**工作流**：${ctx.workflowRunId}`,
    `**项目**：${ctx.projectId}`,
    `**目标**：${ctx.goal}`,
    `**模式**：${ctx.mode}`,
    `**结果**：${ctx.status}`,
    ctx.failureHint
      ? `**失败提示**：role=${ctx.failureHint.role} tool=${ctx.failureHint.toolName} err=${ctx.failureHint.errorClass}`
      : "",
    "",
    "**最近步骤摘要**：",
    ctx.recentStepsText.slice(0, 4000),
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

// ───────────────────────── Playback (调优用) ─────────────────────────

export interface ReflectionPlaybackResult {
  prompt: { system: string; user: string };
  rawText: string;
  parsed: ParsedLesson[];
  tokensUsed: number;
  /** 若解析失败的原因 */
  parseError?: string;
}

/**
 * 不落库地跑一次反思，返回 LLM raw / 解析结果，用于 prompt 调优 / 评估。
 * 与 reflectOnce 的区别：不写 experience / reflection_run，纯函数视角。
 */
export async function playReflectionOnce(input: {
  ctx: ReflectorWorkflowContext;
  llm: LlmCallFn;
  promptOptions?: BuildReflectionPromptOptions;
}): Promise<ReflectionPlaybackResult> {
  const prompt = buildReflectionPrompt(input.ctx, input.promptOptions);
  const res = await input.llm(prompt);
  const parsed = parseReflectionJson(res.text);
  const result: ReflectionPlaybackResult = {
    prompt,
    rawText: res.text,
    parsed,
    tokensUsed: res.tokensUsed,
  };
  if (parsed.length === 0) {
    result.parseError = "no_lessons_or_unparsable";
  }
  return result;
}

/**
 * 把人写的 ground-truth lessons 与 LLM 输出做粗略对比，返回每条 ground-truth 是否
 * 在输出里"近似命中"（subKind 一致 + summary 至少有 2 个 token 重合）。
 * 用于回归"换了 prompt 后召回率有无下降"。
 */
export interface LessonsEvalResult {
  truthCount: number;
  predictedCount: number;
  hit: number;
  hitRate: number;
  missed: string[]; // ground-truth.summary 未命中的列表
}

export function evalLessonsAgainstGroundTruth(
  predicted: ParsedLesson[],
  truth: ParsedLesson[]
): LessonsEvalResult {
  let hit = 0;
  const missed: string[] = [];
  for (const t of truth) {
    const tTokens = simpleTokens(t.summary);
    const ok = predicted.some(
      (p) => p.subKind === t.subKind && overlapTokens(simpleTokens(p.summary), tTokens) >= 2
    );
    if (ok) hit += 1;
    else missed.push(t.summary);
  }
  return {
    truthCount: truth.length,
    predictedCount: predicted.length,
    hit,
    hitRate: truth.length === 0 ? 1 : hit / truth.length,
    missed,
  };
}

function simpleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `)
    .split(/[\s,.;:!?()\[\]{}"'，。；：！？（）「」『』]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function overlapTokens(a: string[], b: string[]): number {
  const setA = new Set(a);
  let n = 0;
  for (const t of b) if (setA.has(t)) n += 1;
  return n;
}

export interface ParsedLesson {
  subKind: string;
  summary: string;
  body: string;
  tags: string[];
}

export function parseReflectionJson(text: string): ParsedLesson[] {
  const fence = /```json\s*([\s\S]*?)```/i.exec(text);
  const raw = fence?.[1]?.trim();
  if (!raw) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  const lessons = (obj as { lessons?: unknown[] }).lessons;
  if (!Array.isArray(lessons)) return [];
  const out: ParsedLesson[] = [];
  for (const item of lessons) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const subKind = typeof o.subKind === "string" ? (o.subKind as string) : "failure_mode";
    const summary = typeof o.summary === "string" ? (o.summary as string).trim() : "";
    const body = typeof o.body === "string" ? (o.body as string).trim() : "";
    const tags = Array.isArray(o.tags)
      ? (o.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    if (!summary) continue;
    out.push({ subKind, summary, body, tags });
  }
  return out;
}

function warn(eventOrStage: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[experience-reflector] ${eventOrStage} failed: ${msg}`);
}
