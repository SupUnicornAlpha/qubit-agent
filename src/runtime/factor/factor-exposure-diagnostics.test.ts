import { describe, expect, test } from "bun:test";
import { diagnoseFactorExposure } from "./factor-exposure-diagnostics";

const rows = (values: number[]) =>
  values.map((value, index) => ({
    symbol: `S${index % 3}`,
    date: `2026-01-${String(Math.floor(index / 3) + 1).padStart(2, "0")}`,
    value,
  }));

describe("factor exposure diagnostics", () => {
  test("flags a factor that is almost fully explained by its frozen controls", () => {
    const first = Array.from({ length: 60 }, (_, index) => index + 1);
    const second = first.map((value, index) => value * 2 + (index % 2 ? 0.01 : -0.01));
    const independent = first.map((_, index) => ((index * 17) % 31) - 15);
    const result = diagnoseFactorExposure({
      factorValues: {
        f1: rows(first),
        f2: rows(second),
        f3: rows(independent),
      },
      maximumVif: 5,
      minimumObservations: 60,
    });
    expect(result.status).toBe("failed");
    expect(result.highVifFactorIds).toContain("f1");
    expect(result.rows.find((row) => row.factorId === "f1")?.rSquared).toBeGreaterThan(0.99);
  });

  test("does not invent an exposure estimate when frozen observations do not overlap", () => {
    const result = diagnoseFactorExposure({
      factorValues: {
        f1: [{ symbol: "A", date: "2026-01-01", value: 1 }],
        f2: [{ symbol: "B", date: "2026-01-01", value: 2 }],
      },
      minimumObservations: 2,
    });
    expect(result.status).toBe("incomplete");
    expect(result.rows[0]).toMatchObject({ observations: 0, status: "insufficient_overlap" });
  });
});
