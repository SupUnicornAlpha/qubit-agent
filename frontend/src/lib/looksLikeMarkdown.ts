/**
 * 启发式判断 LLM 消息是否值得走 Markdown 渲染。
 * 短 ack（如「目标明确：**标的…**」）只有加粗 / 行内代码时也必须命中，
 * 否则气泡会把 `**` / `` ` `` 原样露出来。
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  if (/```|~~~/.test(text)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;
  if (/(^|\n)#{1,6}\s/.test(text)) return true;
  if (/(^|\n)>\s/.test(text)) return true;
  if (/(^|\n)\s*([-*+]\s|\d+\.\s)/.test(text)) return true;
  // 强调：成对 ** / __（至少包一层非空内容）；避免单独 `*` 误伤普通星号。
  if (/\*\*[^*\n]+?\*\*|__[^_\n]+?__/.test(text)) return true;
  // 行内代码（非围栏）
  if (/`[^`\n]+`/.test(text)) return true;
  // GFM table 需要至少表头 + 分隔行两行 `|`：
  const lines = text.split("\n");
  let pipeLines = 0;
  for (const line of lines) {
    if (line.includes("|")) pipeLines++;
    if (pipeLines >= 2) return true;
  }
  return false;
}
