/**
 * Self-Evolving Agent P6 — SkillEvolverWatcher worker。
 *
 * 职责：周期扫 `experience(reflective, subKind='skill_revision_request')` 队列，
 *      把"未处理"的请求 dispatch 到 SkillEvolver.evolve，回写 evolutionRunId 标记完成。
 *
 * 触发：cron 每 60 min（默认）—— LLM 推理较贵，频率比 SkillPromoter 低。
 *
 * 设计原则：
 *   - 已处理（metadataJson.processedAt 有值）的请求直接跳过，重跑安全；
 *   - base skill 找不到 / archived 时不调 evolve，回写 status=skipped_*；
 *   - evolve 失败时写 errorMessage，下次跑批 *不* 自动重试（要重试只能再发 reflective 请求）；
 *   - 每条请求独立 try/catch，单条失败不影响其它；
 *   - emit `maintenance_run/skill_evolver` event 给 metrics。
 *
 * 不在 worker 内做：
 *   - 决定哪条 reflective 触发 evolve（contract 由 caller / Reflector 自己决定写入）；
 *   - approve/reject evolved skill（仍走 P5 promoter-review）。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill as agentSkillTable } from "../../db/sqlite/schema";
import type { ExperienceBus } from "../experience/experience-bus";
import { getExperienceBus } from "../experience/experience-bus";
import type { ExperienceStore } from "../experience/experience-store";
import { getExperienceStore } from "../experience/experience-store";
import { SkillEvolver } from "../skills/skill-evolve";
import { SKILL_REVISION_SUBKIND } from "./request-skill-revision";
import type {
  SkillRevisionRequestMeta,
  WatcherProcessResult,
  WatcherTickSummary,
} from "./types";

const DEFAULT_LIMIT = 50;

export interface SkillEvolverWatcherOptions {
  projectId: string;
  /** 单次 tick 最多处理多少条请求；默认 50（更高的 LLM cost ceiling 由调度方控） */
  maxBatch?: number;
  /** 是否 emit metrics（test 可关） */
  emitMetrics?: boolean;
}

export interface SkillEvolverWatcherDeps {
  store?: ExperienceStore;
  bus?: ExperienceBus;
  evolver?: SkillEvolver;
}

export class SkillEvolverWatcher {
  private readonly store: ExperienceStore;
  private readonly bus: ExperienceBus;
  private readonly evolver: SkillEvolver;

  constructor(deps: SkillEvolverWatcherDeps = {}) {
    this.store = deps.store ?? getExperienceStore();
    this.bus = deps.bus ?? getExperienceBus();
    this.evolver = deps.evolver ?? new SkillEvolver();
  }

  async runOnce(opts: SkillEvolverWatcherOptions): Promise<WatcherTickSummary> {
    if (!opts.projectId) throw new Error("SkillEvolverWatcher.runOnce: projectId required");
    const startedAt = Date.now();
    const maxBatch = opts.maxBatch ?? DEFAULT_LIMIT;

    const requests = await this.store.query({
      kind: "reflective",
      subKind: SKILL_REVISION_SUBKIND,
      scope: "project",
      scopeId: opts.projectId,
      archivalMode: "all",
      orderBy: "created_desc",
      limit: maxBatch,
    });

    const summary: WatcherTickSummary = {
      scanned: 0,
      processed: 0,
      skippedBaseMissing: 0,
      skippedBaseArchived: 0,
      failed: 0,
      elapsedMs: 0,
      results: [],
    };

    const db = await getDb();
    for (const req of requests) {
      summary.scanned += 1;
      const meta = (req.metadataJson ?? {}) as unknown as SkillRevisionRequestMeta;
      // 已处理 → 跳
      if (meta.processedAt) continue;
      if (!meta.baseSkillId) {
        // 字段不全 — 标记为 skipped_base_missing 让前端能看到这个 bad request
        await this.markProcessed(req.id, meta, {
          processedAt: new Date().toISOString(),
          evolveStatus: "skipped_base_missing",
          evolveError: "metadataJson.baseSkillId missing",
        });
        summary.skippedBaseMissing += 1;
        summary.results.push({
          experienceId: req.id,
          baseSkillId: "",
          status: "skipped_base_missing",
          errorMessage: "metadataJson.baseSkillId missing",
        });
        continue;
      }

      // 检查 base skill 是否存在 + state 是否可演化
      const baseRows = await db
        .select({ id: agentSkillTable.id, state: agentSkillTable.state })
        .from(agentSkillTable)
        .where(and(eq(agentSkillTable.id, meta.baseSkillId), eq(agentSkillTable.projectId, opts.projectId)))
        .limit(1);
      const baseRow = baseRows[0];
      if (!baseRow) {
        await this.markProcessed(req.id, meta, {
          processedAt: new Date().toISOString(),
          evolveStatus: "skipped_base_missing",
          evolveError: `agent_skill ${meta.baseSkillId} not found in project ${opts.projectId}`,
        });
        summary.skippedBaseMissing += 1;
        summary.results.push({
          experienceId: req.id,
          baseSkillId: meta.baseSkillId,
          status: "skipped_base_missing",
        });
        continue;
      }
      if (baseRow.state === "archived") {
        await this.markProcessed(req.id, meta, {
          processedAt: new Date().toISOString(),
          evolveStatus: "skipped_base_archived",
        });
        summary.skippedBaseArchived += 1;
        summary.results.push({
          experienceId: req.id,
          baseSkillId: meta.baseSkillId,
          status: "skipped_base_archived",
        });
        continue;
      }

      // 真的 evolve
      try {
        const evolveOpts: Parameters<SkillEvolver["evolve"]>[0] = {
          projectId: opts.projectId,
          baseSkillId: meta.baseSkillId,
          triggeredBy: `watcher:${meta.requestedBy ?? "unknown"}`,
          // 离线 fallback 开（防止单机 dev 无 LLM 时 worker 全报错）
          allowOfflineMutation: true,
        };
        if (meta.iterations) evolveOpts.iterations = meta.iterations;
        if (meta.candidatesPerIteration)
          evolveOpts.candidatesPerIteration = meta.candidatesPerIteration;
        const result = await this.evolver.evolve(evolveOpts);
        await this.markProcessed(req.id, meta, {
          processedAt: new Date().toISOString(),
          evolutionRunId: result.evolutionRunId,
          evolveStatus: result.status === "completed" ? "completed" : "failed",
          ...(result.errorMessage ? { evolveError: result.errorMessage } : {}),
        });
        if (result.status === "completed") {
          summary.processed += 1;
        } else {
          summary.failed += 1;
        }
        summary.results.push({
          experienceId: req.id,
          baseSkillId: meta.baseSkillId,
          status: result.status === "completed" ? "completed" : "failed",
          evolutionRunId: result.evolutionRunId,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.markProcessed(req.id, meta, {
          processedAt: new Date().toISOString(),
          evolveStatus: "failed",
          evolveError: msg,
        });
        summary.failed += 1;
        summary.results.push({
          experienceId: req.id,
          baseSkillId: meta.baseSkillId,
          status: "failed",
          errorMessage: msg,
        });
      }
    }

    summary.elapsedMs = Date.now() - startedAt;

    if (opts.emitMetrics !== false) {
      try {
        this.bus.emit({
          type: "maintenance_run",
          kind: "skill_evolver",
          actor: "skill_evolver_watcher",
          summary: {
            scanned: summary.scanned,
            processed: summary.processed,
            skippedBaseMissing: summary.skippedBaseMissing,
            skippedBaseArchived: summary.skippedBaseArchived,
            failed: summary.failed,
            elapsedMs: summary.elapsedMs,
          },
        });
      } catch {
        /* metrics 失败不影响主流程 */
      }
    }

    return summary;
  }

  private async markProcessed(
    experienceId: string,
    prevMeta: SkillRevisionRequestMeta,
    patch: Partial<SkillRevisionRequestMeta>
  ): Promise<void> {
    const merged: SkillRevisionRequestMeta = { ...prevMeta, ...patch };
    await this.store.update(experienceId, {
      metadataJson: merged as unknown as Record<string, unknown>,
    });
  }
}
