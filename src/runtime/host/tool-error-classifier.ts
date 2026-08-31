/**
 * Bun Host tool-error classifier.
 *
 * Shared by prime-bridge / tool-call-log / MCP — not part of an Agent loop.
 */

export type ToolErrorClass = "transient" | "permanent" | "blocked" | "unknown";

const TRANSIENT_PATTERNS: RegExp[] = [
  /\btimed?\s*out\b/i,
  /\bAbortError\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bENETUNREACH\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENOENT\b/i,
  /\b5\d{2}\b/,
  /\b429\b/i,
  /\brate\s*limit/i,
  /\btoo many requests\b/i,
  /\bstream closed\b/i,
  /\btransport closed\b/i,
  /\bsubprocess\s+exited\b/i,
  /\bcircuit breaker open\b/i,
  /\bdispatch_timeout_data_unknown\b/i,
  /\bteam_dispatch_timeout\b/i,
  /提前退出/,
  /关闭了\s*stdout/,
];

const PERMANENT_PATTERNS: RegExp[] = [
  /\b4(0[0-46-9]|1\d|2\d|3\d)\b/,
  /\binvalid\s+(argument|parameter|param|body|input|json)/i,
  /\bvalidation_failed\b/i,
  /\bnot_found\b/i,
  /\bunsupported\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\brequired\b.*\b(missing|absent|empty)/i,
  /\bis\s+required\b/i,
  /\bis\s+not\s+implemented\b/i,
  /\bmissing_symbol\b/i,
  /\barity_violation\b/i,
  /semantic_data_failure:(?:semantic_empty_result|[^:\s]*_empty|bar_count_zero|no_bars|no_data|data_status_unavailable|synthetic_data)/i,
  /\b(?:fundamentals|market)_data_unavailable\b/i,
  /\b(?:fundamentals|quote|news)_source_unavailable\b/i,
  /real-time quote source is not configured/i,
  /delayed quote failed for market=/i,
  /no_factor_values_written/i,
  /sample_size_too_small/i,
  /factor_not_found/i,
  /factor_expression_batch_too_small/i,
  /invalid_qty/i,
  /mcp_validation_error/i,
  /web\s*search.*no\s+parseable\s+results/i,
  /duckduckgo\s+search\s+returned\s+no\s+parseable\s+results/i,
];

const BLOCKED_PATTERNS: RegExp[] = [
  /\bsandbox\b/i,
  /\bblocked\b/i,
  /\bnot_allowed\b/i,
  /\bgate_denied\b/i,
  /\bdisabled\b/i,
  /\bcircuit\b/i,
];

export function classifyToolError(message: string): ToolErrorClass {
  if (!message) return "unknown";
  for (const p of BLOCKED_PATTERNS) if (p.test(message)) return "blocked";
  for (const p of TRANSIENT_PATTERNS) if (p.test(message)) return "transient";
  for (const p of PERMANENT_PATTERNS) if (p.test(message)) return "permanent";
  return "unknown";
}

export function buildMcpRetryHint(
  errorClass: ToolErrorClass,
  message: string,
  toolName: string
): string {
  switch (errorClass) {
    case "transient":
      return `工具「${toolName}」遇到瞬时错误；可按 recovery 预算重试，预算耗尽后必须换数据源或降级。原因：${truncate(message)}`;
    case "permanent":
      return `工具「${toolName}」遇到不可重试错误（参数/权限/路径错），请修正参数或改用其他工具。原因：${truncate(message)}`;
    case "blocked":
      return `工具「${toolName}」被沙箱或熔断拒绝，本轮请换别的工具或退化为文字推理。原因：${truncate(message)}`;
    default:
      return `工具「${toolName}」失败，无法判断错误类别；建议换工具或退化文字结论，不要反复重试相同调用。原因：${truncate(message)}`;
  }
}

function truncate(s: string, max = 200): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
