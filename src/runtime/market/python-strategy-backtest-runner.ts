/**
 * Spawn 子进程跑 `python_strategy_backtest_runner.py`：
 * 把 OHLCV bars + 用户 Python 策略一并传入，由 Python 端 bar-by-bar 调 `on_bar`、
 * 自带撮合（按 close、限制可用现金、按 commission 扣费），回传 equity 曲线 + trades + metrics。
 *
 * - 与 `runSmaCrossoverBacktest` 字段对齐（equityCurve / metrics.totalReturnPct 等），
 *   方便前端复用现有汇总语句。
 * - Python 解释器优先级：getPythonBin() → "python" 兜底。
 *   getPythonBin 会按 QUBIT_PYTHON env → 资源 venv → 数据目录 venv → 系统 python3 解析，
 *   保证与 bootstrap 创建的 venv 一致，避免落到没装 pandas 的系统 python。
 */
import { resolve } from "node:path";
import type { BarData } from "../../connectors/data/data.connector";
import { getPythonBin } from "../sandbox/python-runtime";

export interface StrategyBacktestInput {
  strategyCode: string;
  bars: BarData[];
  initialCapital: number;
  commission: number;
}

export interface StrategyBacktestResult {
  equityCurve: Array<{ time: string; equity: number }>;
  trades: Array<{ time: string; side: "buy" | "sell"; qty: number; price: number; fee: number }>;
  metrics: {
    totalReturnPct: number;
    maxDrawdownPct: number;
    sharpeApprox: number;
    tradeCount: number;
    bars: number;
    lastPosition?: number;
  };
  stderrText?: string;
}

interface RawOk {
  ok: true;
  equityCurve: Array<{ time: string; equity: number }>;
  trades: Array<{ time: string; side: string; qty: number; price: number; fee: number }>;
  metrics: StrategyBacktestResult["metrics"];
  stderrText?: string;
}

interface RawErr {
  ok: false;
  error: string;
  stderrText?: string;
}

async function runWithBinary(bin: string, input: StrategyBacktestInput): Promise<StrategyBacktestResult> {
  const script = resolve(import.meta.dir, "python_strategy_backtest_runner.py");
  const proc = Bun.spawn([bin, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(
    JSON.stringify({
      strategyCode: input.strategyCode,
      bars: input.bars,
      initialCapital: input.initialCapital,
      commission: input.commission,
    })
  );
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !stdout) {
    throw new Error(`python exited ${code}: ${stderr || "(no output)"}`);
  }

  let parsed: RawOk | RawErr;
  try {
    parsed = JSON.parse(stdout) as RawOk | RawErr;
  } catch (e) {
    throw new Error(
      `python output not JSON (exit=${code}): ${stderr || stdout.slice(0, 400)}`
    );
  }

  if (!parsed.ok) {
    const extra = parsed.stderrText ? `\nstdout/print:\n${parsed.stderrText}` : "";
    throw new Error(`${parsed.error}${extra}`);
  }

  const trades = parsed.trades.map((t) => ({
    time: t.time,
    side: t.side === "buy" ? ("buy" as const) : ("sell" as const),
    qty: Number(t.qty) || 0,
    price: Number(t.price) || 0,
    fee: Number(t.fee) || 0,
  }));

  return {
    equityCurve: parsed.equityCurve,
    trades,
    metrics: parsed.metrics,
    stderrText: parsed.stderrText,
  };
}

export async function runPythonStrategyBacktest(
  input: StrategyBacktestInput
): Promise<StrategyBacktestResult> {
  const primary = getPythonBin();
  try {
    return await runWithBinary(primary, input);
  } catch (e1) {
    /*
     * primary 已经覆盖了 venv → 系统 python3，再退一档到 "python"
     * 仅用于 Windows / 某些极简镜像（python3 不存在但 python 是 3.x）的兜底。
     */
    if (primary === "python") {
      throw e1;
    }
    try {
      return await runWithBinary("python", input);
    } catch (e2) {
      const m1 = e1 instanceof Error ? e1.message : String(e1);
      const m2 = e2 instanceof Error ? e2.message : String(e2);
      throw new Error(`python strategy runner unavailable: ${m1}; fallback: ${m2}`);
    }
  }
}
