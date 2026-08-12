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
});
