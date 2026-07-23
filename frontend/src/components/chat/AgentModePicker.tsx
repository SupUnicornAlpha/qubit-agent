import type { CSSProperties, FC } from "react";
import type { AgentControlMode } from "../../api/types";

export const AGENT_MODE_OPTIONS: ReadonlyArray<{
  id: AgentControlMode;
  label: string;
  icon: string;
  hint: string;
}> = [
  { id: "agent", label: "Agent", icon: "✦", hint: "直接回答或按需调用工具、分析师团队" },
  { id: "plan", label: "Plan", icon: "≡", hint: "只生成可验证计划，不执行研究工具或外部写入" },
  { id: "goal", label: "Goal", icon: "◆", hint: "自主规划、执行并验证，直到目标闭环" },
];

export function getAgentModeOption(mode: AgentControlMode) {
  return AGENT_MODE_OPTIONS.find((option) => option.id === mode) ?? AGENT_MODE_OPTIONS[0]!;
}

export const AgentModePicker: FC<{
  value: AgentControlMode;
  onChange: (mode: AgentControlMode) => void;
  disabled?: boolean;
  variant?: "workbench" | "simple";
  ariaLabel?: string;
}> = ({
  value,
  onChange,
  disabled = false,
  variant = "workbench",
  ariaLabel = "下一条消息的工作模式",
}) => {
  const selected = getAgentModeOption(value);
  const simple = variant === "simple";
  return (
    <label
      data-qb-agent-mode-picker
      style={{
        ...styles.root,
        ...(simple ? styles.simple : styles.workbench),
        ...(disabled ? styles.disabled : null),
      }}
      title={`下一条消息使用 ${selected.label} 模式：${selected.hint}`}
    >
      <span style={{ ...styles.mark, color: simple ? "var(--qs-accent)" : "#60a5fa" }} aria-hidden>
        {selected.icon}
      </span>
      <select
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as AgentControlMode)}
        style={styles.select}
      >
        {AGENT_MODE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <span style={styles.chevron} aria-hidden>
        ▾
      </span>
    </label>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 28,
    padding: "0 7px",
    border: "1px solid",
    borderRadius: 7,
    cursor: "pointer",
    boxSizing: "border-box",
  },
  workbench: {
    borderColor: "#3f3f46",
    background: "rgba(255,255,255,0.035)",
    color: "#d4d4d8",
  },
  simple: {
    borderColor: "var(--qs-border, #d8d8d2)",
    background: "var(--qs-surface-soft, #f7f7f5)",
    color: "var(--qs-text, #242424)",
  },
  disabled: { opacity: 0.55, cursor: "not-allowed" },
  mark: { fontSize: 11, lineHeight: 1 },
  select: {
    appearance: "none",
    WebkitAppearance: "none",
    border: 0,
    outline: 0,
    padding: 0,
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 11,
    fontWeight: 600,
    cursor: "inherit",
  },
  chevron: { color: "#71717a", fontSize: 9, lineHeight: 1 },
};
