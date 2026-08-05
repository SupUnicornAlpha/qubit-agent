/**
 * Official internet builtins (`web.search` / `web.fetch`).
 *
 * These are research-default capabilities with in-handler SSRF guards. They must
 * not depend on lagging business sandbox allow-lists — same failure mode that
 * previously advertised `web.fetch` in effective tools then blocked it at act.
 */

export const INTERNET_BUILTIN_TOOLS = ["web.fetch", "web.search"] as const;

const INTERNET_BUILTIN_TOOL_SET = new Set<string>(INTERNET_BUILTIN_TOOLS);

export function isInternetBuiltinTool(toolName: string): boolean {
  return INTERNET_BUILTIN_TOOL_SET.has(toolName);
}
