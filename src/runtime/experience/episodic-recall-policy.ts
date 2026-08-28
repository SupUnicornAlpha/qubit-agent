/**
 * Episodic 选择性召回策略 — 与 recall.ts 解耦，便于单测与后续扩展 subKind 白名单。
 *
 * 原则：默认排除 episodic（workflow_trail 噪声大）；仅在「同 workflow 续跑」等
 * 高信号场景下允许少量 trail 进入池子。
 */
import type { Experience } from "../../types/entities";
import type { RecallContext } from "../pipes/recall";

/** 全局允许的 episodic subKind（跨 workflow）；默认空，按需扩展。 */
export const EPISODIC_SUBKIND_ALLOWLIST = new Set<string>([]);

const SAME_WORKFLOW_TRAIL_SUBKIND = "workflow_trail";

/** 是否应尝试查询 episodic 池（有 workflowRunId 时才值得查同 run trail）。 */
export function shouldQueryEpisodicPool(ctx: RecallContext): boolean {
  return Boolean(ctx.workflowRunId?.trim());
}

/** 单条 episodic 是否可进入 recall 池。 */
export function isEpisodicRecallAllowed(exp: Experience, ctx: RecallContext): boolean {
  if (exp.kind !== "episodic") return false;

  const sub = exp.subKind ?? "";
  if (EPISODIC_SUBKIND_ALLOWLIST.has(sub)) return true;

  const wfId = ctx.workflowRunId?.trim();
  if (
    sub === SAME_WORKFLOW_TRAIL_SUBKIND &&
    wfId &&
    exp.scope === "workflow" &&
    exp.scopeId === wfId
  ) {
    return true;
  }

  return false;
}

/** episodic 池上限（低于 semantic 池，控制 token）。 */
export const EPISODIC_POOL_LIMIT = 12;
