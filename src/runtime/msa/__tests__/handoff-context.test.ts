/**
 * P0-2 回归测试：runPostFusionPipeline 的 handoff context 拼接。
 *
 * 背景：workflow d0a41743 复盘发现 backtest / risk 跑的时候完全看不到 research
 * 已经写的策略草案 —— 每个 aux slot 只拿到同一份 fusion 报告，互相重复劳动。
 * 现在通过 `formatHandoffSections` 把上游 body 注入下游 context 串起来。
 *
 * 这个测试锁定输出格式 + 截断 + 空数组短路。
 */
import { describe, expect, test } from "bun:test";
import { formatHandoffSections } from "../analyst-team-pipeline";

describe("formatHandoffSections", () => {
  test("空数组 → 返回空字符串（首个 slot 无 handoff）", () => {
    expect(formatHandoffSections([])).toBe("");
  });

  test("单角色 body 输出标准段落头 + role 区块", () => {
    const out = formatHandoffSections([
      { role: "research", body: "我推荐 NVDA 做多，动量因子 IC=0.05。" },
    ]);
    expect(out).toContain("## 上游角色已产出");
    expect(out).toContain("### 来自 research");
    expect(out).toContain("NVDA");
    expect(out).toContain("**重要**");
    expect(out).toContain("不要重新选标的");
  });

  test("多角色按 push 顺序拼接（保持执行顺序）", () => {
    const out = formatHandoffSections([
      { role: "research", body: "推荐 NVDA + LMT。" },
      { role: "backtest", body: "Sharpe=1.8, MaxDD=-12%。" },
    ]);
    const idxResearch = out.indexOf("### 来自 research");
    const idxBacktest = out.indexOf("### 来自 backtest");
    expect(idxResearch).toBeGreaterThan(-1);
    expect(idxBacktest).toBeGreaterThan(idxResearch);
    expect(out).toContain("NVDA");
    expect(out).toContain("Sharpe");
  });

  test("超长 body 截断到 4000 字 + 提示已截断", () => {
    const huge = "x".repeat(5000);
    const out = formatHandoffSections([{ role: "research", body: huge }]);
    expect(out).toContain("为节省 token 已截断");
    /** body 本身只保留 4000 字 */
    const bodyMatch = out.match(/### 来自 research\n\n(x+)/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1]!.length).toBe(4000);
  });

  test("空 body 也保留区块（不静默丢失）", () => {
    const out = formatHandoffSections([{ role: "research", body: "   " }]);
    expect(out).toContain("### 来自 research");
  });
});
