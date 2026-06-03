/**
 * Self-Evolving Agent P8 — AutoInstaller propose 模式主 worker。
 *
 * 流程：
 *   1. 扫 tool_gap_log.status='open' & project_id=opts.projectId 的 gap
 *   2. 对每条 gap 调 candidate-matcher 查 top-3 候选
 *   3. 若 gap 已经有 pending_review proposal → skip（partial-unique idx 兜底，但显式避免 INSERT 报错）
 *   4. 命中候选 → INSERT auto_install_proposal(pending_review) + UPDATE gap.status='proposed'
 *   5. 无候选 → INSERT proposal(no_candidate, state='no_candidate') + gap 维持 open
 *   6. 写一行 auto_installer_run summary + emit maintenance_run/auto_installer
 *
 * 设计取舍：
 *   - propose 不真去装；安装只在用户 approve 后调 mcp catalog 已有装机器。
 *   - "no_candidate" 也落 proposal —— 让前端能看到"扫到了但 catalog 里没有"，提醒补 catalog。
 *   - gap.status='proposed' 只在 install_mcp_* 时更新；no_candidate 不改 gap，下轮可再扫
 *     （catalog 可能扩展后会匹配到）。
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../../db/sqlite/client.js";
import {
  autoInstallProposal,
  autoInstallerRun,
  toolGapLog,
} from "../../db/sqlite/schema.js";
import { getExperienceBus, type ExperienceBus } from "../experience/experience-bus.js";
import { findCandidatesForGap } from "./candidate-matcher.js";
import type {
  AutoInstallerRunSummary,
  MatchCandidate,
  ProposalKind,
} from "./types.js";

export interface AutoInstallerRunOptions {
  projectId: string;
  /** 单次最多 propose N 条；防爆库 */
  maxGapsPerRun?: number;
  /** matchScore 阈值；默认 0.3 */
  scoreThreshold?: number;
  /** top-K 候选；默认 3 */
  topK?: number;
  triggeredBy?: string;
  emitMetrics?: boolean;
}

export interface AutoInstallerDeps {
  bus?: ExperienceBus;
}

interface ActionEntry {
  gapId: string;
  gapSignature: string;
  action: "proposed" | "skipped_existing" | "no_candidate";
  proposalId?: string;
  candidate?: { slug: string; score: number; targetKind: string };
  reason?: string;
}

const DEFAULT_MAX_GAPS_PER_RUN = 50;
const MAX_ACTIONS_PER_RUN = 100;

function pickProposalKind(c: MatchCandidate | null): ProposalKind {
  if (!c) return "no_candidate";
  return c.targetKind === "mcp_catalog" ? "install_mcp_catalog" : "install_mcp_external";
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AutoInstaller {
  private readonly bus: ExperienceBus;

  constructor(deps: AutoInstallerDeps = {}) {
    this.bus = deps.bus ?? getExperienceBus();
  }

  async runOnce(opts: AutoInstallerRunOptions): Promise<AutoInstallerRunSummary> {
    if (!opts.projectId) throw new Error("AutoInstaller.runOnce: projectId required");
    const startedAt = Date.now();
    const runId = randomUUID();
    const db = await getDb();

    await db
      .insert(autoInstallerRun)
      .values({
        id: runId,
        projectId: opts.projectId,
        status: "running",
        triggeredBy: opts.triggeredBy ?? "cron",
      })
      .run();

    const summary: AutoInstallerRunSummary = {
      runId,
      projectId: opts.projectId,
      status: "completed",
      gapsScanned: 0,
      proposalsCreated: 0,
      proposalsSkippedExisting: 0,
      proposalsNoCandidate: 0,
      elapsedMs: 0,
      startedAt: new Date(startedAt).toISOString(),
    };
    const actions: ActionEntry[] = [];

    try {
      const maxGaps = opts.maxGapsPerRun ?? DEFAULT_MAX_GAPS_PER_RUN;
      const openGaps = await db
        .select({
          id: toolGapLog.id,
          gapSignature: toolGapLog.gapSignature,
          detectionKind: toolGapLog.detectionKind,
        })
        .from(toolGapLog)
        .where(and(eq(toolGapLog.projectId, opts.projectId), eq(toolGapLog.status, "open")))
        .orderBy(asc(toolGapLog.firstSeenAt))
        .limit(maxGaps)
        .all();

      summary.gapsScanned = openGaps.length;

      for (const gap of openGaps) {
        // 已经有 pending_review proposal → skip
        const existing = await db
          .select({ id: autoInstallProposal.id })
          .from(autoInstallProposal)
          .where(
            and(
              eq(autoInstallProposal.gapLogId, gap.id),
              eq(autoInstallProposal.state, "pending_review")
            )
          )
          .all();

        if (existing.length > 0) {
          summary.proposalsSkippedExisting += 1;
          if (actions.length < MAX_ACTIONS_PER_RUN) {
            actions.push({
              gapId: gap.id,
              gapSignature: gap.gapSignature,
              action: "skipped_existing",
              reason: "pending_review proposal already exists",
              proposalId: existing[0]!.id,
            });
          }
          continue;
        }

        const candidates = await findCandidatesForGap(gap.gapSignature, {
          topK: opts.topK ?? 3,
          scoreThreshold: opts.scoreThreshold ?? 0.3,
        });

        if (candidates.length === 0) {
          const proposalId = await this.insertProposal({
            projectId: opts.projectId,
            gapLogId: gap.id,
            kind: "no_candidate",
            state: "no_candidate",
            best: null,
            candidates: [],
            proposerRunId: runId,
          });
          summary.proposalsNoCandidate += 1;
          if (actions.length < MAX_ACTIONS_PER_RUN) {
            actions.push({
              gapId: gap.id,
              gapSignature: gap.gapSignature,
              action: "no_candidate",
              proposalId,
              reason: "no catalog match (consider expanding mcp_catalog)",
            });
          }
          continue;
        }

        const best = candidates[0]!;
        const proposalId = await this.insertProposal({
          projectId: opts.projectId,
          gapLogId: gap.id,
          kind: pickProposalKind(best),
          state: "pending_review",
          best,
          candidates,
          proposerRunId: runId,
        });
        // 同步 gap status
        await db
          .update(toolGapLog)
          .set({
            status: "proposed",
            statusAt: nowIso(),
            statusBy: "auto_installer",
            statusReason: `proposed candidate ${best.targetSlug} (score=${best.score})`,
            updatedAt: nowIso(),
          })
          .where(eq(toolGapLog.id, gap.id));
        summary.proposalsCreated += 1;
        if (actions.length < MAX_ACTIONS_PER_RUN) {
          actions.push({
            gapId: gap.id,
            gapSignature: gap.gapSignature,
            action: "proposed",
            proposalId,
            candidate: { slug: best.targetSlug, score: best.score, targetKind: best.targetKind },
          });
        }
      }
    } catch (e) {
      summary.status = "failed";
      summary.errorMessage = e instanceof Error ? e.message : String(e);
    }

    summary.elapsedMs = Date.now() - startedAt;
    summary.endedAt = nowIso();

    await db
      .update(autoInstallerRun)
      .set({
        status: summary.status,
        gapsScanned: summary.gapsScanned,
        proposalsCreated: summary.proposalsCreated,
        proposalsSkippedExisting: summary.proposalsSkippedExisting,
        proposalsNoCandidate: summary.proposalsNoCandidate,
        actionsJson: actions as unknown as Record<string, unknown>,
        elapsedMs: summary.elapsedMs,
        errorMessage: summary.errorMessage ?? null,
        endedAt: summary.endedAt,
      })
      .where(eq(autoInstallerRun.id, runId));

    if (opts.emitMetrics !== false) {
      try {
        this.bus.emit({
          type: "maintenance_run",
          kind: "auto_installer",
          actor: "auto_installer",
          summary: {
            status: summary.status,
            gapsScanned: summary.gapsScanned,
            proposalsCreated: summary.proposalsCreated,
            proposalsSkippedExisting: summary.proposalsSkippedExisting,
            proposalsNoCandidate: summary.proposalsNoCandidate,
            elapsedMs: summary.elapsedMs,
          },
        });
      } catch {
        /* metrics 失败不影响主流程 */
      }
    }

    return summary;
  }

  private async insertProposal(args: {
    projectId: string;
    gapLogId: string;
    kind: ProposalKind;
    state: "pending_review" | "no_candidate";
    best: MatchCandidate | null;
    candidates: MatchCandidate[];
    proposerRunId: string;
  }): Promise<string> {
    const db = await getDb();
    const id = `prop_${randomUUID()}`;
    const { best, candidates } = args;
    const candidatesSnapshot = candidates.map((c) => ({
      targetKind: c.targetKind,
      targetId: c.targetId,
      targetSlug: c.targetSlug,
      name: c.name,
      score: c.score,
      ruleHits: c.ruleHits,
      safetyLevel: c.safetyLevel,
    }));

    await db
      .insert(autoInstallProposal)
      .values({
        id,
        projectId: args.projectId,
        gapLogId: args.gapLogId,
        proposalKind: args.kind,
        safetyLevel: best?.safetyLevel ?? "medium",
        matchScore: best?.score ?? 0,
        targetKind: best?.targetKind ?? null,
        targetId: best?.targetId ?? null,
        targetSlug: best?.targetSlug ?? null,
        payloadJson: best ? best.payload : {},
        candidatesJson: candidatesSnapshot as unknown as Record<string, unknown>,
        state: args.state,
        stateAt: args.state === "no_candidate" ? nowIso() : null,
        stateBy: args.state === "no_candidate" ? "auto_installer" : null,
        stateReason: args.state === "no_candidate" ? "no_catalog_match" : null,
        proposerRunId: args.proposerRunId,
      })
      .run();
    return id;
  }
}

/** 给 routes / cron 用的便捷入口，等价于 new AutoInstaller().runOnce */
export async function runAutoInstallerOnce(
  opts: AutoInstallerRunOptions
): Promise<AutoInstallerRunSummary> {
  return new AutoInstaller().runOnce(opts);
}
