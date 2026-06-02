/**
 * Memory V2 P1.5 — 双写期对账（Reconciliation）。
 *
 * 背景：P1 期间 onWorkflowTerminal 同时驱动两条管道
 *   - 旧路径：`consolidateFromWorkflow` → midterm_memory + agent_skill
 *   - 新路径：`Extractor / Reflector` → experience(kind in {semantic, procedural, reflective})
 * 必须有"一周对账无 drift"作为下线旧路径的客观依据；本模块即此对账工具。
 *
 * 对账维度（项目粒度，对所有 completed workflow 走一遍）：
 *
 *   D1 semantic / iteration_summary 与 midterm_memory(memory_type=strategy_iteration|risk_review|...)
 *      对账：按 `sourceRunId === midterm_memory.contentJson.workflowRunId` 关联，统计
 *      只在 A 不在 B / 只在 B 不在 A 的条数。
 *
 *   D2 procedural / workflow_play 与 agent_skill(state in {pending_review, active})
 *      对账：按 `metadataJson.signature === skill.body 中的 <!-- signature: xxx --> 注释` 关联，
 *      统计只在 A 不在 B / 只在 B 不在 A 的条数。
 *
 *   D3 reflective：旧路径无对应，本期仅统计总数和 sub_kind 分布作为"P1 自身收益"基线。
 *
 * 输出：纯数据，由调用者（CLI / API / 监控面板）按需展示；不打印副作用，便于单测。
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, midtermMemory, workflowRun } from "../../db/sqlite/schema";
import type { Experience } from "../../types/entities";
import { getExperienceStore } from "./experience-store";

// ───────────────────────── 报告结构 ─────────────────────────

export interface ReconcileSemanticDiff {
  /** 旧表有但新表没的 workflowRunId 列表（最多前 N 条详情，N=10） */
  onlyOldWorkflowIds: string[];
  /** 新表有但旧表没的 workflowRunId 列表 */
  onlyNewWorkflowIds: string[];
  /** 双方都有的 workflowRunId 总数 */
  bothCount: number;
}

export interface ReconcileProceduralDiff {
  /** 旧表 agent_skill 有但新表 procedural 没的 signature */
  onlyOldSignatures: string[];
  /** 新表 procedural 有但旧表 agent_skill 没的 signature */
  onlyNewSignatures: string[];
  bothCount: number;
}

export interface ReconcileReflectiveStats {
  total: number;
  bySubKind: Record<string, number>;
  /** 最近 7 天写入数（看 P1 Reflector 实际跑量） */
  recent7d: number;
}

export interface ReconcileReport {
  projectId: string;
  /** workflow 总数（status=completed），分母 */
  completedWorkflowCount: number;
  semantic: ReconcileSemanticDiff;
  procedural: ReconcileProceduralDiff;
  reflective: ReconcileReflectiveStats;
  /** 简短建议：当所有 diff=0 时给"可下线旧路径"绿灯 */
  recommendation: "ok_to_sunset" | "needs_attention";
  /** 人类可读摘要 */
  summary: string;
}

const DETAIL_CAP = 10;

// ───────────────────────── 主入口 ─────────────────────────

export interface ReconcileInput {
  projectId: string;
  /** 仅对账 startedAt >= since 的工作流；默认 7d 前 */
  since?: Date;
  /** Default new Date() */
  now?: Date;
}

export async function reconcileProject(input: ReconcileInput): Promise<ReconcileReport> {
  const now = input.now ?? new Date();
  const since = input.since ?? new Date(now.getTime() - 7 * 86_400_000);

  const db = await getDb();

  // 1) 取项目内 since 之后所有 completed workflow
  const wfRows = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.projectId, input.projectId),
        eq(workflowRun.status, "completed"),
        gte(workflowRun.startedAt, since.toISOString())
      )
    );
  const wfIds = new Set(wfRows.map((r) => r.id));

  // 2) D1 — semantic.iteration_summary vs midterm_memory
  const semantic = await diffSemantic(input.projectId, wfIds);

  // 3) D2 — procedural.workflow_play vs agent_skill
  const procedural = await diffProcedural(input.projectId);

  // 4) D3 — reflective stats
  const reflective = await reflectiveStats(input.projectId, now);

  const drift =
    semantic.onlyOldWorkflowIds.length +
    semantic.onlyNewWorkflowIds.length +
    procedural.onlyOldSignatures.length +
    procedural.onlyNewSignatures.length;
  const recommendation: ReconcileReport["recommendation"] =
    drift === 0 ? "ok_to_sunset" : "needs_attention";

  const summary = renderSummary({
    projectId: input.projectId,
    wfCount: wfIds.size,
    semantic,
    procedural,
    reflective,
    recommendation,
  });

  return {
    projectId: input.projectId,
    completedWorkflowCount: wfIds.size,
    semantic,
    procedural,
    reflective,
    recommendation,
    summary,
  };
}

// ───────────────────────── 子诊断 ─────────────────────────

async function diffSemantic(
  projectId: string,
  wfIdsInWindow: Set<string>
): Promise<ReconcileSemanticDiff> {
  const store = getExperienceStore();
  // 新表：semantic.iteration_summary，按 sourceRunId 索引
  const semanticRows = await store.query({
    kind: "semantic",
    subKind: "iteration_summary",
    scope: "project",
    scopeId: projectId,
    archivalMode: "exclude_archived",
    limit: 5_000,
  });
  const newWf = new Set<string>();
  for (const r of semanticRows) {
    if (r.sourceRunId && wfIdsInWindow.has(r.sourceRunId)) newWf.add(r.sourceRunId);
  }

  // 旧表：midterm_memory，通过 contentJson.workflowRunId 反查
  const db = await getDb();
  const midRows = await db
    .select({ contentJson: midtermMemory.contentJson })
    .from(midtermMemory)
    .where(eq(midtermMemory.projectId, projectId));
  const oldWf = new Set<string>();
  for (const m of midRows) {
    const content = parseContent(m.contentJson);
    const wf =
      typeof content?.workflowRunId === "string" ? (content.workflowRunId as string) : null;
    if (wf && wfIdsInWindow.has(wf)) oldWf.add(wf);
  }

  const onlyOld: string[] = [];
  const onlyNew: string[] = [];
  let both = 0;
  for (const id of oldWf) {
    if (newWf.has(id)) both += 1;
    else onlyOld.push(id);
  }
  for (const id of newWf) {
    if (!oldWf.has(id)) onlyNew.push(id);
  }

  return {
    onlyOldWorkflowIds: onlyOld.slice(0, DETAIL_CAP),
    onlyNewWorkflowIds: onlyNew.slice(0, DETAIL_CAP),
    bothCount: both,
  };
}

async function diffProcedural(projectId: string): Promise<ReconcileProceduralDiff> {
  const store = getExperienceStore();
  // 新表：procedural.workflow_play，signature 在 metadataJson.signature
  const procRows = await store.query({
    kind: "procedural",
    subKind: "workflow_play",
    scope: "project",
    scopeId: projectId,
    archivalMode: "exclude_archived",
    limit: 5_000,
  });
  const newSigs = new Set<string>();
  for (const r of procRows) {
    const sig = r.metadataJson.signature;
    if (typeof sig === "string") newSigs.add(sig);
  }

  // 旧表：agent_skill.bodyMd 末尾的 <!-- signature: xxx -->
  const db = await getDb();
  const skillRows = await db
    .select({ id: agentSkill.id, bodyMd: agentSkill.bodyMd, state: agentSkill.state })
    .from(agentSkill)
    .where(
      and(
        eq(agentSkill.projectId, projectId),
        inArray(agentSkill.state, ["pending_review", "active"])
      )
    );
  const oldSigs = new Set<string>();
  for (const s of skillRows) {
    const sig = extractSkillSignature(s.bodyMd);
    if (sig) oldSigs.add(sig);
  }

  const onlyOld: string[] = [];
  const onlyNew: string[] = [];
  let both = 0;
  for (const s of oldSigs) {
    if (newSigs.has(s)) both += 1;
    else onlyOld.push(s);
  }
  for (const s of newSigs) {
    if (!oldSigs.has(s)) onlyNew.push(s);
  }

  return {
    onlyOldSignatures: onlyOld.slice(0, DETAIL_CAP),
    onlyNewSignatures: onlyNew.slice(0, DETAIL_CAP),
    bothCount: both,
  };
}

async function reflectiveStats(projectId: string, now: Date): Promise<ReconcileReflectiveStats> {
  const store = getExperienceStore();
  const rows = await store.query({
    kind: "reflective",
    scope: "project",
    scopeId: projectId,
    archivalMode: "exclude_archived",
    limit: 5_000,
  });
  const bySubKind: Record<string, number> = {};
  let recent = 0;
  const cutoff = now.getTime() - 7 * 86_400_000;
  for (const r of rows) {
    bySubKind[r.subKind || "_unknown"] = (bySubKind[r.subKind || "_unknown"] ?? 0) + 1;
    if (new Date(r.validFrom).getTime() >= cutoff) recent += 1;
  }
  return { total: rows.length, bySubKind, recent7d: recent };
}

// ───────────────────────── 工具函数 ─────────────────────────

const SIGNATURE_PATTERN = /<!--\s*signature:\s*([^\s>]+)\s*-->/i;

export function extractSkillSignature(bodyMd: string | null | undefined): string | null {
  if (!bodyMd) return null;
  const m = SIGNATURE_PATTERN.exec(bodyMd);
  return m?.[1] ?? null;
}

function parseContent(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return null;
}

function renderSummary(input: {
  projectId: string;
  wfCount: number;
  semantic: ReconcileSemanticDiff;
  procedural: ReconcileProceduralDiff;
  reflective: ReconcileReflectiveStats;
  recommendation: ReconcileReport["recommendation"];
}): string {
  const lines = [
    `# Memory V2 双写对账 — project=${input.projectId}`,
    "",
    `window: 7d  /  completed workflows: ${input.wfCount}`,
    "",
    "## D1 semantic vs midterm",
    `  both=${input.semantic.bothCount}  onlyOld=${input.semantic.onlyOldWorkflowIds.length}  onlyNew=${input.semantic.onlyNewWorkflowIds.length}`,
  ];
  if (input.semantic.onlyOldWorkflowIds.length > 0) {
    lines.push(`  onlyOld 样本: ${input.semantic.onlyOldWorkflowIds.slice(0, 5).join(", ")}`);
  }
  if (input.semantic.onlyNewWorkflowIds.length > 0) {
    lines.push(`  onlyNew 样本: ${input.semantic.onlyNewWorkflowIds.slice(0, 5).join(", ")}`);
  }
  lines.push("");
  lines.push("## D2 procedural vs agent_skill");
  lines.push(
    `  both=${input.procedural.bothCount}  onlyOld=${input.procedural.onlyOldSignatures.length}  onlyNew=${input.procedural.onlyNewSignatures.length}`
  );
  if (input.procedural.onlyOldSignatures.length > 0) {
    lines.push(`  onlyOld 样本: ${input.procedural.onlyOldSignatures.slice(0, 5).join(", ")}`);
  }
  if (input.procedural.onlyNewSignatures.length > 0) {
    lines.push(`  onlyNew 样本: ${input.procedural.onlyNewSignatures.slice(0, 5).join(", ")}`);
  }
  lines.push("");
  lines.push("## D3 reflective (新增价值)");
  lines.push(`  total=${input.reflective.total}  recent7d=${input.reflective.recent7d}`);
  const subParts = Object.entries(input.reflective.bySubKind)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  if (subParts) lines.push(`  bySubKind: ${subParts}`);
  lines.push("");
  lines.push("## 结论");
  lines.push(
    input.recommendation === "ok_to_sunset"
      ? "  ✓ ok_to_sunset — diff=0，可下线旧路径（consolidateFromWorkflow + syncMemoryForWorkflow）"
      : "  ⚠ needs_attention — 仍有 drift，请按上面 onlyOld/onlyNew 样本人审"
  );
  return lines.join("\n");
}

// 暴露给 store 默认走 SQLite 时使用（类型友好）
export type _Experience = Experience;
// 静默引用 `desc` / `sql` 避免 TS unused（未来扩展用得到）
void desc;
void sql;
