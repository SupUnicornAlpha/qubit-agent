/**
 * Self-Evolving Agent P7 — ToolGapWatcher 主 worker。
 *
 * 流程：
 *   1. 跑 3 路 detector，拿 GapSignal[]（已经按 signature 归一化）
 *   2. 折叠 signal：同 signature 选最佳代表（detection_kind 优先级：
 *      explicit_report > unknown_tool > repeated_fail > reflective_mention）
 *      —— 因为更"确信"的 detector 描述更具体
 *   3. 查 tool_gap_log 有无 status='open' 的同 signature 行：
 *      - 有 → occurrence_count += 1; last_seen_at = now（incremented）
 *      - 没 → INSERT 新行（created）
 *      - 写过 status != 'open'（已 proposed / installed / wont_fix / rejected）→ 不重开（skipped + reason）
 *   4. 写一行 tool_gap_run summary + 100 条 actions 明细
 *   5. emit maintenance_run/tool_gap_watcher event
 *
 * 设计原则：
 *   - 整跑批一个 worker，detector 已读，watcher 只写 + emit；故障重跑安全（不删表）
 *   - explicit_report 也走 watcher 同 ingest 接口（recordExplicitGap），保证 signature/dedup 一致
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { toolGapLog, toolGapRun } from "../../db/sqlite/schema";
import type { ExperienceBus } from "../experience/experience-bus";
import { getExperienceBus } from "../experience/experience-bus";
import {
  detectReflectiveMention,
  detectRepeatedFail,
  detectUnknownTool,
} from "./detectors";
import type { DetectionKind, GapSignal, WatcherRunSummary } from "./types";

const KIND_PRIORITY: Record<DetectionKind, number> = {
  explicit_report: 4,
  unknown_tool: 3,
  repeated_fail: 2,
  reflective_mention: 1,
};

const DEFAULT_WINDOW_HOURS = 24;
const MAX_ACTIONS_PER_RUN = 100;

export interface ToolGapWatcherOptions {
  projectId: string;
  /** 扫描窗口（小时）；默认 24h */
  windowHours?: number;
  /** repeated_fail 阈值；默认 3 */
  repeatedFailThreshold?: number;
  /** 单 detector 最多 N 条 signal；默认 500 */
  maxSignalsPerDetector?: number;
  triggeredBy?: string;
  /** 是否 emit metrics（test 可关） */
  emitMetrics?: boolean;
  /** 额外注入一批 explicit signal（来自 builtin tool.report_gap / POST API），与 detector 输出一起 ingest */
  extraSignals?: GapSignal[];
}

export interface ToolGapWatcherDeps {
  bus?: ExperienceBus;
}

export class ToolGapWatcher {
  private readonly bus: ExperienceBus;

  constructor(deps: ToolGapWatcherDeps = {}) {
    this.bus = deps.bus ?? getExperienceBus();
  }

  async runOnce(opts: ToolGapWatcherOptions): Promise<WatcherRunSummary> {
    if (!opts.projectId) throw new Error("ToolGapWatcher.runOnce: projectId required");
    const startedAt = Date.now();
    const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
    const toTs = new Date(startedAt).toISOString();
    const fromTs = new Date(startedAt - windowHours * 3600_000).toISOString();
    const runId = randomUUID();

    const db = await getDb();
    await db
      .insert(toolGapRun)
      .values({
        id: runId,
        projectId: opts.projectId,
        status: "running",
        triggeredBy: opts.triggeredBy ?? "cron",
        fromTs,
        toTs,
      })
      .run();

    const summary: WatcherRunSummary = {
      runId,
      projectId: opts.projectId,
      status: "completed",
      triggeredBy: opts.triggeredBy ?? "cron",
      fromTs,
      toTs,
      unknownToolCount: 0,
      repeatedFailCount: 0,
      reflectiveMentionCount: 0,
      totalSignals: 0,
      gapsCreated: 0,
      gapsIncremented: 0,
      gapsSkipped: 0,
      actions: [],
      elapsedMs: 0,
    };

    try {
      const baseOpts: {
        projectId: string;
        fromTs: string;
        toTs: string;
        maxSignals?: number;
        repeatedFailThreshold?: number;
      } = {
        projectId: opts.projectId,
        fromTs,
        toTs,
      };
      if (opts.maxSignalsPerDetector !== undefined) baseOpts.maxSignals = opts.maxSignalsPerDetector;
      if (opts.repeatedFailThreshold !== undefined)
        baseOpts.repeatedFailThreshold = opts.repeatedFailThreshold;
      const [unk, rep, ref] = await Promise.all([
        detectUnknownTool(baseOpts),
        detectRepeatedFail(baseOpts),
        detectReflectiveMention(baseOpts),
      ]);
      summary.unknownToolCount = unk.signals.length;
      summary.repeatedFailCount = rep.signals.length;
      summary.reflectiveMentionCount = ref.signals.length;

      // 折叠：按 signature 选优先级最高的 signal 作为"代表"。occurrence_count 在 ingest
      // 时累加，所以这里不要在折叠阶段重复 inc。
      const merged = new Map<string, GapSignal>();
      const allSignals = [
        ...unk.signals,
        ...rep.signals,
        ...ref.signals,
        ...(opts.extraSignals ?? []),
      ];
      summary.totalSignals = allSignals.length;
      for (const s of allSignals) {
        const cur = merged.get(s.signature);
        if (!cur || KIND_PRIORITY[s.kind] > KIND_PRIORITY[cur.kind]) {
          merged.set(s.signature, s);
        }
      }

      // ingest
      for (const sig of merged.values()) {
        const action = await this.ingestSignal(opts.projectId, sig);
        if (action.action === "created") summary.gapsCreated += 1;
        else if (action.action === "incremented") summary.gapsIncremented += 1;
        else summary.gapsSkipped += 1;
        if (summary.actions.length < MAX_ACTIONS_PER_RUN) summary.actions.push(action);
      }
    } catch (e) {
      summary.status = "failed";
      summary.errorMessage = e instanceof Error ? e.message : String(e);
    }

    summary.elapsedMs = Date.now() - startedAt;

    await db
      .update(toolGapRun)
      .set({
        status: summary.status,
        unknownToolCount: summary.unknownToolCount,
        repeatedFailCount: summary.repeatedFailCount,
        reflectiveMentionCount: summary.reflectiveMentionCount,
        totalSignals: summary.totalSignals,
        gapsCreated: summary.gapsCreated,
        gapsIncremented: summary.gapsIncremented,
        gapsSkipped: summary.gapsSkipped,
        actionsJson: summary.actions as unknown as Record<string, unknown>,
        elapsedMs: summary.elapsedMs,
        errorMessage: summary.errorMessage ?? null,
        endedAt: new Date().toISOString(),
      })
      .where(eq(toolGapRun.id, runId));

    if (opts.emitMetrics !== false) {
      try {
        this.bus.emit({
          type: "maintenance_run",
          kind: "tool_gap_watcher",
          actor: "tool_gap_watcher",
          summary: {
            status: summary.status,
            unknownToolCount: summary.unknownToolCount,
            repeatedFailCount: summary.repeatedFailCount,
            reflectiveMentionCount: summary.reflectiveMentionCount,
            totalSignals: summary.totalSignals,
            gapsCreated: summary.gapsCreated,
            gapsIncremented: summary.gapsIncremented,
            gapsSkipped: summary.gapsSkipped,
            elapsedMs: summary.elapsedMs,
          },
        });
      } catch {
        /* metrics 失败不影响主流程 */
      }
    }

    return summary;
  }

  /**
   * 单条 signal ingest（也是 explicit_report 走的入口）：
   *   - 优先找 status='open' 的同 signature 行 → inc occurrence_count
   *   - 没 open 行但存在 non-open 历史（已 wont_fix / proposed / installed / rejected）→ skip
   *     （不要 reopen；reopen 是用户行为，走 routes）
   *   - 都没有 → insert
   */
  async ingestSignal(
    projectId: string,
    sig: GapSignal
  ): Promise<WatcherRunSummary["actions"][number]> {
    const db = await getDb();
    const existing = await db
      .select({
        id: toolGapLog.id,
        status: toolGapLog.status,
        occurrenceCount: toolGapLog.occurrenceCount,
      })
      .from(toolGapLog)
      .where(and(eq(toolGapLog.projectId, projectId), eq(toolGapLog.gapSignature, sig.signature)))
      .all();

    const openRow = existing.find((r) => r.status === "open");
    if (openRow) {
      await db
        .update(toolGapLog)
        .set({
          occurrenceCount: openRow.occurrenceCount + 1,
          lastSeenAt: sig.occurredAt,
          updatedAt: new Date().toISOString(),
          // 不动 detection_kind / excerpt —— 保留最早一条信号的代表性；
          // 想看新证据可以查 metadata_json.last_excerpt
          metadataJson: {
            ...((sig.metadata ?? {}) as Record<string, unknown>),
            lastDetectionKind: sig.kind,
            lastExcerpt: sig.excerpt ?? null,
          },
        })
        .where(eq(toolGapLog.id, openRow.id));
      return {
        signature: sig.signature,
        detectionKind: sig.kind,
        action: "incremented",
        gapId: openRow.id,
      };
    }
    if (existing.length > 0) {
      // 存在非 open 行 → 不动；用户已决策过
      return {
        signature: sig.signature,
        detectionKind: sig.kind,
        action: "skipped",
        skipReason: `existing ${existing[0]!.status}; user-decided gap not auto-reopened`,
      };
    }
    const id = `gap_${randomUUID()}`;
    await db
      .insert(toolGapLog)
      .values({
        id,
        projectId,
        workflowRunId: sig.workflowRunId ?? null,
        definitionId: sig.definitionId ?? null,
        detectionKind: sig.kind,
        gapSignature: sig.signature,
        requestedToolName: sig.requestedToolName ?? null,
        requestedToolKind: sig.requestedToolKind ?? null,
        excerpt: sig.excerpt ?? null,
        sourceToolCallId: sig.sourceToolCallId ?? null,
        sourceExperienceId: sig.sourceExperienceId ?? null,
        occurrenceCount: 1,
        firstSeenAt: sig.occurredAt,
        lastSeenAt: sig.occurredAt,
        status: "open",
        metadataJson: (sig.metadata ?? {}) as Record<string, unknown>,
      })
      .run();
    return {
      signature: sig.signature,
      detectionKind: sig.kind,
      action: "created",
      gapId: id,
    };
  }
}

/**
 * 给 builtin tool.report_gap / POST API 用的便捷入口：
 * 不跑 detector，只把一条 explicit_report signal ingest 进去。
 */
export async function reportExplicitGap(input: {
  projectId: string;
  signature: string;
  excerpt?: string;
  requestedToolName?: string;
  requestedToolKind?: string;
  workflowRunId?: string;
  definitionId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ action: "created" | "incremented" | "skipped"; gapId?: string; signature: string }> {
  const watcher = new ToolGapWatcher();
  const r = await watcher.ingestSignal(input.projectId, {
    kind: "explicit_report",
    signature: input.signature,
    projectId: input.projectId,
    workflowRunId: input.workflowRunId ?? null,
    definitionId: input.definitionId ?? null,
    requestedToolName: input.requestedToolName ?? null,
    requestedToolKind: input.requestedToolKind ?? null,
    excerpt: input.excerpt ?? null,
    occurredAt: new Date().toISOString(),
    metadata: input.metadata ?? {},
  });
  const out: { action: "created" | "incremented" | "skipped"; gapId?: string; signature: string } = {
    action: r.action,
    signature: r.signature,
  };
  if (r.gapId) out.gapId = r.gapId;
  return out;
}

/** sql 引用占位，确保 import 不被 tsc 优化掉（drizzle 类型推断需要） */
void sql;
