import { resolve } from "node:path";
import type { BarData } from "../../connectors/data/data.connector";

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
  const proc = Bun.spawn([bin, script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(
    JSON.stringify({
      bars: input.bars,
      indicatorCode: input.indicatorCode,
      buyKey: input.buyKey ?? "buy",
      sellKey: input.sellKey ?? "sell",
    })
  );
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`python exited ${code}: ${stderr || stdout}`);
  const parsed = JSON.parse(stdout) as {
    ok: boolean;
    error?: string;
    buy?: boolean[];
    sell?: boolean[];
  };
  if (!parsed.ok) throw new Error(parsed.error || "python signal runner failed");
  const buy = Array.isArray(parsed.buy) ? parsed.buy.map(Boolean) : [];
  const sell = Array.isArray(parsed.sell) ? parsed.sell.map(Boolean) : [];
  return { buy, sell };
}

export async function runPythonSignalGenerator(input: PythonSignalRunInput): Promise<PythonSignalRunOutput> {
  try {
    return await runWithBinary("python3", input);
  } catch (e1) {
    try {
      return await runWithBinary("python", input);
    } catch (e2) {
      const msg1 = e1 instanceof Error ? e1.message : String(e1);
      const msg2 = e2 instanceof Error ? e2.message : String(e2);
      throw new Error(`python runner unavailable: ${msg1}; fallback: ${msg2}`);
    }
  }
}
