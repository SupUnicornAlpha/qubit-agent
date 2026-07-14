/**
 * Bull/Bear 辩论触发判定（`decideShouldDebate`）的回归测试。
 *
 * 背景：原先实现只看 `fusedConfidence < confidenceThreshold` 就触发辩论，
 * 导致策略专岗编组（无 MSA 分析师，signalBreakdown 为空）每次空跑辩论。
 * 现在改造为三段优先级：硬守门 → Orchestrator 显式表态 → 置信度阈值兜底。
 *
 * 这个测试锁定三段优先级的边界条件，防止后续重构倒退。
 */
import { describe, expect, test } from "bun:test";
import { decideShouldDebate, type OrchestratorDecision } from "../analyst-team-pipeline";

const baseOrch: OrchestratorDecision = {
  signal: "hold",
  confidence: 0.5,
  reasoning: "test",
  proceedToStrategy: false,
};

describe("decideShouldDebate", () => {
  test("硬守门：全部 HOLD 时不允许生成伪多空结论", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.1,
      signalBreakdownCount: 4,
      directionalSignalCount: 0,
      orchestratorDecision: { ...baseOrch, shouldDebate: true },
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(false);
    expect(r.source).toBe("hard_guard");
    expect(r.reason).toContain("全部分析师为 HOLD");
  });

  test("硬守门：0 个分析师产出 → 不辩论", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.2, // 低于阈值
      signalBreakdownCount: 0,
      orchestratorDecision: { ...baseOrch, shouldDebate: true }, // 即使 orch 要求辩
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(false);
    expect(r.source).toBe("hard_guard");
    expect(r.reason).toContain("signal_breakdown<2");
  });

  test("硬守门：1 个分析师产出 → 不辩论（bull/bear 无对手）", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.2,
      signalBreakdownCount: 1,
      orchestratorDecision: null,
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(false);
    expect(r.source).toBe("hard_guard");
  });

  test("Orchestrator 强制 false：即使置信度低也不辩", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.2,
      signalBreakdownCount: 4,
      orchestratorDecision: {
        ...baseOrch,
        shouldDebate: false,
        debateReason: "策略专岗编组：无对立视角",
      },
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(false);
    expect(r.source).toBe("orchestrator");
    expect(r.reason).toContain("策略专岗编组");
  });

  test("Orchestrator 强制 true：即使置信度高也辩", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.9, // 远高于阈值
      signalBreakdownCount: 4,
      orchestratorDecision: {
        ...baseOrch,
        shouldDebate: true,
        debateReason: "bull/bear 阵营在 horizon 上有显著分歧",
      },
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(true);
    expect(r.source).toBe("orchestrator");
    expect(r.reason).toContain("horizon");
  });

  test("Orchestrator shouldDebate=null（明确无意见）→ 走阈值兜底", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.4,
      signalBreakdownCount: 4,
      orchestratorDecision: { ...baseOrch, shouldDebate: null },
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(true); // 0.4 < 0.55
    expect(r.source).toBe("confidence_threshold");
  });

  test("Orchestrator 字段缺失 → 走阈值兜底", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.7, // > 阈值
      signalBreakdownCount: 4,
      orchestratorDecision: { ...baseOrch }, // 没 shouldDebate 字段
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(false);
    expect(r.source).toBe("confidence_threshold");
  });

  test("orchestratorDecision=null + 阈值兜底（低于阈值）", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.3,
      signalBreakdownCount: 4,
      orchestratorDecision: null,
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(true);
    expect(r.source).toBe("confidence_threshold");
    expect(r.reason).toContain("30%");
    expect(r.reason).toContain("55%");
  });

  test("orchestratorDecision=null + 阈值兜底（高于阈值）", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.8,
      signalBreakdownCount: 4,
      orchestratorDecision: null,
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(false);
    expect(r.source).toBe("confidence_threshold");
  });

  test("边界：signalBreakdownCount=2 是硬守门的最小通过值", () => {
    const r = decideShouldDebate({
      fusedConfidence: 0.3,
      signalBreakdownCount: 2,
      orchestratorDecision: null,
      confidenceThreshold: 0.55,
    });
    expect(r.shouldDebate).toBe(true);
    expect(r.source).toBe("confidence_threshold");
  });
});
