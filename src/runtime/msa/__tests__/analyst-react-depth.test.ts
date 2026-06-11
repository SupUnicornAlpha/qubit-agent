/**
 * W5（2026-06-10）：MSA wave 加 ReAct 多轮档位 — 单元测试
 *
 * 覆盖：
 *   1. pickAnalystReactDepth 按 pipelineKind 映射档位
 *   2. ANALYST_REACT_ITERATIONS 表的数值合理性
 *   3. expectJsonSignal=false（aux pipeline）固定 deep
 */

import { describe, expect, test } from "bun:test";
import {
  ANALYST_REACT_ITERATIONS,
  pickAnalystReactDepth,
} from "../analyst-team-slot-react";

describe("pickAnalystReactDepth (W5)", () => {
  test("msa_fusion + JSON signal → standard（鼓励交叉验证）", () => {
    expect(
      pickAnalystReactDepth({ pipelineKind: "msa_fusion", expectJsonSignal: true })
    ).toBe("standard");
  });

  test("sequential_research + JSON signal → deep（策略链路本来就长）", () => {
    expect(
      pickAnalystReactDepth({ pipelineKind: "sequential_research", expectJsonSignal: true })
    ).toBe("deep");
  });

  test("event_radar + JSON → minimal（事件聚焦不需要太多轮）", () => {
    expect(
      pickAnalystReactDepth({ pipelineKind: "event_radar", expectJsonSignal: true })
    ).toBe("minimal");
  });

  test("factor_discovery + JSON → minimal", () => {
    expect(
      pickAnalystReactDepth({ pipelineKind: "factor_discovery", expectJsonSignal: true })
    ).toBe("minimal");
  });

  test("无 pipelineKind → 默认 standard", () => {
    expect(pickAnalystReactDepth({ expectJsonSignal: true })).toBe("standard");
    expect(
      pickAnalystReactDepth({ pipelineKind: null, expectJsonSignal: true })
    ).toBe("standard");
  });

  test("Aux pipeline (expectJsonSignal=false) 一律 deep（research/backtest/risk 工具链长）", () => {
    expect(
      pickAnalystReactDepth({ pipelineKind: "msa_fusion", expectJsonSignal: false })
    ).toBe("deep");
    expect(
      pickAnalystReactDepth({ pipelineKind: "sequential_research", expectJsonSignal: false })
    ).toBe("deep");
    expect(
      pickAnalystReactDepth({ pipelineKind: "event_radar", expectJsonSignal: false })
    ).toBe("deep");
  });
});

describe("ANALYST_REACT_ITERATIONS (W5 数值约束)", () => {
  test("minimal < standard < deep（单调递增）", () => {
    expect(ANALYST_REACT_ITERATIONS.minimal).toBeLessThan(
      ANALYST_REACT_ITERATIONS.standard
    );
    expect(ANALYST_REACT_ITERATIONS.standard).toBeLessThan(
      ANALYST_REACT_ITERATIONS.deep
    );
  });

  test("minimal ≥ 3（单数据源 confidence 上限暗示至少 1 工具 + 1 验证 + 1 final）", () => {
    expect(ANALYST_REACT_ITERATIONS.minimal).toBeGreaterThanOrEqual(3);
  });

  test("deep ≤ 8（不能超过 TEAM_SLOT_MAX_ITERATIONS）", () => {
    expect(ANALYST_REACT_ITERATIONS.deep).toBeLessThanOrEqual(8);
  });
});
