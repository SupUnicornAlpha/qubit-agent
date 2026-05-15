import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BarData } from "../../connectors/data/data.connector";

export interface SignalEvaluationResult {
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

export async function evaluateScriptOnBar(
  strategyCode: string,
  bars: BarData[]
): Promise<SignalEvaluationResult> {
  if (!bars.length) {
    return { buy: false, sell: false, barTime: null, error: "no_bars" };
  }

  const proc = Bun.spawn(["python3", SCRIPT_RUNNER_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(
    JSON.stringify({
      strategyCode,
      bars: bars.map(barToPayload),
    })
  );
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      buy: false,
      sell: false,
      barTime: bars[bars.length - 1]?.time ?? null,
      error: stderr.trim() || `python_exit_${exitCode}`,
    };
  }

  try {
    const out = JSON.parse(stdout) as {
      ok?: boolean;
      buy?: boolean;
      sell?: boolean;
      barTime?: string;
      error?: string;
    };
    if (!out.ok) {
      return {
        buy: false,
        sell: false,
        barTime: bars[bars.length - 1]?.time ?? null,
        error: out.error ?? "script_eval_failed",
      };
    }
    return {
      buy: Boolean(out.buy),
      sell: Boolean(out.sell),
      barTime: out.barTime ?? bars[bars.length - 1]?.time ?? null,
    };
  } catch (e) {
    return {
      buy: false,
      sell: false,
      barTime: bars[bars.length - 1]?.time ?? null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function evaluateSignalCode(
  signalCode: string,
  bars: BarData[],
  mode: "indicator" | "script" = "indicator"
): Promise<SignalEvaluationResult> {
  if (mode === "script") {
    return evaluateScriptOnBar(signalCode, bars);
  }
  if (!bars.length) {
    return { buy: false, sell: false, barTime: null, error: "no_bars" };
  }

  const proc = Bun.spawn(["python3", RUNNER_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const payload = {
    bars: bars.map(barToPayload),
    indicatorCode: signalCode,
    buyKey: "buy",
    sellKey: "sell",
  };

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      buy: false,
      sell: false,
      barTime: bars[bars.length - 1]?.time ?? null,
      error: stderr.trim() || `python_exit_${exitCode}`,
    };
  }

  try {
    const out = JSON.parse(stdout) as {
      ok?: boolean;
      buy?: boolean[];
      sell?: boolean[];
      error?: string;
    };
    if (!out.ok) {
      return {
        buy: false,
        sell: false,
        barTime: bars[bars.length - 1]?.time ?? null,
        error: out.error ?? "signal_eval_failed",
      };
    }
    const buyArr = out.buy ?? [];
    const sellArr = out.sell ?? [];
    const lastIdx = bars.length - 1;
    return {
      buy: Boolean(buyArr[lastIdx]),
      sell: Boolean(sellArr[lastIdx]),
      barTime: bars[lastIdx]?.time ?? null,
    };
  } catch (e) {
    return {
      buy: false,
      sell: false,
      barTime: bars[bars.length - 1]?.time ?? null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
