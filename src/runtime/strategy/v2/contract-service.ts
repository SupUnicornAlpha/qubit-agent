/**
 * Strategy Contract V2 — TS bridge to `strategy_contract_runner.py` (Prime 06).
 */
import { resolve } from "node:path";
import type { BarData } from "../../../connectors/data/data.connector";
import { PythonOneShotError, runPythonOneShot } from "../../../util/python-oneshot";
import { getPythonBin } from "../../sandbox/python-runtime";

export type StrategyManifestV2 = {
  apiVersion: number;
  codeHash: string;
  strategyType: "cta" | "portfolio" | string;
  universe: {
    kind: string;
    instruments: Array<{
      market: string;
      symbol: string;
      instrumentId: string;
    }>;
  };
  subscriptions: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  benchmark: { market: string; symbol: string; instrumentId: string } | null;
  handlers: string[];
  warmupBars: number;
  primaryFrequency: string;
  paramsSchema: Array<{
    name: string;
    type: string;
    default: unknown;
    description?: string;
    range?: string | null;
  }>;
  metadata: Record<string, unknown>;
  maxLeverage?: number;
  leverageAllowed?: boolean;
};

export type ContractCompileResult =
  | { ok: true; manifest: StrategyManifestV2 }
  | { ok: false; error: string };

export type ContractBacktestResult =
  | {
      ok: true;
      manifest: StrategyManifestV2;
      equityCurve: Array<{ time: string; equity: number }>;
      trades: Array<Record<string, unknown>>;
      intents: Array<Record<string, unknown>>;
      metrics: {
        totalReturnPct: number;
        maxDrawdownPct: number;
        sharpeApprox: number;
        tradeCount: number;
        bars: number;
        lastPosition?: number | null;
      };
      primarySymbol: string;
    }
  | { ok: false; error: string };

async function runContract<T extends { ok: boolean }>(
  payload: Record<string, unknown>
): Promise<T> {
  const bin = await getPythonBin();
  const scriptPath = resolve(import.meta.dir, "strategy_contract_runner.py");
  try {
    const { parsed } = await runPythonOneShot<T>({
      bin,
      scriptPath,
      stdinPayload: payload,
      timeoutMs: 120_000,
    });
    return parsed;
  } catch (err) {
    if (err instanceof PythonOneShotError && err.stdout) {
      try {
        return JSON.parse(err.stdout) as T;
      } catch {
        /* fall through */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message } as T;
  }
}

export async function compileStrategyContract(
  strategyCode: string
): Promise<ContractCompileResult> {
  return runContract<ContractCompileResult>({
    action: "compile",
    strategyCode,
  });
}

export async function backtestStrategyContract(input: {
  strategyCode: string;
  bars: BarData[];
  params?: Record<string, unknown>;
  initialCapital?: number;
  commission?: number;
  symbol?: string;
}): Promise<ContractBacktestResult> {
  return runContract<ContractBacktestResult>({
    action: "backtest",
    strategyCode: input.strategyCode,
    bars: input.bars,
    ...(input.params ? { params: input.params } : {}),
    initialCapital: input.initialCapital ?? 100_000,
    commission: input.commission ?? 0.001,
    ...(input.symbol ? { symbol: input.symbol } : {}),
  });
}

/** Strip market prefix for klines adapters: `US:SPY` → `SPY`, `CN:600519.SH` → `600519.SH`. */
export function instrumentIdToKlinesSymbol(instrumentId: string): string {
  const id = instrumentId.trim();
  const idx = id.indexOf(":");
  if (idx <= 0) return id;
  return id.slice(idx + 1).trim() || id;
}

export function primaryInstrumentId(manifest: StrategyManifestV2): string {
  const inst = manifest.universe?.instruments?.[0];
  return (inst?.instrumentId || inst?.symbol || "").trim();
}
