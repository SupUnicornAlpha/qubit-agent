/**
 * MCP 反向桥的工具准入守门（纯函数，便于单测）。
 *
 * 治理红线（docs/CLI_AGENT_PROJECTION_DESIGN.md §5）：外部 CLI（claude/codex）经桥
 * 回调 QUBIT 工具时，**下单 / 实盘 / 写外部状态等高危工具默认拒绝**——无论它来自
 * 哪个 MCP server。这是单一咽喉点的纵深防御：即便某 MCP server 暴露了 order 类工具，
 * 桥也不放行。下单仍由 QUBIT 控制面在 A2A 治理（riskSignature）下执行。
 *
 * 可选 allow 白名单：非空时，`serverName/toolName` 必须命中至少一条才放行。
 * deny 永远生效（默认高危表 + 调用方追加），且优先级高于 allow。
 *
 * 匹配语法：`server/tool`，星号为通配（贪婪），其余字符（含 `.`、`/`）按字面匹配，
 * 大小写不敏感。例：通配任意 server 的 submit_order、整个 execution server、
 * 任意 server 的 order.* 工具、名字含 broker 的 server。
 */

/** 默认高危拒绝表——下单 / 撤单 / 实盘 / 划转 / 经纪商。 */
export const DEFAULT_HIGH_RISK_DENY: readonly string[] = [
  "*/order.*",
  "*/submit_order",
  "*/cancel_order",
  "*/place_order",
  "*/create_order",
  "*/create_intent",
  "*/order_intent",
  "*/execute_trade",
  "*/live_*",
  "*/withdraw*",
  "*/transfer*",
  "execution/*",
  "*broker*/*",
];

/** glob → 锚定的大小写不敏感正则；`*` 通配，其余字面（含 `.`/`/`）。 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((seg) => seg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

export interface ToolPermitInput {
  serverName: string;
  toolName: string;
  /** 非空时作为白名单（必须命中其一）。 */
  allow?: readonly string[] | undefined;
  /** 追加拒绝项；与 DEFAULT_HIGH_RISK_DENY 合并。 */
  deny?: readonly string[] | undefined;
}

export interface ToolPermitResult {
  ok: boolean;
  reason?: string;
}

/** 判定某 MCP 工具调用是否被桥放行。 */
export function isToolPermitted(input: ToolPermitInput): ToolPermitResult {
  const key = `${input.serverName}/${input.toolName}`;
  const denyList = [...DEFAULT_HIGH_RISK_DENY, ...(input.deny ?? [])];
  for (const p of denyList) {
    if (globToRegExp(p).test(key)) {
      return { ok: false, reason: `denied by policy: '${key}' matches '${p}'` };
    }
  }
  const allow = input.allow ?? [];
  if (allow.length > 0) {
    const hit = allow.some((p) => globToRegExp(p).test(key));
    if (!hit) {
      return { ok: false, reason: `not in allowlist: '${key}'` };
    }
  }
  return { ok: true };
}

/** 解析逗号分隔的 env 模式列表（去空白、去空项）。 */
export function parseToolPatternEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
