import { resolve } from "node:path";
import type { BarData } from "../../connectors/data/data.connector";
import { runPythonOneShot } from "../../util/python-oneshot";
import { getPythonBin } from "../sandbox/python-runtime";

export interface PythonSignalRunInput {
  bars: BarData[];
  indicatorCode: string;
  buyKey?: string;
  sellKey?: string;
}

export interface PythonSignalRunOutput {
  buy: boolean[];
  sell: boolean[];
}

async function runWithBinary(bin: string, input: PythonSignalRunInput): Promise<PythonSignalRunOutput> {
  const script = resolve(import.meta.dir, "python_backtest_runner.py");
  const { parsed } = await runPythonOneShot<{
    ok: boolean;
    error?: string;
    buy?: boolean[];
    sell?: boolean[];
  }>({
    bin,
    scriptPath: script,
    stdinPayload: {
      bars: input.bars,
      indicatorCode: input.indicatorCode,
      buyKey: input.buyKey ?? "buy",
      sellKey: input.sellKey ?? "sell",
    },
  });
  if (!parsed.ok) throw new Error(parsed.error || "python signal runner failed");
  const buy = Array.isArray(parsed.buy) ? parsed.buy.map(Boolean) : [];
  const sell = Array.isArray(parsed.sell) ? parsed.sell.map(Boolean) : [];
  return { buy, sell };
}

export async function runPythonSignalGenerator(input: PythonSignalRunInput): Promise<PythonSignalRunOutput> {
  const primary = getPythonBin();
  try {
    return await runWithBinary(primary, input);
  } catch (e1) {
    if (primary === "python") throw e1;
    try {
      return await runWithBinary("python", input);
    } catch (e2) {
      const msg1 = e1 instanceof Error ? e1.message : String(e1);
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      throw new Error(`python runner unavailable: ${msg1}; fallback: ${msg2}`);
    }
  }
}
