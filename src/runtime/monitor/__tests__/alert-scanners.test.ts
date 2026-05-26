/**
 * P2-3：alert-scanners 纯函数级回归测试。
 *
 * 覆盖 mcp_circuit_open / token_anomaly 两类扫描器的决策函数；
 * DB 扫描函数 (scanMcp* / scanToken*) 走集成验证，不在此 mock。
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateMcpCircuitOpenAlert,
  evaluateTokenAnomalyAlert,
} from "../alert-scanners";

describe("evaluateMcpCircuitOpenAlert", () => {
  const now = new Date("2026-05-26T08:00:00Z");

  test("circuitState != 'open' → 不告警", () => {
    const d = evaluateMcpCircuitOpenAlert(
      { circuitState: "closed", openedAt: "2026-05-26T07:00:00Z" },
      now,
      5
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.reason).toBe("not open");
  });

  test("circuitState = 'half_open' 也不告警（短暂探测态）", () => {
    const d = evaluateMcpCircuitOpenAlert(
      { circuitState: "half_open", openedAt: "2026-05-26T07:00:00Z" },
      now,
      5
    );
    expect(d.shouldAlert).toBe(false);
  });

  test("openedAt 缺失 → 不告警（数据不可信）", () => {
    const d = evaluateMcpCircuitOpenAlert(
      { circuitState: "open", openedAt: null },
      now,
      5
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.reason).toBe("openedAt missing");
  });

  test("open 但未到 stuckMinutes（短抖动）→ 不告警", () => {
    const d = evaluateMcpCircuitOpenAlert(
      { circuitState: "open", openedAt: "2026-05-26T07:57:00Z" }, // 3 分钟前
      now,
      5
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.stuckMs).toBe(3 * 60_000);
  });

  test("open 且 ≥ stuckMinutes → 告警", () => {
    const d = evaluateMcpCircuitOpenAlert(
      { circuitState: "open", openedAt: "2026-05-26T07:30:00Z" }, // 30 分钟前
      now,
      5
    );
    expect(d.shouldAlert).toBe(true);
    expect(d.stuckMs).toBe(30 * 60_000);
    expect(d.reason).toContain("30 minutes");
  });

  test("openedAt 不可 parse → 不告警", () => {
    const d = evaluateMcpCircuitOpenAlert(
      { circuitState: "open", openedAt: "not a date" },
      now,
      5
    );
    expect(d.shouldAlert).toBe(false);
    expect(d.reason).toBe("openedAt unparsable");
  });
});

describe("evaluateTokenAnomalyAlert", () => {
  test("baseline < min → 不告警（基线不稳定）", () => {
    const d = evaluateTokenAnomalyAlert(10_000, 500, 2, 1000);
    expect(d.shouldAlert).toBe(false);
    expect(d.reason).toContain("baseline 500");
  });

  test("ratio < threshold → 不告警", () => {
    const d = evaluateTokenAnomalyAlert(5000, 4000, 2, 1000);
    expect(d.shouldAlert).toBe(false);
    expect(d.ratio).toBeCloseTo(1.25, 2);
  });

  test("ratio ≥ threshold → 告警", () => {
    const d = evaluateTokenAnomalyAlert(20_000, 5000, 2, 1000);
    expect(d.shouldAlert).toBe(true);
    expect(d.ratio).toBe(4);
  });

  test("baseline = baselineMinTokens 边界：刚好达标 → 可触发", () => {
    const d = evaluateTokenAnomalyAlert(3000, 1000, 2, 1000);
    expect(d.shouldAlert).toBe(true);
    expect(d.ratio).toBe(3);
  });

  test("ratio 恰等于 threshold → 触发（≥ 而非 >）", () => {
    const d = evaluateTokenAnomalyAlert(2000, 1000, 2, 1000);
    expect(d.shouldAlert).toBe(true);
    expect(d.ratio).toBe(2);
  });

  test("current = 0 → ratio = 0，不告警", () => {
    const d = evaluateTokenAnomalyAlert(0, 5000, 2, 1000);
    expect(d.shouldAlert).toBe(false);
    expect(d.ratio).toBe(0);
  });
});
