import type { AgentDefinitionBundle } from "../api/types";

/** 内置角色中文展示名（profile.displayName 为空时的回退） */
export const AGENT_ROLE_DISPLAY_ZH: Record<string, string> = {
  orchestrator: "编排器",
  market_data: "行情数据",
  news_event: "新闻事件",
  research: "策略研究",
  backtest: "回测",
  simulation: "模拟交易",
  risk: "风控",
  execution: "交易执行",
  memory: "记忆管理",
  audit: "审计",
  analyst_fundamental: "基本面研究员",
  analyst_technical: "量化策略师",
  analyst_sentiment: "舆情分析师",
  analyst_macro: "宏观策略师",
  risk_manager: "风控主管",
};

export function agentDisplayLabel(bundle: {
  definition: { role: string; name: string };
  profile?: { displayName?: string | null } | null;
}): string {
  const fromProfile = bundle.profile?.displayName?.trim();
  if (fromProfile) return fromProfile;
  const fromName = bundle.definition.name?.trim();
  if (fromName && !fromName.startsWith("自定义")) return fromName;
  return AGENT_ROLE_DISPLAY_ZH[bundle.definition.role] ?? bundle.definition.role;
}

export function agentSelectOptionLabel(bundle: AgentDefinitionBundle): string {
  const zh = agentDisplayLabel(bundle);
  const role = bundle.definition.role;
  const ver = bundle.definition.version;
  const disabled = bundle.definition.enabled === false ? "（已禁用）" : "";
  if (zh === role || zh === bundle.definition.name) {
    return `${role} · ${ver} — ${zh}${disabled}`;
  }
  return `${role} · ${ver} — ${zh}（${bundle.definition.name}）${disabled}`;
}
