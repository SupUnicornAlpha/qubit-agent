import { describe, expect, test } from "bun:test";
import { classifyBenchmarkHealth } from "./health-panel";

describe("benchmark health thresholds", () => {
  test("marks repeated timeouts unhealthy even when the sample is small", () => {
    expect(classifyBenchmarkHealth({ calls: 3, failures: 2, timeouts: 2 })).toBe("unhealthy");
  });

  test("keeps unused and low-sample failures distinct", () => {
    expect(classifyBenchmarkHealth({ calls: 0, failures: 0, timeouts: 0 })).toBe("unused");
    expect(classifyBenchmarkHealth({ calls: 2, failures: 1, timeouts: 0 })).toBe("sample_low");
  });
});
