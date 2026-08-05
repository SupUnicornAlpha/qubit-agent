import { describe, expect, test } from "bun:test";
import {
  estimateJsonSizeLabel,
  formatLargeJsonPreview,
} from "./formatLargeJsonPreview";

describe("formatLargeJsonPreview", () => {
  test("small object is not truncated", () => {
    const r = formatLargeJsonPreview({ ok: true, n: 1 });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain('"ok": true');
  });

  test("long arrays are shrunk with omitted marker", () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({ i, v: i * 2 }));
    const r = formatLargeJsonPreview(arr, { maxArrayItems: 5, maxChars: 50_000, maxLines: 500 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('"omitted"');
    expect(r.text).toContain('"total": 200');
  });

  test("hard char/line caps apply", () => {
    const text = "x".repeat(10_000);
    const r = formatLargeJsonPreview(text, { maxChars: 100, maxLines: 5 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(200);
  });

  test("estimateJsonSizeLabel", () => {
    expect(estimateJsonSizeLabel({ a: 1 })).toMatch(/B$/);
  });
});
