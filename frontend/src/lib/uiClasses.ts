/**
 * 与 `ide-theme.css` 中 `.qa-*` 规则配套，用于表单与按钮的统一外观（对齐暗色 IDE + 品牌紫点缀）。
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
