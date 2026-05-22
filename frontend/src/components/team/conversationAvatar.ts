/**
 * Agent 头像配色 / 缩写工具。
 *
 * 设计要点：
 * - 颜色对每个 role 是稳定确定的（基于 hash），新 role 加进来不需要改 mapping。
 * - 已知 role 直接命中预设色，让常用角色有更"品牌化"的辨识度。
 * - 缩写：优先用中文短名（基本面/技术面/...），否则取拉丁字符首字母。
 */

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
};

const ROLE_LABEL: Record<string, string> = {
  orchestrator: "总编",
  research: "研究",
  analyst_fundamental: "基本",
  analyst_technical: "技术",
  analyst_sentiment: "情绪",
  analyst_macro: "宏观",
  analyst: "分析",
  backtest: "回测",
  risk: "风控",
  risk_monitor: "风控",
  msa: "融合",
  audit: "审计",
  memory_curator: "记忆",
  market_data: "行情",
  news_event: "新闻",
  execution: "执行",
  simulation: "仿真",
  memory: "记忆",
};

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
  const cn = ROLE_LABEL[role];
  if (cn) return cn;
  const cleaned = role.replace(/[_\-]+/g, " ").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export function formatRoleName(role: string): string {
  return ROLE_LABEL[role] ?? role;
}
