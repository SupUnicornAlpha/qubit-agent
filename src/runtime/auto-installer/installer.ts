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
import { autoInstallProposal, autoInstallerRun, toolGapLog } from "../../db/sqlite/schema.js";
import { getSelfEvolveConfig } from "../config/self-evolve-config.js";
import { type ExperienceBus, getExperienceBus } from "../experience/experience-bus.js";
import { installMcpCatalogToProject } from "../mcp/install-service.js";
import { findCandidatesForGap } from "./candidate-matcher.js";
import { approveProposal } from "./lifecycle.js";
import type { AutoInstallerRunSummary, MatchCandidate, ProposalKind } from "./types.js";

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
  /**
   * P9 auto 模式覆盖：默认从 getSelfEvolveConfig() 读 autoInstallMode。
   * 单测可以直接传 'auto' 而不动 env / config singleton。
   * 仅当 mode='auto' + 候选 safetyLevel='low' + source='builtin'
   *   + score≥minScoreForAuto 时才走自动 approve+真装链路。
   * external（source='registry'）无论 safety 都走 propose（registry 来源风险敞口更大）。
   */
  autoModeOverride?: "off" | "propose" | "auto";
  /** 同上：覆盖 minScoreForAuto */
  minScoreForAutoOverride?: number;
}

export interface AutoInstallerDeps {
  bus?: ExperienceBus;
}

interface ActionEntry {
  gapId: string;
  gapSignature: string;
  action:
    | "proposed"
    | "skipped_existing"
    | "no_candidate"
    | "auto_installed"
    | "auto_install_failed";
  proposalId?: string;
  candidate?: { slug: string; score: number; targetKind: string };
  installId?: string;
  reason?: string;
}

const DEFAULT_MAX_GAPS_PER_RUN = 50;
const MAX_ACTIONS_PER_RUN = 100;

function pickProposalKind(c: MatchCandidate | null): ProposalKind {
  if (!c) return "no_candidate";
  // Schema 收敛 C4 后：所有候选 targetKind 都是 'mcp_catalog'，但需要按 source 字段
  // 区分 install_mcp_catalog（builtin/fsi）vs install_mcp_external（registry 同步来的）。
  return c.source === "registry" ? "install_mcp_external" : "install_mcp_catalog";
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
      autoInstalled: 0,
      autoInstallFailed: 0,
      elapsedMs: 0,
      startedAt: new Date(startedAt).toISOString(),
    };
    const actions: ActionEntry[] = [];

    // P9：决定本次跑批走 propose 还是 auto；override > config
    const cfg = getSelfEvolveConfig();
    const mode = opts.autoModeOverride ?? cfg.autoInstallMode;
    const minScoreForAuto = opts.minScoreForAutoOverride ?? cfg.minScoreForAuto;
    if (mode === "off") {
      // 跟 propose 一样跑（兼容性：单测早就直接 new AutoInstaller().runOnce 不传 mode）；
      // 真正全停由 cron 层 gate selfEvolveDisabledReason() 控制。
    }

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
        // P9 auto 判定：safetyLevel=low + source=builtin（合表前的 mcp_catalog） + score≥阈值 → 自动 approve+真装
        // external（合表前的 mcp_catalog_item，即 source=registry）无论 safety 都走 propose（registry 来源风险更大）
        const autoEligible =
          mode === "auto" &&
          best.safetyLevel === "low" &&
          best.source === "builtin" &&
          best.score >= minScoreForAuto;

        const proposalId = await this.insertProposal({
          projectId: opts.projectId,
          gapLogId: gap.id,
          kind: pickProposalKind(best),
          state: "pending_review",
          best,
          candidates,
          proposerRunId: runId,
        });
        // 同步 gap status → proposed（无论是否 auto 都先走这一步；auto 路径接下来会再翻 installed）
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

        if (autoEligible && best.targetId) {
          // ── auto 模式：approve + 真装 ──
          // 任一步抛错都翻 auto_install_failed；proposal 保持 pending_review 留给人工审批
          try {
            const install = await installMcpCatalogToProject({
              catalogId: best.targetId,
              serverName: best.targetSlug ?? best.targetId,
              installedBy: "auto_installer",
              ...(best.payload.defaultToolName ? { toolName: best.payload.defaultToolName } : {}),
            });
            await approveProposal({
              proposalId,
              actor: "auto_installer",
              reason: `auto-approved (mode=auto, safety=low, score=${best.score} ≥ ${minScoreForAuto})`,
            });
            summary.autoInstalled = (summary.autoInstalled ?? 0) + 1;
            if (actions.length < MAX_ACTIONS_PER_RUN) {
              actions.push({
                gapId: gap.id,
                gapSignature: gap.gapSignature,
                action: "auto_installed",
                proposalId,
                installId: install.installId,
                candidate: {
                  slug: best.targetSlug,
                  score: best.score,
                  targetKind: best.targetKind,
                },
              });
            }
          } catch (autoErr) {
            summary.autoInstallFailed = (summary.autoInstallFailed ?? 0) + 1;
            if (actions.length < MAX_ACTIONS_PER_RUN) {
              actions.push({
                gapId: gap.id,
                gapSignature: gap.gapSignature,
                action: "auto_install_failed",
                proposalId,
                candidate: {
                  slug: best.targetSlug,
                  score: best.score,
                  targetKind: best.targetKind,
                },
                reason: autoErr instanceof Error ? autoErr.message : String(autoErr),
              });
            }
          }
        } else if (actions.length < MAX_ACTIONS_PER_RUN) {
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
            mode,
            gapsScanned: summary.gapsScanned,
            proposalsCreated: summary.proposalsCreated,
            proposalsSkippedExisting: summary.proposalsSkippedExisting,
            proposalsNoCandidate: summary.proposalsNoCandidate,
            autoInstalled: summary.autoInstalled ?? 0,
            autoInstallFailed: summary.autoInstallFailed ?? 0,
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
