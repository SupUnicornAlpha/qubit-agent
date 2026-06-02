/**
 * Janitor Pipe — Memory V2 P1（详见 docs/MEMORY_V2_DESIGN.md §6.6）。
 *
 * 唯一职责：nightly 调用，把所有 experience 的 qualityScore 重算一遍，
 * 并对持续低分项设置 decay_at → 7 天后归档（valid_to）。
 *
 * 设计原则：
 *   - **纯计算 + 串行 update**：不调 LLM；公式见 `computeQualityScore`
 *   - **可注入 time / cap**：单测控制 now 与每批处理上限
 *   - **不感知 Bus**：本 pipe 主要由 cron 调用，不订阅事件；跑完 emit maintenance_run
 *     给 observability 监控（caller 可选）
 *   - **pinned 永不衰减**：pinned=true 跳过 decay 逻辑
 *
 * qualityScore 公式（P1 起跑，可在 metadataJson.qualityWeights 单经验调权）：
 *
 *   base       = successCount / max(useCount, 5)                         # 0..1
 *   recency    = exp(-(daysSinceValidFrom) / 30)                         # 半衰期 30d
 *   hitlBoost  = +0.15 若有 hitl_feedback approve 在最近 7d（占位，P2 落） # 0..0.15
 *   conflict   = -0.10 * count(conflicts_with)                           # 简化
 *   quality = clamp(base * 0.5 + recency * 0.3 + 0.2 + hitlBoost + conflict, 0, 1)
 *
 * 衰减判定：
 *   - pinned=true 跳过
 *   - 连续 14 天 quality < 0.2（用 op_log 推断"无召回"）→ 设 decay_at = now + 7d
 *   - 已设 decay_at 且 now > decay_at + 7d 且无新 op_log 在 decay_at 之后 → 软归档（valid_to = now）
 */

import type { Experience } from "../../../types/entities";
import type { ExperienceBus } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";

export interface JanitorOptions {
  store: ExperienceStore;
  bus?: ExperienceBus; // 可选；跑完发 maintenance_run
  now?: () => Date;
  /** 单批扫描上限，防止一晚把 DB 卡住 */
  maxBatch?: number;
  /** 自定义衰减阈值，单测可缩短 */
  decayThresholdScore?: number;
  /** 单测可重写：跳过 decay 评估 */
  skipDecayEvaluation?: boolean;
}

export interface JanitorRunSummary {
  scanned: number;
  qualityUpdated: number;
  decayMarked: number;
  archived: number;
}

const DEFAULT_DECAY_THRESHOLD = 0.2;
const DECAY_TRIGGER_WINDOW_DAYS = 14;
const DECAY_TO_ARCHIVE_DAYS = 7;
const DEFAULT_MAX_BATCH = 500;

export async function runJanitorOnce(opts: JanitorOptions): Promise<JanitorRunSummary> {
  const now = (opts.now ?? (() => new Date()))();
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const decayThreshold = opts.decayThresholdScore ?? DEFAULT_DECAY_THRESHOLD;

  // 1) 拿到所有未归档项（按 quality_desc 排序，便于优先处理高质量边缘）
  const rows = await opts.store.query({
    archivalMode: "exclude_archived",
    orderBy: "quality_desc",
    limit: maxBatch,
  });

  let qualityUpdated = 0;
  let decayMarked = 0;
  let archived = 0;

  for (const row of rows) {
    if (row.pinned) continue;

    const newScore = computeQualityScore(row, now);
    if (Math.abs(newScore - row.qualityScore) > 1e-4) {
      await opts.store.update(row.id, { qualityScore: newScore });
      qualityUpdated += 1;
    }

    if (opts.skipDecayEvaluation) continue;

    const decision = evaluateDecay({ ...row, qualityScore: newScore }, now, decayThreshold);

    if (decision === "mark_decay") {
      const decayAt = new Date(now.getTime() + DECAY_TO_ARCHIVE_DAYS * 86_400_000).toISOString();
      await opts.store.update(row.id, { decayAt });
      try {
        await opts.store.logOp({
          experienceId: row.id,
          op: "decay",
          actor: "janitor",
          metadataJson: { reason: "quality_below_threshold", score: newScore },
        });
      } catch (e) {
        warn("logOp:decay", e);
      }
      decayMarked += 1;
    } else if (decision === "archive") {
      await opts.store.update(row.id, { validTo: now.toISOString() });
      try {
        await opts.store.logOp({
          experienceId: row.id,
          op: "archive",
          actor: "janitor",
          metadataJson: { reason: "decay_window_expired" },
        });
      } catch (e) {
        warn("logOp:archive", e);
      }
      archived += 1;
    }
  }

  if (opts.bus) {
    opts.bus.emit({
      type: "maintenance_run",
      kind: "janitor",
      actor: "janitor",
      summary: {
        scanned: rows.length,
        qualityUpdated,
        decayMarked,
        archived,
      },
    });
  }

  return {
    scanned: rows.length,
    qualityUpdated,
    decayMarked,
    archived,
  };
}

// ───────────────────────── 纯函数：可单测 ─────────────────────────

export function computeQualityScore(exp: Experience, now: Date): number {
  const denomUse = Math.max(exp.useCount, 5);
  const base = exp.successCount / denomUse;

  const daysSince = Math.max(0, (now.getTime() - new Date(exp.validFrom).getTime()) / 86_400_000);
  const recency = Math.exp(-daysSince / 30);

  // hitlBoost / conflictPenalty 在 P1 阶段先按 metadataJson 取，未来由 hitl_feedback / links 重算
  const hitlBoost = Number((exp.metadataJson as { hitlBoost?: number }).hitlBoost ?? 0);
  const conflictPenalty = Number(
    (exp.metadataJson as { conflictPenalty?: number }).conflictPenalty ?? 0
  );

  const raw = base * 0.5 + recency * 0.3 + 0.2 + hitlBoost - conflictPenalty;
  return clamp(raw, 0, 1);
}

export type DecayDecision = "noop" | "mark_decay" | "archive";

export function evaluateDecay(
  exp: Experience,
  now: Date,
  threshold = DEFAULT_DECAY_THRESHOLD
): DecayDecision {
  if (exp.pinned) return "noop";

  // 已设 decay_at → 看是否到了归档时机
  if (exp.decayAt) {
    const decayAtTs = new Date(exp.decayAt).getTime();
    const archiveCutoff = decayAtTs + DECAY_TO_ARCHIVE_DAYS * 86_400_000;
    if (now.getTime() >= archiveCutoff) return "archive";
    return "noop";
  }

  // 尚未 decay：仅 quality 低 + valid_from 足够久 才标
  if (exp.qualityScore >= threshold) return "noop";
  const daysSince = (now.getTime() - new Date(exp.validFrom).getTime()) / 86_400_000;
  if (daysSince < DECAY_TRIGGER_WINDOW_DAYS) return "noop";

  return "mark_decay";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function warn(stage: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[experience-janitor] ${stage} failed: ${msg}`);
}
