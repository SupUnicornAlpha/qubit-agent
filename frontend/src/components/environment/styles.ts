/**
 * EnvironmentManager 组件共享 styles —— 沿用 PythonRuntimeCard 的视觉语言：
 * qb-* CSS 变量 / 三色 dot / 表格 + qb-btn-ghost / qb-btn--compact。
 */
import type { CSSProperties } from "react";

export const STATUS_COLOR = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
  gray: "#71717a",
} as const;

export const card: CSSProperties = {
  border: "1px solid var(--qb-main-input-border, #3f3f46)",
  borderRadius: 8,
  padding: 12,
  background: "var(--qb-main-input-bg, #18181b)",
  marginBottom: 14,
};

export const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginBottom: 6,
  fontSize: 12,
};

export const code: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  padding: "2px 6px",
  borderRadius: 4,
  background: "rgba(255,255,255,0.04)",
};

export const tableHeaderRow: CSSProperties = {
  textAlign: "left",
  color: "var(--qb-main-meta)",
};

export const tableTh: CSSProperties = { padding: "4px 6px", fontWeight: 500 };
export const tableTd: CSSProperties = { padding: "4px 6px" };
export const tableTrBordered: CSSProperties = { borderTop: "1px solid #27272a" };
export const baseTable: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 12,
};

export function statusDot(severity: keyof typeof STATUS_COLOR): CSSProperties {
  return {
    display: "inline-block",
    width: 10,
    height: 10,
    borderRadius: "50%",
    backgroundColor: STATUS_COLOR[severity],
    flexShrink: 0,
  };
}
