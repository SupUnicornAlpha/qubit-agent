import type { AgentSkillOutcome } from "../../types/entities";
import { shouldSuppressExecutionSkill } from "../conversation/goal-scope";
import { searchFilesystemSkills } from "../skills/filesystem-skill-store";
import { skillService } from "../skills/skill-service";
import type { BuiltinToolHandler } from "./types";

/** Reusable-skill lifecycle handlers. */
export const SKILL_HANDLERS: Record<string, BuiltinToolHandler> = {
  // ─── M11: Agent 自进化 skill 工具集 ────────────────────────────────────────
  // 设计原则（参考 Hermes Agent）：
  //   - skill.create 在完成复杂任务后调，保存可复用流程
  //   - skill.patch 在使用中发现 skill 过时/不准时立即修正
  //   - skill.view / skill.list 提供给 reason 节点检索之外的手动查阅
  //   - skill.archive 软删（state=archived），可恢复
  //   - skill.use_record 在 act 节点完成后调，写入使用结果驱动 Curator 评分
  "skill.create": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    if (!projectId) throw new Error("skill.create: projectId is required");
    const name = String(params.name ?? "").trim();
    const description = String(params.description ?? "").trim();
    const bodyMd = String(params.bodyMd ?? params.body ?? params.content ?? "").trim();
    if (!name) throw new Error("skill.create: name is required");
    if (!description) throw new Error("skill.create: description is required (used for retrieval)");
    if (!bodyMd) throw new Error("skill.create: bodyMd is required (the skill content)");
    const created = await skillService.create({
      projectId,
      definitionId: ctx.definition.id,
      name,
      description,
      bodyMd,
      ...(typeof params.category === "string" ? { category: params.category } : {}),
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata as Record<string, unknown> }
        : {}),
      source: "agent_created",
      createdBy: `agent:${ctx.definition.role}`,
    });
    return {
      skillId: created.id,
      name: created.name,
      version: created.version,
      message: `skill "${created.name}" created. Next time the agent perceives a matching goal it'll be auto-injected.`,
    };
  },

  "skill.view": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    const idOrName = String(params.skillId ?? params.id ?? params.name ?? "").trim();
    if (!idOrName) throw new Error("skill.view: skillId or name is required");
    const skill =
      (await skillService.findById(idOrName)) ??
      (await skillService.findByName(projectId, idOrName));
    if (!skill) return { error: `skill not found: ${idOrName}` };
    return skill;
  },

  "skill.list": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    if (!projectId) throw new Error("skill.list: projectId is required");
    const opts: {
      includeArchived?: boolean;
      state?: "active" | "stale" | "archived" | "pending_review";
    } = {};
    if (typeof params.includeArchived === "boolean") opts.includeArchived = params.includeArchived;
    if (typeof params.state === "string") {
      const s = params.state as "active" | "stale" | "archived" | "pending_review";
      if (["active", "stale", "archived", "pending_review"].includes(s)) opts.state = s;
    }
    const rows = await skillService.list(projectId, opts);
    return { count: rows.length, skills: rows };
  },

  "skill.search": async (ctx, params) => {
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "");
    const query = typeof params.query === "string" ? params.query : "";
    const topK = Number(params.topK ?? 5);
    // Global files are the normal Skill source. DB Skills remain a project-local
    // compatibility path for already-created/evolved records, not a prerequisite.
    const [filesystemHits, databaseHits] = await Promise.all([
      searchFilesystemSkills({
        query,
        topK,
        declaredSkillRefs: ctx.definition.skills,
      }),
      projectId
        ? skillService.searchWithMeta({ projectId, query, definitionId: ctx.definition.id, topK })
        : Promise.resolve([]),
    ]);
    const seenNames = new Set(filesystemHits.map((hit) => hit.skill.name.trim().toLowerCase()));
    const databaseOnly = databaseHits.filter(
      (hit) => !seenNames.has(hit.skill.name.trim().toLowerCase())
    );
    const hits = [
      ...filesystemHits.map((hit) => ({
        id: hit.skill.id,
        name: hit.skill.name,
        description: hit.skill.description,
        bodyMd: hit.skill.bodyMd,
        category: hit.skill.category,
        version: hit.skill.version,
        score: hit.score,
        source: hit.skill.source,
        sourcePath: hit.skill.sourcePath,
      })),
      ...databaseOnly.map((hit) => ({
        id: hit.skill.id,
        name: hit.skill.name,
        description: hit.skill.description,
        bodyMd: hit.skill.bodyMd,
        category: hit.skill.category,
        version: hit.skill.version,
        score: hit.score,
        source: "database" as const,
      })),
    ]
      .filter((hit) => !shouldSuppressExecutionSkill(hit.name, query))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, Math.max(1, Math.min(topK || 5, 20)))
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
    if (ctx.workflowId && ctx.workflowId !== "prime-bridge" && databaseOnly.length > 0) {
      const recallLogger = await import("../monitor/skill-recall-logger");
      await recallLogger.recordSkillRecall({
        workflowRunId: ctx.workflowId,
        definitionId: ctx.definition.id,
        hits: databaseOnly.map((hit) => ({
          skillId: hit.skill.id,
          rank: hit.rank,
          score: hit.score,
        })),
      });
    }

    // Rust Core auto-recall injects the returned Skill bodies into the prompt.
    // Record that concrete use here so S-1 and topology no longer report zero.
    const recordUsage = params.recordUsage === true || params.record_usage === true;
    if (recordUsage) {
      const workflowId = ctx.workflowId;
      const benchmarkWorkflow =
        Boolean(workflowId && workflowId !== "prime-bridge") &&
        (await import("../benchmark/benchmark-namespace")
          .then(({ isBenchmarkWorkflow }) => (workflowId ? isBenchmarkWorkflow(workflowId) : false))
          .catch(() => false));
      await Promise.all(
        databaseOnly.map((hit) =>
          skillService.recordUsage({
            skillId: hit.skill.id,
            projectId,
            workflowRunId: ctx.workflowId,
            ...(ctx.agentInstanceId ? { agentInstanceId: ctx.agentInstanceId } : {}),
            definitionId: ctx.definition.id,
            outcome: "success",
            score: 1,
            notes: `${benchmarkWorkflow ? "benchmark" : "rust_core"}:${String(params.usageMode ?? "context_injection")}`,
            updateLifetimeCounters: !benchmarkWorkflow,
          })
        )
      );
    }
    return {
      query,
      count: hits.length,
      recordUsage,
      sources: { filesystem: filesystemHits.length, database: databaseOnly.length },
      skills: hits,
    };
  },

  "skill.patch": async (_ctx, params) => {
    const skillId = String(params.skillId ?? params.id ?? "").trim();
    if (!skillId) throw new Error("skill.patch: skillId is required");
    const patchInput: Parameters<typeof skillService.patch>[0] = {
      skillId,
    };
    if (typeof params.description === "string") patchInput.description = params.description;
    if (typeof params.bodyMd === "string") patchInput.bodyMd = params.bodyMd;
    if (typeof params.body === "string") patchInput.bodyMd = params.body;
    if (typeof params.content === "string") patchInput.bodyMd = params.content;
    if (typeof params.category === "string") patchInput.category = params.category;
    if (typeof params.pinned === "boolean") patchInput.pinned = params.pinned;
    if (typeof params.state === "string") {
      const s = params.state as "active" | "stale" | "archived" | "pending_review";
      if (["active", "stale", "archived", "pending_review"].includes(s)) patchInput.state = s;
    }
    if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) {
      patchInput.metadata = params.metadata as Record<string, unknown>;
    }
    if (typeof params.bumpVersion === "boolean") patchInput.bumpVersion = params.bumpVersion;
    else patchInput.bumpVersion = true;
    const updated = await skillService.patch(patchInput);
    return {
      skillId: updated.id,
      name: updated.name,
      version: updated.version,
      state: updated.state,
      message: "skill patched",
    };
  },

  "skill.archive": async (_ctx, params) => {
    const skillId = String(params.skillId ?? params.id ?? "").trim();
    if (!skillId) throw new Error("skill.archive: skillId is required");
    const reason = typeof params.reason === "string" ? params.reason : undefined;
    const archived = await skillService.archive(skillId, reason);
    return {
      skillId: archived.id,
      state: archived.state,
      message: "skill archived (recoverable via skill.patch state=active)",
    };
  },

  "skill.use_record": async (ctx, params) => {
    /**
     * 2026-06-05 监控复盘 #3 修复：
     *   旧实现：硬把 LLM 传的 skillId 透传给 skillService.recordUsage（只查 UUID），
     *   找不到 silent return，response 假报 `recorded:true` → 最近 1d 36 次调用 0 条
     *   agent_skill_run 落表。
     *
     *   新实现：
     *   1) 透传 projectId 让 service 能走 findByName fallback；
     *   2) 真没找到时（service throw）catch 住，return `{recorded:false, hint, candidates}`
     *      给 LLM —— 下一轮可以用正确的 skillId 重试，而不是被骗以为成功了。
     */
    const skillId = String(params.skillId ?? params.id ?? params.name ?? "").trim();
    if (!skillId) throw new Error("skill.use_record: skillId is required");
    const outcomeRaw = String(params.outcome ?? "unknown") as AgentSkillOutcome;
    const outcome: AgentSkillOutcome = ["success", "fail", "partial", "unknown"].includes(
      outcomeRaw
    )
      ? outcomeRaw
      : "unknown";
    try {
      await skillService.recordUsage({
        skillId,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        workflowRunId: ctx.workflowId,
        agentInstanceId: ctx.agentInstanceId,
        definitionId: ctx.definition.id,
        outcome,
        score: typeof params.score === "number" ? params.score : 0,
        notes: typeof params.notes === "string" ? params.notes : "",
      });
      return { skillId, outcome, recorded: true };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.startsWith("skill_not_found:")) {
        const candidates = ctx.projectId
          ? await skillService.list(ctx.projectId, { includeArchived: false })
          : [];
        return {
          recorded: false,
          error: msg,
          hint:
            "传入的 skillId 既不是 UUID 也不是本 project 下任何 active skill 的 name；" +
            "用下面 candidates 里的 id 或 name 重试，或先调 skill.create 注册一个新的。",
          candidates: candidates.slice(0, 20).map((s) => ({ id: s.id, name: s.name })),
        };
      }
      throw err;
    }
  },

  "skill.import_market": async (_ctx, params) => {
    const installId = String(params.installId ?? params.skillInstallId ?? "").trim();
    if (!installId) throw new Error("skill.import_market: installId is required");
    const bodyMd = typeof params.bodyMd === "string" ? params.bodyMd : undefined;
    const mirrored = await skillService.mirrorFromMarketInstall(
      installId,
      bodyMd ? { bodyMd } : undefined
    );
    if (!mirrored) return { ok: false, error: "install not found or not installed" };
    return { ok: true, skillId: mirrored.id, name: mirrored.name };
  },
};
