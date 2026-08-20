import { describe, expect, test } from "bun:test";
import { validateThemePack } from "./theme-registry";

const validPack = {
  format: "qubit-ui-theme",
  manifestVersion: 1,
  id: "aurora-terminal",
  name: "Aurora Terminal",
  version: "1.0.0",
  colorScheme: "dark",
  tokens: { "--qb-bg-root": "#08111a" },
  quantTokens: {
    "--qb-bg-surface": "#08111a",
    "--qb-text-strong": "#d8f3ef",
  },
  surfaces: {
    team: { background: "rgba(8, 26, 42, .64)", blurPx: 16, saturationPct: 125 },
    chart: { borderColor: "#245260", radius: "10px" },
  },
  css: 'html[data-qb-style="aurora-terminal"] [data-qb-quant-shell] { border-radius: 8px; }',
};

describe("theme pack contract", () => {
  test("accepts a scoped, declarative theme pack", () => {
    expect(validateThemePack(validPack).ok).toBe(true);
  });

  test("rejects builtin id collisions and unscoped CSS", () => {
    expect(validateThemePack({ ...validPack, id: "bauhaus" }).ok).toBe(false);
    expect(validateThemePack({ ...validPack, css: ".qb-quant-shell { color: red; }" }).ok).toBe(false);
    expect(validateThemePack({ ...validPack, css: 'html[data-qb-style="aurora-terminal"] { background: url(https://x); }' }).ok).toBe(false);
  });

  test("rejects unsafe or unknown surface recipes", () => {
    expect(validateThemePack({ ...validPack, surfaces: { unknown: {} } }).ok).toBe(false);
    expect(validateThemePack({ ...validPack, surfaces: { chart: { background: "red; color: black" } } }).ok).toBe(false);
    expect(validateThemePack({ ...validPack, surfaces: { team: { blurPx: 301 } } }).ok).toBe(false);
  });
});
