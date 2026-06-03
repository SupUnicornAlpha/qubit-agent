/**
 * P5 SkillPromoter — scoring 纯函数边界单测。
 * 不需要 sqlite，毫秒级。
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_SCORING_CONFIG, scoreCandidate } from "../scoring";
import type { PromoterCandidate } from "../types";

function cand(over: Partial<PromoterCandidate> = {}): PromoterCandidate {
  return {
    kind: "procedural",
    experienceId: "exp_1",
    signature: "a>b>c",
    title: "auto-play(analyst): a → b → c",
    description: "...",
    bodyMd: "...",
    definitionId: "def_1",
    useCount: 5,
    successCount: 4,
    failCount: 1,
    qualityScore: 0.6,
    pnlSignal: 0.5,
    ...over,
  };
}

describe("scoreCandidate — gate 通过", () => {
  test("默认配置 + 合格候选 → qualified=true, 0 < score <= 1", () => {
    const r = scoreCandidate(cand());
    expect(r.qualified).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.skipReason).toBeUndefined();
    // 4 个 gate + 4 个 score 共 8 条 ruleHits
    expect(r.ruleHits.length).toBe(8);
    expect(r.ruleHits.every((h) => h.rule.startsWith("gate_") || h.rule.startsWith("score_"))).toBe(
      true
    );
  });

  test("useCount 极大 → recallNorm 趋近 1，但被 clamp 在 score <=1", () => {
    const r = scoreCandidate(cand({ useCount: 1_000_000, qualityScore: 1, successCount: 100, failCount: 0 }));
    expect(r.qualified).toBe(true);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThan(0.9);
  });
});

describe("scoreCandidate — gate 不通过", () => {
  test("useCount 不够 → low_recall", () => {
    const r = scoreCandidate(cand({ useCount: 1 }));
    expect(r.qualified).toBe(false);
    expect(r.skipReason).toBe("low_recall");
    expect(r.score).toBe(0);
  });

  test("executed 不够 → insufficient_data", () => {
    const r = scoreCandidate(cand({ useCount: 10, successCount: 1, failCount: 0 }));
    expect(r.qualified).toBe(false);
    expect(r.skipReason).toBe("insufficient_data");
  });

  test("成功率不够 → low_success_rate", () => {
    const r = scoreCandidate(cand({ useCount: 10, successCount: 2, failCount: 8 }));
    expect(r.qualified).toBe(false);
    expect(r.skipReason).toBe("low_success_rate");
  });

  test("qualityScore 不够 → low_quality", () => {
    const r = scoreCandidate(cand({ qualityScore: 0.3 }));
    expect(r.qualified).toBe(false);
    expect(r.skipReason).toBe("low_quality");
  });
});

describe("scoreCandidate — 权重与 clamp", () => {
  test("自定义阈值放宽 → 同一候选可通过", () => {
    const cfg = { ...DEFAULT_SCORING_CONFIG, minRecall: 1, minExec: 1, minSuccessRate: 0.2, minQuality: 0.1 };
    const r = scoreCandidate(cand({ useCount: 1, successCount: 1, failCount: 0, qualityScore: 0.2 }), cfg);
    expect(r.qualified).toBe(true);
  });

  test("非 finite 输入 → 被 clamp 成 0，但不崩", () => {
    const r = scoreCandidate(cand({ useCount: Number.POSITIVE_INFINITY, qualityScore: Number.NaN }));
    // qualityScore NaN → clamp 0 → gate_quality 不过
    expect(r.qualified).toBe(false);
  });

  test("ruleHits.contribution 总和约等于 score（误差 < 1e-9）", () => {
    const r = scoreCandidate(cand());
    if (!r.qualified) throw new Error("expected qualified");
    const total = r.ruleHits.reduce((a, h) => a + h.contribution, 0);
    expect(Math.abs(total - r.score)).toBeLessThan(1e-9);
  });
});
