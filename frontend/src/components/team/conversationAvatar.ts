/**
 * Agent 头像配色 / 缩写工具。
 *
 * 设计要点：
 * - 颜色对每个 role 是稳定确定的（基于 hash），新 role 加进来不需要改 mapping。
 * - 已知 role 直接命中预设色，让常用角色有更"品牌化"的辨识度。
 * - 缩写 / 全名：优先走 i18n 字典（team.role.abbr.* / team.role.name.*），
 *   未命中时回落到拉丁字符首字母 / 原始 role id。
 *
 * 特殊伪角色：
 * - `__team__`：Orchestrator 的 fan-out 广播目标（runtime 会展开成各 role），
 *   UI 展示成"全员"虚拟节点。
 * - `__tools__`：拓扑画布把 connector / mcp 工具调用聚合到这个伪角色上。
 */
import { t } from "../../i18n";

const KNOWN_ROLES: ReadonlySet<string> = new Set([
  "orchestrator",
  "research",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "analyst",
  "backtest",
  "risk",
  "risk_monitor",
  "msa",
  "audit",
  "memory_curator",
  "market_data",
  "news_event",
  "execution",
  "simulation",
  "memory",
  "__team__",
  "__tools__",
]);

const PRESET_COLORS: Record<string, { bg: string; fg: string }> = {
  orchestrator: { bg: "#f59e0b", fg: "#1c1917" },
  research: { bg: "#3b82f6", fg: "#f8fafc" },
  analyst_fundamental: { bg: "#10b981", fg: "#022c22" },
  analyst_technical: { bg: "#8b5cf6", fg: "#1e1b4b" },
  analyst_sentiment: { bg: "#ec4899", fg: "#500724" },
  analyst_macro: { bg: "#06b6d4", fg: "#083344" },
  backtest: { bg: "#a3e635", fg: "#1a2e05" },
  risk: { bg: "#ef4444", fg: "#450a0a" },
  msa: { bg: "#64748b", fg: "#f1f5f9" },
  audit: { bg: "#71717a", fg: "#fafafa" },
  memory_curator: { bg: "#0ea5e9", fg: "#082f49" },
  __team__: { bg: "#475569", fg: "#f8fafc" },
  __tools__: { bg: "#374151", fg: "#e5e7eb" },
  user: { bg: "#f1f5f9", fg: "#0f172a" },
};

/** 伪 role：runtime 用来表示一对多广播或工具调用聚合，前端 UI 需要特殊渲染。 */
export const TEAM_BROADCAST_ROLE = "__team__" as const;
export const TOOLS_PSEUDO_ROLE = "__tools__" as const;
const PSEUDO_ROLES: ReadonlySet<string> = new Set([TEAM_BROADCAST_ROLE, TOOLS_PSEUDO_ROLE]);
export function isPseudoRole(role: string | null | undefined): boolean {
  return role != null && PSEUDO_ROLES.has(role);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function avatarColorFor(role: string): { bg: string; fg: string } {
  const preset = PRESET_COLORS[role];
  if (preset) return preset;
  const h = hashString(role) % 360;
  const bg = `hsl(${h}, 60%, 48%)`;
  const fg = "#0b0f19";
  return { bg, fg };
}

export function avatarLabelFor(role: string): string {
  if (role === "user") return "你";
  if (KNOWN_ROLES.has(role)) {
    const key = `team.role.abbr.${role}`;
    const localized = t(key);
    if (localized && localized !== key) return localized;
  }
  const cleaned = role.replace(/[_\-]+/g, " ").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export function formatRoleName(role: string): string {
  if (role === "user") return "用户";
  if (KNOWN_ROLES.has(role)) {
    const key = `team.role.name.${role}`;
    const localized = t(key);
    if (localized && localized !== key) return localized;
  }
  return role;
}
