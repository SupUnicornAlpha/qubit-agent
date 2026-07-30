/**
 * project-id.ts
 *
 * 集中 projectId 形态校验逻辑，供 act 入口 / builtin-tools / connector 入参兜底使用。
 *
 * 历史：原 `looksLikePlaceholderProjectId` 是反向黑名单（known placeholder list），
 * LLM 创造的新业务化占位（如 `ai_semiconductor_technical`、`aapl_trend_v1`、
 * `nvda_research`）逃过拦截，导致 factor.autoEvaluate 内部 register 时
 * `factor_definition.project_id` 被设为非法值，触发 SQLite FK constraint。
 *
 * 新策略：**正向白名单**。一个字符串"看起来像合法 projectId"当且仅当：
 *   1) UUID v1-v5 任意格式（带连字符，36 字符；大小写不敏感）；OR
 *   2) `proj-*` 前缀的老 seed 格式（兼容历史数据如 `proj-test`, `proj-hitl-p03`）。
 *
 * 其它一律返回 false（让上层 fallback 到 ctx.projectId / workflow_run.project_id）。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_PROJ_RE = /^proj-[a-z0-9\-]+$/i;

export function isLikelyProjectIdFormat(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (UUID_RE.test(trimmed)) return true;
  if (LEGACY_PROJ_RE.test(trimmed)) return true;
  return false;
}
