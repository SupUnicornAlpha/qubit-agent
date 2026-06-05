/**
 * SkillService — M11 Agent 自进化核心
 *
 * 职责：
 *   1. 让 Agent 把"完成 5+ 工具调用的复杂任务/稳定流程"沉淀为 skill（参考 Hermes Agent 设计）
 *   2. 区分外部市场安装（source=open_skill_market）与 Agent 自建（source=agent_created）
 *   3. 版本谱系（parent_skill_id）供 Curator 合并 / Evolution 演化追溯
 *   4. 简单关键词检索 + 软排序（pinned > active.recent > last_used 频次）
 *
 * 设计原则：
 *   - 禁止物理删除：archive 才是终态；`agent_skill.state=archived` 即可恢复
 *   - 仅 source=agent_created 走"自动归档"路径；用户/市场 skill 永不自动归档
 *   - 与 longterm_memory(playbook) 共存：memory 存"事实/约束"，skill 存"可复用流程"
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, agentSkillRun, skillMarketInstall } from "../../db/sqlite/schema";
import type {
  AgentSkill,
  AgentSkillOutcome,
  AgentSkillSource,
  AgentSkillState,
} from "../../types/entities";

const MAX_SKILL_BODY_BYTES = 16 * 1024; // 16KB 上限，对齐 Hermes Phase 1 推荐 default
const MAX_SKILL_DESCRIPTION_LEN = 500; // 用于 LLM 检索的描述，对齐 Hermes tool description budget
const DEFAULT_SEARCH_TOPK = 5;

export interface CreateSkillInput {
  projectId: string;
  definitionId?: string | null;
  name: string;
  description: string;
  bodyMd: string;
  category?: string;
  source?: AgentSkillSource;
  externalInstallId?: string | null;
  parentSkillId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string;
  version?: string;
  state?: AgentSkillState;
  pinned?: boolean;
}

export interface PatchSkillInput {
  skillId: string;
  description?: string;
  bodyMd?: string;
  category?: string;
  pinned?: boolean;
  state?: AgentSkillState;
  metadata?: Record<string, unknown>;
  bumpVersion?: boolean;
}

export interface RecordSkillUsageInput {
  /** UUID 或 name 都接受；非 UUID 时必须配 projectId 才能 fallback 到 findByName */
  skillId: string;
  /** 当 skillId 不是 UUID 时用于 fallback 查 name */
  projectId?: string;
  workflowRunId?: string | null;
  agentInstanceId?: string | null;
  definitionId?: string | null;
  outcome?: AgentSkillOutcome;
  score?: number;
  notes?: string;
}

export interface SkillSearchInput {
  projectId: string;
  query?: string;
  /** 优先返回属于本 definition 的；nil 则不过滤 */
  definitionId?: string | null;
  topK?: number;
  includeArchived?: boolean;
}

function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_\-:.]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function bumpSemver(version: string): string {
  // 仅做"vN"或"vN.M"递增；不强求 semver
  const m = version.match(/^v?(\d+)(?:\.(\d+))?$/);
  if (!m) return `${version}.1`;
  const major = Number(m[1] ?? "1");
  const minor = m[2] != null ? Number(m[2]) + 1 : 1;
  return `v${major}.${minor}`;
}

function enforceLimits(input: { description: string; bodyMd: string }): void {
  if (Buffer.byteLength(input.bodyMd, "utf-8") > MAX_SKILL_BODY_BYTES) {
    throw new Error(
      `skill body exceeds ${MAX_SKILL_BODY_BYTES} bytes; please trim or split into sub-skills`
    );
  }
  if (input.description.length > MAX_SKILL_DESCRIPTION_LEN) {
    throw new Error(
      `skill description exceeds ${MAX_SKILL_DESCRIPTION_LEN} chars; keep it concise`
    );
  }
}

export class SkillService {
  async create(input: CreateSkillInput): Promise<AgentSkill> {
    const name = normalizeName(input.name);
    if (!name) throw new Error("skill.create: name is required");
    if (!input.bodyMd?.trim()) throw new Error("skill.create: bodyMd is required");
    enforceLimits({ description: input.description ?? "", bodyMd: input.bodyMd });

    const db = await getDb();
    const existing = await db
      .select()
      .from(agentSkill)
      .where(and(eq(agentSkill.projectId, input.projectId), eq(agentSkill.name, name)))
      .limit(1);
    if (existing[0]) {
      throw new Error(
        `skill "${name}" already exists in this project (id=${existing[0].id}); use skill.patch to update`
      );
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await db.insert(agentSkill).values({
      id,
      projectId: input.projectId,
      definitionId: input.definitionId ?? null,
      name,
      description: (input.description ?? "").trim(),
      bodyMd: input.bodyMd,
      category: input.category?.trim() || "general",
      version: input.version ?? "v1",
      parentSkillId: input.parentSkillId ?? null,
      source: input.source ?? "agent_created",
      externalInstallId: input.externalInstallId ?? null,
      state: input.state ?? "active",
      pinned: Boolean(input.pinned),
      useCount: 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
      metadataJson: input.metadata ?? {},
      createdBy: input.createdBy ?? "agent",
      createdAt: now,
      updatedAt: now,
    });
    return (await this.findById(id))!;
  }

  async findById(skillId: string): Promise<AgentSkill | null> {
    const db = await getDb();
    const rows = await db.select().from(agentSkill).where(eq(agentSkill.id, skillId)).limit(1);
    return (rows[0] as AgentSkill | undefined) ?? null;
  }

  async findByName(projectId: string, name: string): Promise<AgentSkill | null> {
    const db = await getDb();
    const normalized = normalizeName(name);
    if (!normalized) return null;
    const rows = await db
      .select()
      .from(agentSkill)
      .where(and(eq(agentSkill.projectId, projectId), eq(agentSkill.name, normalized)))
      .limit(1);
    return (rows[0] as AgentSkill | undefined) ?? null;
  }

  async patch(input: PatchSkillInput): Promise<AgentSkill> {
    const db = await getDb();
    const existing = await this.findById(input.skillId);
    if (!existing) throw new Error(`skill ${input.skillId} not found`);

    const nextDescription = input.description ?? existing.description;
    const nextBody = input.bodyMd ?? existing.bodyMd;
    enforceLimits({ description: nextDescription, bodyMd: nextBody });

    const now = new Date().toISOString();
    const nextVersion = input.bumpVersion ? bumpSemver(existing.version) : existing.version;
    const merged =
      input.metadata !== undefined
        ? { ...((existing.metadataJson as Record<string, unknown>) ?? {}), ...input.metadata }
        : (existing.metadataJson as Record<string, unknown>);

    await db
      .update(agentSkill)
      .set({
        description: nextDescription,
        bodyMd: nextBody,
        ...(input.category ? { category: input.category } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.state ? { state: input.state } : {}),
        ...(input.bumpVersion ? { version: nextVersion } : {}),
        metadataJson: merged,
        updatedAt: now,
      })
      .where(eq(agentSkill.id, input.skillId));
    return (await this.findById(input.skillId))!;
  }

  async archive(skillId: string, reason?: string): Promise<AgentSkill> {
    return this.patch({
      skillId,
      state: "archived",
      metadata: reason ? { archiveReason: reason, archivedAt: new Date().toISOString() } : {},
    });
  }

  async unarchive(skillId: string): Promise<AgentSkill> {
    return this.patch({ skillId, state: "active" });
  }

  /** 软排序检索：pinned > active.last_used desc > use_count > created_at */
  async search(input: SkillSearchInput): Promise<AgentSkill[]> {
    return (await this.searchWithMeta(input)).map((h) => h.skill);
  }

  /**
   * 监控 V2 P2：带评分 / 排名的检索结果，供 `skill_recall_log` 写入侧使用。
   *
   * 与 `search()` 共享同一套打分逻辑；纯函数 + 返回排名后的 `{ skill, score, rank }[]`。
   * 不破坏 `search()` 旧契约（其它 caller 不变）。
   */
  async searchWithMeta(
    input: SkillSearchInput
  ): Promise<Array<{ skill: AgentSkill; score: number; rank: number }>> {
    const db = await getDb();
    const topK = Math.min(Math.max(input.topK ?? DEFAULT_SEARCH_TOPK, 1), 20);
    const includeArchived = Boolean(input.includeArchived);

    const conditions = [eq(agentSkill.projectId, input.projectId)];
    if (!includeArchived) {
      conditions.push(ne(agentSkill.state, "archived"));
    }
    const all = (await db
      .select()
      .from(agentSkill)
      .where(and(...conditions))) as AgentSkill[];

    const query = (input.query ?? "").trim().toLowerCase();
    const scored = all.map((s) => {
      const ownsByDef = input.definitionId && s.definitionId === input.definitionId ? 1 : 0;
      const pinScore = s.pinned ? 8 : 0;
      const stateScore = s.state === "active" ? 2 : s.state === "pending_review" ? 1 : -1;
      const recencyScore = s.lastUsedAt
        ? Math.max(0, 5 - Math.floor((Date.now() - Date.parse(s.lastUsedAt)) / 86400_000 / 7))
        : 0;
      const useScore = Math.log1p(Math.max(0, s.useCount)) * 0.5;
      let queryScore = 0;
      if (query) {
        const haystack = `${s.name} ${s.description} ${s.category}`.toLowerCase();
        const tokens = query.split(/\s+/).filter((t) => t.length > 1);
        for (const t of tokens) {
          if (haystack.includes(t)) queryScore += 2;
        }
      }
      return {
        skill: s,
        score: pinScore + stateScore + recencyScore + useScore + queryScore + ownsByDef * 1.5,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((x, idx) => ({ skill: x.skill, score: x.score, rank: idx }));
  }

  /** 列出指定项目下的全部 skill；用于 Curator / UI */
  async list(projectId: string, opts?: { includeArchived?: boolean; state?: AgentSkillState }): Promise<AgentSkill[]> {
    const db = await getDb();
    const conds = [eq(agentSkill.projectId, projectId)];
    if (opts?.state) conds.push(eq(agentSkill.state, opts.state));
    else if (!opts?.includeArchived) conds.push(ne(agentSkill.state, "archived"));
    return (await db
      .select()
      .from(agentSkill)
      .where(and(...conds))
      .orderBy(desc(agentSkill.pinned), desc(agentSkill.lastUsedAt), asc(agentSkill.name))) as AgentSkill[];
  }

  /**
   * Agent 调用 skill 后写入用量；同步刷新 last_used_at / use_count / success_count / fail_count。
   *
   * 2026-06-05 监控复盘 #3 修复：
   *   - 旧实现 `findById(input.skillId)` 只支持 UUID，但 LLM 自然倾向传 skill name
   *     (`"quant-analyst"`, `"fsi/earnings-analysis"`) → 找不到 UUID → silent return
   *     → agent_skill_run **零写入**。最近 1d 36 次 skill.use_record 调用全部空转。
   *   - 现在：先 findById，找不到再 findByName(projectId, name) fallback；
   *     仍找不到时 throw error（带 hint），让 builtin tool 把"recorded:false"+候选
   *     skill 名单返回给 LLM，下一轮可以传正确的 id。
   *   - 找不到 skill 时**不再 silent return**，否则 tool response `recorded:true` 是骗
   *     LLM 的，掩盖 telemetry 缺失。
   */
  async recordUsage(input: RecordSkillUsageInput): Promise<void> {
    const db = await getDb();
    let skill = await this.findById(input.skillId);
    if (!skill && input.projectId) {
      skill = await this.findByName(input.projectId, input.skillId);
    }
    if (!skill) {
      throw new Error(
        `skill_not_found: "${input.skillId}" 不是 agent_skill 表里的 UUID 或 name`
      );
    }
    // 使用真实 skill.id 写入，而不是 LLM 传过来的字符串（可能是 name）。
    const skillRowId = skill.id;
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.insert(agentSkillRun).values({
      id,
      skillId: skillRowId,
      workflowRunId: input.workflowRunId ?? null,
      agentInstanceId: input.agentInstanceId ?? null,
      definitionId: input.definitionId ?? null,
      outcome: input.outcome ?? "unknown",
      score: input.score ?? null,
      notes: input.notes ?? "",
      startedAt: now,
      endedAt: now,
    });
    const setters: Record<string, unknown> = {
      useCount: sql`${agentSkill.useCount} + 1`,
      lastUsedAt: now,
      updatedAt: now,
    };
    if (input.outcome === "success") setters["successCount"] = sql`${agentSkill.successCount} + 1`;
    if (input.outcome === "fail") setters["failCount"] = sql`${agentSkill.failCount} + 1`;
    // active → 复活：被 Curator 标 stale 的 skill 再次被用 → 重新激活
    if (skill.state === "stale") setters["state"] = "active";
    await db.update(agentSkill).set(setters).where(eq(agentSkill.id, skillRowId));

    /**
     * 监控 V2 P2：把 (workflowRunId, skillId) 对应的最近一条 skill_recall_log
     * 翻 executed=true。lazy import 避免 skill-service 强依赖 monitor 子树（互测 / 单测时可独立 mock）。
     * 失败仅 warn 不抛。
     */
    if (input.workflowRunId) {
      try {
        const recallLogger = await import("../monitor/skill-recall-logger");
        await recallLogger.markSkillRecallExecuted({
          workflowRunId: input.workflowRunId,
          skillId: skillRowId,
        });
      } catch (e) {
        console.warn(
          `[skillService.recordUsage] markSkillRecallExecuted failed: ${(e as Error).message}`
        );
      }
    }
  }

  /**
   * 把外部市场（skill_market_install）安装记录镜像到 agent_skill，
   * 让"无论来源是 agent / 用户 / 市场"的 skill 走同一个检索器。
   */
  async mirrorFromMarketInstall(installId: string, opts?: { bodyMd?: string }): Promise<AgentSkill | null> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(skillMarketInstall)
      .where(eq(skillMarketInstall.id, installId))
      .limit(1);
    const inst = rows[0];
    if (!inst) return null;
    if (inst.installStatus !== "installed") return null;

    const name = normalizeName(inst.skillName || inst.externalSkillId);
    const existing = await this.findByName(inst.projectId, name);
    if (existing) {
      // Already mirrored — keep idempotent
      return existing;
    }
    return this.create({
      projectId: inst.projectId,
      name,
      description: (inst.description ?? "").slice(0, MAX_SKILL_DESCRIPTION_LEN),
      bodyMd: opts?.bodyMd ?? `# ${inst.skillName}\n\n_来源：${inst.registry} (${inst.externalSkillId})_`,
      category: "imported",
      source: "open_skill_market",
      externalInstallId: inst.id,
      metadata: { meta: inst.metaJson },
      createdBy: inst.installedBy || "user",
    });
  }
}

export const skillService = new SkillService();

export function renderSkillsBlockForPrompt(skills: AgentSkill[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = ["## 相关 Skill（按相关性 + 命中率排序，已自动召回）"];
  lines.push(
    "> 若你正要做的工作与下面 skill 描述匹配，**优先按 skill 步骤复用**；完成后调 `skill.use_record` 写入使用结果。"
  );
  lines.push("");
  for (const s of skills) {
    const stats = `usage=${s.useCount} success=${s.successCount} fail=${s.failCount}`;
    lines.push(`### \`${s.name}\` · v${s.version.replace(/^v/, "")} · ${s.state} · ${stats}`);
    lines.push(`> ${s.description || "(no description)"}`);
    lines.push("");
    // body 截断到 1.2KB 防 prompt 爆炸
    const body = s.bodyMd.length > 1200 ? s.bodyMd.slice(0, 1200) + "\n…(截断，调 skill.view 看全文)" : s.bodyMd;
    lines.push(body.trim());
    lines.push("");
  }
  return lines.join("\n");
}
