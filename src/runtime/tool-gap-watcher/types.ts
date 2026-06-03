/**
 * Self-Evolving Agent P7 — ToolGapWatcher 类型定义。
 *
 * 设计要点：
 *   - 「Signal」是 detector 输出的原子证据（"某 tool_call 报 unknown tool" / "某 reflective 提到缺工具"）。
 *   - 「Gap」是 ToolGapWatcher 把多个 signal 按 gap_signature 折叠后落库的逻辑实体（tool_gap_log 一行）。
 *   - signature 归一化由 detector 决定（不由 watcher 知道），保证不同 detector 对同一缺口能合流。
 */

export type DetectionKind =
  | "unknown_tool"
  | "repeated_fail"
  | "reflective_mention"
  | "explicit_report";

export interface GapSignal {
  kind: DetectionKind;
  /** 归一化签名：'tool:get_weather' / 'mcp:slack/post_message' / 'concept:realtime_options_chain' */
  signature: string;
  projectId: string;
  /** 与原始证据强相关，给 propose 时还原上下文用；可空 */
  workflowRunId?: string | null;
  definitionId?: string | null;
  requestedToolName?: string | null;
  /** 'mcp' / 'builtin' / 'unknown' */
  requestedToolKind?: string | null;
  /** 摘要文本（errorMessage 片段 / mention 原文 / 用户 reason） */
  excerpt?: string | null;
  /** best-effort 关联，不打 FK */
  sourceToolCallId?: string | null;
  sourceExperienceId?: string | null;
  /** 触发时间（用 last_seen_at 更新） */
  occurredAt: string;
  /** 自由扩展 */
  metadata?: Record<string, unknown>;
}

/** detector 返回的扫描汇总 + 单条 signal */
export interface DetectorResult {
  kind: DetectionKind;
  scannedRows: number;
  signals: GapSignal[];
}

/** Watcher 单次跑批的总览 */
export interface WatcherRunSummary {
  runId: string;
  projectId: string;
  status: "completed" | "failed";
  triggeredBy: string;
  fromTs: string | null;
  toTs: string | null;

  unknownToolCount: number;
  repeatedFailCount: number;
  reflectiveMentionCount: number;
  totalSignals: number;
  gapsCreated: number;
  gapsIncremented: number;
  gapsSkipped: number;

  /** 按 signature 折叠后的明细，给前端展示（截断至 100 条） */
  actions: Array<{
    signature: string;
    detectionKind: DetectionKind;
    action: "created" | "incremented" | "skipped";
    skipReason?: string;
    gapId?: string;
  }>;
  elapsedMs: number;
  errorMessage?: string;
}
