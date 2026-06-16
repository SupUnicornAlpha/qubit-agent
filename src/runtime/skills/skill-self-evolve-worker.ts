/**
 * 进程内 Skill 自进化 worker（P1 2026-06）。
 *
 * 背景：SkillPromoter / SkillEvolverWatcher / SkillBaselineObserver 都是 per-project 的
 * `runOnce({projectId})`，本身没有内部循环——此前完全靠外部 cron 调度，生产几乎从不跑，
 * 于是 P0 接通的 Extractor 产出的 procedural 候选**没有 worker 去晋升成 skill**。
 *
 * 本 worker 仿 experienceMaintenanceWorker：定时枚举 active 项目，按错峰节奏跑三个 worker：
 *   - SkillPromoter   每 tick（30min）：procedural workflow_play → 评分 → pending_review skill
 *   - SkillEvolverWatcher 每 2 tick（60min）：处理 skill_revision_request（LLM，较贵）
 *   - SkillBaselineObserver 每 12 tick（6h）：召回观察达标的进化 skill → 自动 approve 翻 active
 *
 * 全程受 SELF_EVOLVE_ENABLED 总闸约束（关 → 整个 tick 跳过）；任一 project/worker 失败仅 warn。
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { project } from "../../db/sqlite/schema";
import { selfEvolveDisabledReason } from "../config/self-evolve-config";
import { SkillBaselineObserver } from "../skill-baseline-observer/observer";
import { SkillEvolverWatcher } from "../skill-evolver-watcher/watcher";
import { SkillPromoter } from "../skill-promoter/skill-promoter";

const TICK_MS = 30 * 60 * 1000; // 30min：Promoter 节奏
const STARTUP_DELAY_MS = 90 * 1000; // 启动后 90s 再首跑，避开启动峰值
const EVOLVER_EVERY_N_TICKS = 2; // 60min
const OBSERVER_EVERY_N_TICKS = 12; // 6h

export class SkillSelfEvolveWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private tickCount = 0;
  private running = false;
  private readonly promoter = new SkillPromoter();
  private readonly evolver = new SkillEvolverWatcher();
  private readonly observer = new SkillBaselineObserver();

  async tick(): Promise<void> {
    if (this.running) return; // 防重入：上一 tick 还没跑完就跳过
    const disabled = selfEvolveDisabledReason();
    if (disabled) return; // honor 全局总闸
    this.running = true;
    this.tickCount += 1;
    const runEvolver = this.tickCount % EVOLVER_EVERY_N_TICKS === 0;
    const runObserver = this.tickCount % OBSERVER_EVERY_N_TICKS === 0;
    try {
      const db = await getDb();
      const projects = await db
        .select({ id: project.id })
        .from(project)
        .where(and(eq(project.status, "active")));

      for (const p of projects) {
        try {
          await this.promoter.runOnce({
            projectId: p.id,
            mode: "live",
            triggeredBy: "skill_self_evolve_worker",
          });
        } catch (err) {
          console.warn(`[skill-self-evolve] promoter failed project=${p.id}: ${errToStr(err)}`);
        }
        if (runEvolver) {
          try {
            await this.evolver.runOnce({ projectId: p.id });
          } catch (err) {
            console.warn(`[skill-self-evolve] evolver failed project=${p.id}: ${errToStr(err)}`);
          }
        }
        if (runObserver) {
          try {
            await this.observer.runOnce({ projectId: p.id });
          } catch (err) {
            console.warn(`[skill-self-evolve] observer failed project=${p.id}: ${errToStr(err)}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[skill-self-evolve] tick failed: ${errToStr(err)}`);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick();
      this.timer = setInterval(() => {
        void this.tick();
      }, TICK_MS);
    }, STARTUP_DELAY_MS);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function errToStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const skillSelfEvolveWorker = new SkillSelfEvolveWorker();
