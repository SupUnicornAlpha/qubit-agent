/**
 * Gap signature 归一化 —— 让不同 detector 对同一 missing tool 能合流。
 *
 * 三种命名空间：
 *   tool:<name>                  — builtin / 未知具体 server 的 mcp 工具
 *   mcp:<server>/<tool>          — 已经知道 server + tool 名的 mcp
 *   concept:<keyword>            — 只描述"想做某事"但没有具体工具名（reflective_mention 常见）
 *
 * 不要 base64 / hash —— signature 是给人看的，前端展示就是它。长度 ≤ 120。
 */

const MAX_SIG_LEN = 120;

/**
 * 归一化候选 tool/mcp 名：去前后空白、统一下划线、限长。
 * 注意保留大小写敏感（mcp 工具名常区分大小写）。
 */
function normalizeName(raw: string): string {
  const t = raw.trim().replace(/\s+/g, "_");
  return t.slice(0, 80);
}

export function makeToolSignature(toolName: string): string {
  const n = normalizeName(toolName);
  return `tool:${n}`.slice(0, MAX_SIG_LEN);
}

export function makeMcpSignature(serverName: string, toolName: string): string {
  const s = normalizeName(serverName);
  const t = normalizeName(toolName);
  return `mcp:${s}/${t}`.slice(0, MAX_SIG_LEN);
}

/**
 * concept signature 用 keyword 关键词（建议 ≤ 6 字 / 2 个 token）。
 * 例：concept:realtime_options_chain / concept:stock_split_history
 * 调用方需要自己保证 keyword 干净（如 trim、去停用词），本函数仅做基础裁切。
 */
export function makeConceptSignature(keyword: string): string {
  const n = keyword.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60);
  return `concept:${n}`.slice(0, MAX_SIG_LEN);
}
