/**
 * Phase B (2026-06) capability-driven slot 分桶 helper 单测。
 *
 * 锁定 P0-01 / P1-04 修复行为：
 *   - news_event (outputs=['events','report']) 不再被 isMsAnalystRole 过滤掉
 *     → 走 aux pipeline；
 *   - backtest_engineer (outputs=['backtest_results','report']) 同理；
 *   - analyst_* (outputs=['signal','report']) 仍然进 MSA wave；
 *   - 空 outputs（旧 def / 第三方）回退到老 role-name 判断保持兼容。
 *
 * dispatcher 不再直接调用 isMsAnalystRole / POST_FUSION_AUX_ROLES.has；
 * 所有桶化决策都经过这两个 helper。
 *
 * 注：本测试导入 analyst-team.ts 会触发 db client 初始化，必须先把
 * QUBIT_DATA_DIR 指到 tmpdir 避免 migration 写到生产 sqlite（已被运行中的
 * 后端 lock）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-slot-bucketize-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

import type { AgentOutput } from "../../types";
import type { AgentRole } from "../../../types/entities";

const { describe, expect, test } = await import("bun:test");
const { slotProducesSignal, slotIsAuxReporter } = await import("../analyst-team");

function slot(role: AgentRole, outputs: readonly AgentOutput[]) {
  return { role, outputs };
}

describe("slotProducesSignal — capability-driven MSA 入桶判断", () => {
  test("analyst_* 显式声明 'signal' → true", () => {
    expect(slotProducesSignal(slot("analyst_fundamental", ["signal", "report"]))).toBe(true);
    expect(slotProducesSignal(slot("analyst_technical", ["signal", "report"]))).toBe(true);
    expect(slotProducesSignal(slot("analyst_sentiment", ["signal", "report"]))).toBe(true);
    expect(slotProducesSignal(slot("analyst_macro", ["signal", "report"]))).toBe(true);
  });

  test("news_event (events+report) → false（修复前会被 isMsAnalystRole 过滤后误丢，现在走 aux）", () => {
    expect(slotProducesSignal(slot("news_event", ["events", "report"]))).toBe(false);
  });

  test("research (report+factor_candidates+strategy_dsl) → false", () => {
    expect(
      slotProducesSignal(slot("research", ["report", "factor_candidates", "strategy_dsl"]))
    ).toBe(false);
  });

  test("backtest_engineer (backtest_results+report) → false", () => {
    expect(slotProducesSignal(slot("backtest_engineer", ["backtest_results", "report"]))).toBe(
      false
    );
  });

  test("空 outputs 回退到 isMsAnalystRole（兼容路径）", () => {
    expect(slotProducesSignal(slot("analyst_fundamental", []))).toBe(true);
    expect(slotProducesSignal(slot("analyst_macro", []))).toBe(true);
    expect(slotProducesSignal(slot("research", []))).toBe(false);
    expect(slotProducesSignal(slot("news_event", []))).toBe(false);
  });
});

describe("slotIsAuxReporter — 取代 POST_FUSION_AUX_ROLES.has", () => {
  test("产任意非 signal 产物的 slot 都走 aux pipeline", () => {
    expect(slotIsAuxReporter(slot("news_event", ["events", "report"]))).toBe(true);
    expect(slotIsAuxReporter(slot("research", ["report", "factor_candidates"]))).toBe(true);
    expect(slotIsAuxReporter(slot("backtest", ["backtest_results", "report"]))).toBe(true);
    expect(slotIsAuxReporter(slot("backtest_engineer", ["backtest_results", "report"]))).toBe(
      true
    );
    expect(slotIsAuxReporter(slot("risk", ["risk_assessment", "report"]))).toBe(true);
    expect(slotIsAuxReporter(slot("market_data", ["report"]))).toBe(true);
  });

  test("产 signal 的 slot 不进 aux（避免重复执行）", () => {
    expect(slotIsAuxReporter(slot("analyst_fundamental", ["signal", "report"]))).toBe(false);
    expect(slotIsAuxReporter(slot("analyst_sentiment", ["signal", "report"]))).toBe(false);
  });

  test("空 outputs 回退到 POST_FUSION_AUX_ROLES = {research, backtest, risk}", () => {
    expect(slotIsAuxReporter(slot("research", []))).toBe(true);
    expect(slotIsAuxReporter(slot("backtest", []))).toBe(true);
    expect(slotIsAuxReporter(slot("risk", []))).toBe(true);
    expect(slotIsAuxReporter(slot("news_event", []))).toBe(false);
    expect(slotIsAuxReporter(slot("analyst_fundamental", []))).toBe(false);
  });

  test("无任何产出的 slot 不进 aux（dispatcher 会跳过）", () => {
    expect(slotIsAuxReporter(slot("orchestrator", []))).toBe(false);
  });
});

describe("互斥性：signal 与 aux 不重叠", () => {
  const cases: Array<{ role: AgentRole; outputs: readonly AgentOutput[] }> = [
    { role: "analyst_fundamental", outputs: ["signal", "report"] },
    { role: "news_event", outputs: ["events", "report"] },
    { role: "research", outputs: ["report", "factor_candidates"] },
    { role: "backtest", outputs: ["backtest_results", "report"] },
    { role: "backtest_engineer", outputs: ["backtest_results", "report"] },
    { role: "risk", outputs: ["risk_assessment", "report"] },
    { role: "market_data", outputs: ["report"] },
  ];

  for (const c of cases) {
    test(`${c.role} (${c.outputs.join("+")}) 只在一个桶`, () => {
      const inSignal = slotProducesSignal(c);
      const inAux = slotIsAuxReporter(c);
      expect(inSignal && inAux).toBe(false);
      expect(inSignal || inAux).toBe(true);
    });
  }
});

describe("P0-01 / P1-04 修复直接验证（模拟 case 4 / case 5 编组桶化）", () => {
  test("case 5 grp-news-event-radar — news_event 进 aux, analyst_sentiment 进 signal", () => {
    const slots = [
      slot("news_event", ["events", "report"]),
      slot("analyst_sentiment", ["signal", "report"]),
    ];
    const analystSlots = slots.filter(slotProducesSignal);
    const auxSlots = slots.filter(slotIsAuxReporter);
    expect(analystSlots.map((s) => s.role)).toEqual(["analyst_sentiment"]);
    expect(auxSlots.map((s) => s.role)).toEqual(["news_event"]);
    // 这两个 slot 都要被执行——修复前 news_event 因 RESEARCH_TEAM_SLOT_SET / isMsAnalystRole 双重过滤被丢
  });

  test("case 4 grp-discovery — research+backtest+backtest_engineer 全进 aux（strategyPipelineMode）", () => {
    const slots = [
      slot("research", ["report", "factor_candidates", "strategy_dsl"]),
      slot("backtest", ["backtest_results", "report"]),
      slot("backtest_engineer", ["backtest_results", "report"]),
    ];
    const analystSlots = slots.filter(slotProducesSignal);
    const auxSlots = slots.filter(slotIsAuxReporter);
    expect(analystSlots).toEqual([]);
    expect(auxSlots.map((s) => s.role)).toEqual(["research", "backtest", "backtest_engineer"]);
    // 修复前 backtest_engineer 直接被 RESEARCH_TEAM_SLOT_SET 干掉
  });

  test("case 3 grp-postmortem — analyst_macro 进 signal, research 进 aux", () => {
    const slots = [
      slot("research", ["report", "factor_candidates", "strategy_dsl"]),
      slot("analyst_macro", ["signal", "report"]),
    ];
    expect(slots.filter(slotProducesSignal).map((s) => s.role)).toEqual(["analyst_macro"]);
    expect(slots.filter(slotIsAuxReporter).map((s) => s.role)).toEqual(["research"]);
  });

  test("case 1/2 grp-full-analyst-team — 4 analyst_* 全进 signal, 其余进 aux", () => {
    const slots = [
      slot("market_data", ["report"]),
      slot("news_event", ["events", "report"]),
      slot("analyst_fundamental", ["signal", "report"]),
      slot("analyst_technical", ["signal", "report"]),
      slot("analyst_sentiment", ["signal", "report"]),
      slot("analyst_macro", ["signal", "report"]),
      slot("research", ["report", "factor_candidates", "strategy_dsl"]),
      slot("backtest", ["backtest_results", "report"]),
      slot("risk", ["risk_assessment", "report"]),
    ];
    const analystSlots = slots.filter(slotProducesSignal).map((s) => s.role);
    const auxSlots = slots.filter(slotIsAuxReporter).map((s) => s.role);
    expect(analystSlots).toEqual([
      "analyst_fundamental",
      "analyst_technical",
      "analyst_sentiment",
      "analyst_macro",
    ]);
    // 现在 aux 桶比 MSA 时代更"完整"——多了 market_data + news_event，
    // 它们也会通过 post-fusion 串行 pipeline 跑（之前默默被丢，token 浪费 + 数据缺失）。
    expect(auxSlots).toEqual([
      "market_data",
      "news_event",
      "research",
      "backtest",
      "risk",
    ]);
  });
});
