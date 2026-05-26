/**
 * QlibPythonFactorProvider — 通过 Python 子进程跑因子计算
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1
 *
 * 与 QlibExprFactorProvider 的关系：
 *   - QlibExprFactorProvider：纯 TS 实现，priority=60，覆盖常用算子集，零依赖
 *   - QlibPythonFactorProvider：spawn python3 子进程，priority=40（fallback），
 *     可选接入完整 qlib 包 + Alpha158/360 全量算子
 *
 * 协议（与 python_connectors/qlib_compute_runner.py 对应）：
 *   stdin  ← {"expr": "...", "bars": [...]}
 *   stdout → {"ok": true, "rows": [{symbol, date, value}], "meta": {...}}
 *
 * 失败降级策略：
 *   - python3 不可用 / 脚本异常 → 返回 emptyResult，不抛错（让上层选择 fallback）
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryBarsRange } from "../../../market/klines-query";
import { getPythonBin } from "../../../sandbox/python-runtime";
import type { BarData } from "../../../../connectors/data/data.connector";
import {
  PythonOneShotError,
  runPythonOneShot,
  runPythonOneShotRaw,
} from "../../../../util/python-oneshot";
import {
  type FactorComputeProvider,
  type FactorComputeRequest,
  type FactorComputeResult,
  type FactorComputeRow,
  type ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "factor_compute",
  key: "qlib_python",
  displayName: "Qlib（Python 桥）",
  description:
    "通过 python3 子进程评估 qlib 风格表达式；环境装了 qlib 时可走完整 Alpha158/360。无 Python 时优雅降级返回空。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "crypto"],
    features: [
      "qlib_expression",
      "alpha158_alias",
      "python_subprocess",
      "pandas_fallback",
    ],
    performanceProfile: "neartime",
  },
  isBuiltin: true,
  isFallback: true,
};

const RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../python_connectors/qlib_compute_runner.py"
);

interface RawBar {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PythonResponse {
  ok: boolean;
  rows?: Array<{ symbol: string; date: string; value: number }>;
  meta?: { backend: string; rowCount: number };
  error?: string;
  trace?: string;
}

export class QlibPythonFactorProvider implements FactorComputeProvider {
  readonly meta = META;

  private resolveExchange(symbol: string, override?: string): string {
    if (override !== undefined) return override;
    if (/^[0-9]{6}$/.test(symbol)) return "";
    return "";
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    // 启动一个 --version 来快速 ping；走统一的 getPythonBin 以匹配 venv
    try {
      await runPythonOneShotRaw({
        bin: getPythonBin(),
        scriptPath: "--version",
        timeoutMs: 5_000,
      });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async validateExpr(expr: string, lang: string): Promise<{ ok: boolean; error?: string }> {
    if (lang !== "qlib_expr") {
      return {
        ok: false,
        error: `qlib_python Provider expects lang='qlib_expr', got '${lang}'`,
      };
    }
    if (!expr.trim()) return { ok: false, error: "empty_expression" };
    // 仅做语法 ping（不真正取数）；交给 Python 端识别 alias / 函数
    // 这里复用 TS 端 parser 做基本语法校验，alpha158:xxx 这种走 alias 时跳过
    if (expr.trim().toUpperCase().startsWith("ALPHA")) return { ok: true };
    try {
      const { parse } = await import("./qlib-expr/parser");
      // qlib 风格的 $close 在 TS lexer 中不识别，strip 后再校验
      parse(expr.replace(/\$/g, ""));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async compute(input: FactorComputeRequest): Promise<FactorComputeResult> {
    const t0 = Date.now();
    if (input.lang !== "qlib_expr") {
      return this.emptyResult(input, t0);
    }

    const symbols = (input.symbols ?? []).filter((s) => s && s.trim().length > 0);
    if (symbols.length === 0) {
      return this.emptyResult(input, t0);
    }

    // 1) 拉数据
    const allBars: RawBar[] = [];
    for (const symbol of symbols) {
      let bars: BarData[];
      try {
        bars = await queryBarsRange({
          symbol,
          exchange: this.resolveExchange(symbol),
          period: "1d",
          startDate: input.startDate,
          endDate: input.endDate,
        });
      } catch {
        continue;
      }
      if (!bars || bars.length === 0) continue;
      for (const b of bars) {
        allBars.push({
          symbol,
          date: b.timestamp.slice(0, 10),
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        });
      }
    }
    if (allBars.length === 0) {
      return this.emptyResult(input, t0);
    }

    // 2) spawn python3
    let resp: PythonResponse;
    try {
      resp = await this.runPython({ expr: input.expr, bars: allBars });
    } catch (e) {
      return this.emptyResult(input, t0, (e as Error).message);
    }
    if (!resp.ok || !resp.rows) {
      return this.emptyResult(input, t0, resp.error);
    }

    const rows: FactorComputeRow[] = resp.rows.map((r) => ({
      symbol: r.symbol,
      date: r.date,
      value: Number.isFinite(r.value) ? r.value : null,
    }));

    return {
      rows,
      meta: input.factorId
        ? { factorId: input.factorId, rowCount: rows.length, latencyMs: Date.now() - t0 }
        : { rowCount: rows.length, latencyMs: Date.now() - t0 },
    };
  }

  private async runPython(payload: {
    expr: string;
    bars: RawBar[];
  }): Promise<PythonResponse> {
    try {
      const { parsed } = await runPythonOneShot<PythonResponse>({
        bin: getPythonBin(),
        scriptPath: RUNNER_PATH,
        stdinPayload: payload,
      });
      return parsed;
    } catch (e) {
      if (e instanceof PythonOneShotError) {
        if (e.source === "exit") {
          return { ok: false, error: e.stderr.trim() || `python_exit_${e.exitCode}` };
        }
        if (e.source === "parse") {
          return { ok: false, error: `parse_response_failed: ${e.message}` };
        }
        return { ok: false, error: e.message };
      }
      return { ok: false, error: `parse_response_failed: ${(e as Error).message}` };
    }
  }

  private emptyResult(
    input: FactorComputeRequest,
    t0: number,
    _err?: string
  ): FactorComputeResult {
    return {
      rows: [],
      meta: input.factorId
        ? { factorId: input.factorId, rowCount: 0, latencyMs: Date.now() - t0 }
        : { rowCount: 0, latencyMs: Date.now() - t0 },
    };
  }
}
