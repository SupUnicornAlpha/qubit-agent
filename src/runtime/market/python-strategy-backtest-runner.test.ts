/**
 * 端到端 smoke：把一段简单 SMA 双均线策略喂给 python_strategy_backtest_runner.py，
 * 跑过预生成的正弦+漂移 bars，检查 equityCurve 长度、metrics 各字段有限、至少触发一笔交易。
 *
 * 若运行环境没有 python3/python，则跳过（与 packaged 环境一致）。
 */
import { describe, expect, test } from "bun:test";
import type { BarData } from "../../connectors/data/data.connector";
import { runPythonStrategyBacktest } from "./python-strategy-backtest-runner";

function fakeBars(n: number): BarData[] {
  const out: BarData[] = [];
  let price = 100;
  const t0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    price += Math.sin(i * 0.18) * 0.6 + (i > n / 2 ? 0.15 : -0.05);
    const o = price;
    const c = price + 0.05;
    out.push({
      symbol: "TEST",
      exchange: "X",
      open: o,
      high: Math.max(o, c) + 0.1,
      low: Math.min(o, c) - 0.1,
      close: c,
      volume: 1e6,
      turnover: 0,
      timestamp: new Date(t0 + i * 86_400_000).toISOString(),
    });
  }
  return out;
}

async function pythonAvailable(): Promise<boolean> {
  for (const bin of ["python3", "python"]) {
    try {
      const proc = Bun.spawn([bin, "-c", "print('ok')"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code === 0 && out.includes("ok")) return true;
    } catch {
      // try next
    }
  }
  return false;
}

describe("runPythonStrategyBacktest", () => {
  test("executes user on_init/on_bar end-to-end against fake bars", async () => {
    if (!(await pythonAvailable())) {
      console.warn("[python-strategy-backtest-runner.test] no python interpreter, skipped");
      return;
    }
    const bars = fakeBars(120);
    const strategyCode = `
CLOSES = []
def on_init(ctx):
    ctx.state["was_above"] = False

def on_bar(ctx, bar):
    CLOSES.append(float(bar["close"]))
    if len(CLOSES) < 20:
        return
    fast = ctx.sma(CLOSES, 5)
    slow = ctx.sma(CLOSES, 20)
    is_above = fast > slow
    if is_above and not ctx.state["was_above"] and ctx.position == 0:
        ctx.buy(qty=1.0)
    elif (not is_above) and ctx.state["was_above"] and ctx.position > 0:
        ctx.close()
    ctx.state["was_above"] = is_above
`;

    const res = await runPythonStrategyBacktest({
      strategyCode,
      bars,
      initialCapital: 10_000,
      commission: 0.001,
    });

    expect(res.equityCurve.length).toBe(bars.length);
    expect(res.metrics.bars).toBe(bars.length);
    expect(Number.isFinite(res.metrics.totalReturnPct)).toBe(true);
    expect(Number.isFinite(res.metrics.maxDrawdownPct)).toBe(true);
    expect(Number.isFinite(res.metrics.sharpeApprox)).toBe(true);
    expect(res.metrics.tradeCount).toBeGreaterThan(0);
    // 至少应该出现一笔 buy 和一笔 sell（合成数据故意构造了两段趋势）
    const sides = new Set(res.trades.map((t) => t.side));
    expect(sides.has("buy")).toBe(true);
  });

  test("returns helpful error when strategyCode is missing on_bar", async () => {
    if (!(await pythonAvailable())) return;
    const bars = fakeBars(30);
    let captured: string | null = null;
    try {
      await runPythonStrategyBacktest({
        strategyCode: "x = 1",
        bars,
        initialCapital: 1000,
        commission: 0,
      });
    } catch (e) {
      captured = e instanceof Error ? e.message : String(e);
    }
    expect(captured).not.toBeNull();
    expect(captured!).toContain("on_bar");
  });
});
