import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BarData } from "../../connectors/data/data.connector";
import { PythonOneShotError, runPythonOneShot } from "../../util/python-oneshot";
import { getPythonBin } from "../sandbox/python-runtime";

/**
 * P2-F 命名空间化：`Signal*` 系列名字泛化，区分三个域：
 *   - AnalystSignal*       （多 Agent 投研结论 buy/sell/hold + confidence）
 *   - BacktestSignalSpec*  （回测策略表达式规则）
 *   - IndicatorSignal*     （技术指标/Python 因子的 boolean buy/sell 序列）
 *
 * 本接口属于 indicator/script 评估结果（一根 bar 的最新 buy/sell 布尔）。
 *
 * 注意：此处 `buy/sell` 是布尔值（指标触发与否），不是 AnalystSignalValue("buy"|"sell"|"hold")。
 */
export interface IndicatorSignalEvaluationResult {
  buy: boolean;
  sell: boolean;
  barTime: string | null;
  error?: string;
}

const RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../market/python_backtest_runner.py"
);

function barToPayload(b: BarData): Record<string, unknown> {
  return {
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  };
}

const SCRIPT_RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../market/python_strategy_script_runtime.py"
);

/**
 * @deprecated 旧名字，保留作 type alias 让外部 import { SignalEvaluationResult } 不立刻断裂。
 * 新代码请用 `IndicatorSignalEvaluationResult`。
 */
export type SignalEvaluationResult = IndicatorSignalEvaluationResult;

export async function evaluateScriptOnBar(
  strategyCode: string,
  bars: BarData[]
): Promise<IndicatorSignalEvaluationResult> {
  if (!bars.length) {
    return { buy: false, sell: false, barTime: null, error: "no_bars" };
  }

  const lastTime = bars[bars.length - 1]?.time ?? null;
  let out: {
    ok?: boolean;
    buy?: boolean;
    sell?: boolean;
    barTime?: string;
    error?: string;
  };
  try {
    const r = await runPythonOneShot<typeof out>({
      bin: getPythonBin(),
      scriptPath: SCRIPT_RUNNER_PATH,
      stdinPayload: {
        strategyCode,
        bars: bars.map(barToPayload),
      },
    });
    out = r.parsed;
  } catch (err) {
    if (err instanceof PythonOneShotError) {
      const errMsg =
        err.source === "exit"
          ? err.stderr.trim() || `python_exit_${err.exitCode}`
          : err.message;
      return { buy: false, sell: false, barTime: lastTime, error: errMsg };
    }
    return {
      buy: false,
      sell: false,
      barTime: lastTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!out.ok) {
    return {
      buy: false,
      sell: false,
      barTime: lastTime,
      error: out.error ?? "script_eval_failed",
    };
  }
  return {
    buy: Boolean(out.buy),
    sell: Boolean(out.sell),
    barTime: out.barTime ?? lastTime,
  };
}

export async function evaluateSignalCode(
  signalCode: string,
  bars: BarData[],
  mode: "indicator" | "script" = "indicator"
): Promise<IndicatorSignalEvaluationResult> {
  if (mode === "script") {
    return evaluateScriptOnBar(signalCode, bars);
  }
  if (!bars.length) {
    return { buy: false, sell: false, barTime: null, error: "no_bars" };
  }

  const lastIdx = bars.length - 1;
  const lastTime = bars[lastIdx]?.time ?? null;
  let out: {
    ok?: boolean;
    buy?: boolean[];
    sell?: boolean[];
    error?: string;
  };
  try {
    const r = await runPythonOneShot<typeof out>({
      bin: getPythonBin(),
      scriptPath: RUNNER_PATH,
      stdinPayload: {
        bars: bars.map(barToPayload),
        indicatorCode: signalCode,
        buyKey: "buy",
        sellKey: "sell",
      },
    });
    out = r.parsed;
  } catch (err) {
    if (err instanceof PythonOneShotError) {
      const errMsg =
        err.source === "exit"
          ? err.stderr.trim() || `python_exit_${err.exitCode}`
          : err.message;
      return { buy: false, sell: false, barTime: lastTime, error: errMsg };
    }
    return {
      buy: false,
      sell: false,
      barTime: lastTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!out.ok) {
    return {
      buy: false,
      sell: false,
      barTime: lastTime,
      error: out.error ?? "signal_eval_failed",
    };
  }
  const buyArr = out.buy ?? [];
  const sellArr = out.sell ?? [];
  return {
    buy: Boolean(buyArr[lastIdx]),
    sell: Boolean(sellArr[lastIdx]),
    barTime: lastTime,
  };
}
