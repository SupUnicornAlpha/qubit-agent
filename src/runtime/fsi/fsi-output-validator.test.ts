import { describe, expect, test } from "bun:test";
import { validateFsiRoleOutput } from "./fsi-output-validator";

describe("validateFsiRoleOutput", () => {
  test("sanitizes analyst_sentiment overflow and enum", async () => {
    const r = await validateFsiRoleOutput("analyst_sentiment", {
      signal: "buy",
      confidence: 1.5,
      sentiment_score: 0.2,
      reasoning: "x".repeat(5000),
      catalysts: Array.from({ length: 20 }, (_, i) => `c${i}`),
    });
    expect(r.sanitized.confidence).toBe(1);
    expect((r.sanitized.catalysts as string[]).length).toBeLessThanOrEqual(10);
    expect((r.sanitized.reasoning as string).length).toBeLessThanOrEqual(4000);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test("passes minimal valid fundamental payload", async () => {
    const r = await validateFsiRoleOutput("analyst_fundamental", {
      signal: "hold",
      confidence: 0.5,
      reasoning: "ok",
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
