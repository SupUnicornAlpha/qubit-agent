/**
 * 与 `ide-theme.css` 中 `.qa-*` 规则配套（表单控件）；按钮请优先使用全局 `qb-btn-*` / `qb-chip` 以保持 IDE 一致外观。
 */
export const qc = {
  input: "qa-input",
  inputSm: "qa-input qa-input--sm",
  select: "qa-select",
  textarea: "qa-textarea",
  btnPrimary: "qa-btn qa-btn--primary",
  btnSecondary: "qa-btn qa-btn--secondary",
  btnGhost: "qa-btn qa-btn--ghost",
  chip: "qa-chip",
  chipActive: "qa-chip qa-chip--active",
  chipCompact: "qa-chip qa-chip--compact",
  chipPctOn: "qa-chip qa-chip--compact qa-chip--pct-on",
  range: "qa-range",
  segment: "qa-segment",
  segmentOn: "qa-segment qa-segment--on",
  btnLong: "qa-btn--long",
  btnShort: "qa-btn--short",
  btnAccent: "qa-btn--accent",
} as const;
