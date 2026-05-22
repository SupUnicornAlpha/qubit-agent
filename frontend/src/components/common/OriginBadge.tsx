/**
 * 统一的"来源徽标"小组件 —— MCP / Skills / 其它装载式资源都可复用。
 *
 * 设计目标：
 *   - 用户在多个面板（MCP 服务白名单 / Skills 已安装列表 / MCP 市场卡片）能
 *     一眼看出某一项是"项目自带"、"从市场装的"还是"我手动配的"。
 *   - 颜色弱化，不抢卡片主体的视觉权重，但 hover 时给出明确解释。
 *
 * 三档颜色映射故意低对比度：
 *   builtin → 蓝灰    （平台中性）
 *   market  → 琥珀色  （第三方来源，可能有风险）
 *   manual  → 紫灰    （用户自定义，需自负责）
 */
import type { CSSProperties, FC } from "react";

export type ResourceOrigin =
  | "builtin"
  | "market"
  | "manual"
  | "skillsmp"
  | "open-skill-market"
  | "agent_created"
  | "evolved"
  | "user_authored"
  | "open_skill_market";

const PRESETS: Record<ResourceOrigin, { label: string; color: string; bg: string; tip: string }> = {
  builtin: {
    label: "内置",
    color: "#93c5fd",
    bg: "rgba(59,130,246,0.12)",
    tip: "项目自带，随安装包分发；可禁用但不可删除",
  },
  market: {
    label: "市场",
    color: "#fbbf24",
    bg: "rgba(251,191,36,0.12)",
    tip: "从 MCP/Skills 市场安装，可在市场页卸载",
  },
  manual: {
    label: "手动",
    color: "#c4b5fd",
    bg: "rgba(167,139,250,0.12)",
    tip: "通过\"快速添加\"手填的配置，自行维护",
  },
  skillsmp: {
    label: "SkillsMP",
    color: "#fbbf24",
    bg: "rgba(251,191,36,0.12)",
    tip: "从 SkillsMP 市场安装",
  },
  "open-skill-market": {
    label: "Open Skill Market",
    color: "#fbbf24",
    bg: "rgba(251,191,36,0.12)",
    tip: "从 Open Skill Market 安装",
  },
  /** `agent_skill.source` 直接映射的四档：归纳 / 演化 / 用户手写 / 市场镜像。 */
  agent_created: {
    label: "本地归纳",
    color: "#6ee7b7",
    bg: "rgba(16,185,129,0.12)",
    tip: "Agent 在完成复杂任务后由 curator 归纳出的 skill（类 Hermes 程序性记忆）",
  },
  evolved: {
    label: "演化",
    color: "#fda4af",
    bg: "rgba(244,63,94,0.12)",
    tip: "GEPA-lite evolver 在 baseline 之上突变得到的新版本，待审批后转 active",
  },
  user_authored: {
    label: "手写",
    color: "#c4b5fd",
    bg: "rgba(167,139,250,0.12)",
    tip: "用户在配置中心手动新增的 skill",
  },
  open_skill_market: {
    label: "市场镜像",
    color: "#fbbf24",
    bg: "rgba(251,191,36,0.12)",
    tip: "从 Open Skill Market / SkillsMP 安装后镜像到 agent_skill 表，便于统一检索",
  },
};

export interface OriginBadgeProps {
  origin: ResourceOrigin | string | undefined | null;
  /** 默认 'inline-flex'，加 marginLeft；可被覆盖 */
  style?: CSSProperties;
  /** 覆盖显示文案（保留预设颜色） */
  label?: string;
  /** 覆盖 hover 提示 */
  tip?: string;
}

export const OriginBadge: FC<OriginBadgeProps> = ({ origin, style, label, tip }) => {
  if (!origin) return null;
  const preset = (PRESETS as Record<string, (typeof PRESETS)[ResourceOrigin] | undefined>)[origin];
  if (!preset) return null;
  return (
    <span
      title={tip ?? preset.tip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        marginLeft: 6,
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 10,
        lineHeight: "14px",
        fontWeight: 600,
        letterSpacing: 0.3,
        color: preset.color,
        backgroundColor: preset.bg,
        border: `1px solid ${preset.color}33`,
        ...style,
      }}
    >
      {label ?? preset.label}
    </span>
  );
};
