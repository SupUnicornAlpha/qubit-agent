/**
 * P0-4 W1 mini-fix：把工具错误消息分类为 transient / permanent / blocked / unknown，
 * 让 act.ts 给 ReAct observation 加结构化字段 `errorClass / retryable / hint`，
 * 让下一轮 LLM 能基于此换工具或换参，而不是反复重试同一个错误。
 *
 * 不依赖 HTTP status 等结构化信息（act.ts 拿到的只有 Error.message），所以这里靠
 * 字符串模式识别 —— 命中率覆盖最常见的几类（timeout / 4xx / 5xx / abort / sandbox），
 * 不命中归 unknown（retryable=false，保守不重试）。
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
  /*
   * 本仓自产的中文子进程崩溃/断流消息（瞬时崩，重试可能成功）：
   *   - stdio-session._formatStdioExitErrorMessage → "子进程在 <phase> 阶段提前退出"
   *   - jsonrpc-ndjson collectRpcResponse        → "子进程在响应 id=N 前关闭了 stdout"
   * 用精确短语「提前退出」「关闭了 stdout」锚定，避免误伤协议不兼容的
   * 「子进程拒绝了…protocolVersion」（那是 permanent，重试无意义）。
   */
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
];

const BLOCKED_PATTERNS: RegExp[] = [
  /\bsandbox\b/i,
  /\bblocked\b/i,
  /\bnot_allowed\b/i,
  /\bdisabled\b/i,
  /\bcircuit\b/i, // circuit breaker open 也算软封禁
];

export function classifyToolError(message: string): ToolErrorClass {
  if (!message) return "unknown";
  /** blocked 优先（先看 sandbox / circuit），再 transient → permanent；其余 unknown */
  for (const p of BLOCKED_PATTERNS) if (p.test(message)) return "blocked";
  for (const p of TRANSIENT_PATTERNS) if (p.test(message)) return "transient";
  for (const p of PERMANENT_PATTERNS) if (p.test(message)) return "permanent";
  return "unknown";
}

/**
 * 给 LLM 看的简短提示。reason.ts prompt 把整个 observation JSON 喂回去，
 * 这段 hint 会带着进下一轮，让模型自己决定是否换工具/换参/退化产出文字结论。
 */
export function buildMcpRetryHint(
  errorClass: ToolErrorClass,
  message: string,
  toolName: string
): string {
  switch (errorClass) {
    case "transient":
      return `MCP 工具「${toolName}」遇到瞬时错误，已自动重试过；如再次失败请换其他数据源或暂停该步并产出文字结论。原因：${truncate(message)}`;
    case "permanent":
      return `MCP 工具「${toolName}」遇到不可重试错误（参数/权限/路径错），请修正参数后重试或改用其他工具。原因：${truncate(message)}`;
    case "blocked":
      return `MCP 工具「${toolName}」被沙箱或熔断暂时拒绝（不在允许列表/熔断 cooldown 中），本轮请换别的工具或退化为文字推理。原因：${truncate(message)}`;
    default:
      return `MCP 工具「${toolName}」失败，无法判断错误类别；建议本轮换工具或退化文字结论，不要反复重试相同调用。原因：${truncate(message)}`;
  }
}

function truncate(s: string, max = 200): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
