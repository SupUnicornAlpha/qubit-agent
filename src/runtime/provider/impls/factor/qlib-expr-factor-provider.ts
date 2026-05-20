/**
 * QlibExprFactorProvider — 纯 TS 实现的 Qlib-like 表达式因子计算 Provider
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1
 *
 * 工作流：
 *   1. 接收 FactorComputeRequest（含 expr/symbols/区间）
 *   2. 走 qubit-data connector 拉每个 symbol 的 OHLCV 序列
 *   3. 用 ExprEngine 求值 → FactorComputeRow[]
 *
 * 与 python_inline 的关系：
 *   - python_inline 是最低保真 fallback（lang='python'），暂返回空
 *   - qlib_expr 是 lang='qlib_expr' 时的主 Provider，priority 默认 60（高于 fallback 的 10）
 *
 * 不依赖任何 Python / Qlib 包；启动即可用。
 */

import { queryBarsRange } from "../../../market/klines-query";
import type { BarData } from "../../../../connectors/data/data.connector";
import {
  type FactorComputeProvider,
  type FactorComputeRequest,
  type FactorComputeResult,
  type FactorComputeRow,
  type ProviderMeta,
} from "../../types";
import { ExprEvalError, evalExpr, type PriceSeries } from "./qlib-expr/evaluator";
import { ExprParseError, parse, type Ast } from "./qlib-expr/parser";
import { ExprLexError } from "./qlib-expr/lexer";

const META: ProviderMeta = {
  kind: "factor_compute",
  key: "qlib_expr",
  displayName: "Qlib 风格表达式（内置纯 TS）",
  description:
    "支持 Ref/Mean/Std/Sum/Min/Max/Rank/Corr/Slope/Delta/Sign/Abs/Log/EMA/IfPos；通过 qubit-data 拉日线计算。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "crypto"],
    features: [
      "qlib_expression",
      "rolling_ops",
      "cross_section_via_iteration",
      "no_python_dependency",
    ],
    performanceProfile: "neartime",
  },
  isBuiltin: true,
  isFallback: false,
};

const AST_CACHE = new Map<string, Ast>();

export class QlibExprFactorProvider implements FactorComputeProvider {
  readonly meta = META;
  /** symbol → exchange 解析（默认 CN-A → '' 自动路由；可由 params.exchange override） */
  private resolveExchange(symbol: string, override?: string): string {
    if (override !== undefined) return override;
    if (/^[0-9]{6}$/.test(symbol)) {
      // 简单 A 股代码 → 让 connector 内部路由
      return "";
    }
    return "";
  }

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async validateExpr(expr: string, lang: string): Promise<{ ok: boolean; error?: string }> {
    if (lang !== "qlib_expr") {
      return {
        ok: false,
        error: `qlib_expr Provider expects lang='qlib_expr', got '${lang}'`,
      };
    }
    if (!expr.trim()) return { ok: false, error: "empty_expression" };
    try {
      parse(expr);
      return { ok: true };
    } catch (e) {
      if (e instanceof ExprLexError || e instanceof ExprParseError) {
        return { ok: false, error: e.message };
      }
      return { ok: false, error: (e as Error).message };
    }
  }

  async compute(input: FactorComputeRequest): Promise<FactorComputeResult> {
    const t0 = Date.now();
    if (input.lang !== "qlib_expr") {
      return this.emptyResult(input, t0);
    }

    // Parse + cache AST
    let ast = AST_CACHE.get(input.expr);
    if (!ast) {
      try {
        ast = parse(input.expr);
        AST_CACHE.set(input.expr, ast);
      } catch (e) {
        return this.emptyResult(input, t0, (e as Error).message);
      }
    }

    const symbols = (input.symbols ?? []).filter((s) => s && s.trim().length > 0);
    if (symbols.length === 0) {
      return this.emptyResult(input, t0, "symbols_required");
    }

    const rows: FactorComputeRow[] = [];

    // 串行拉取 → 简单稳健（避免多源 connector 并发竞争）
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
        continue; // 单 symbol 失败不影响整体
      }
      if (!bars || bars.length === 0) continue;

      const series: PriceSeries = {
        length: bars.length,
        fields: {
          open: bars.map((b) => b.open),
          high: bars.map((b) => b.high),
          low: bars.map((b) => b.low),
          close: bars.map((b) => b.close),
          volume: bars.map((b) => b.volume),
          turnover: bars.map((b) => b.turnover),
          // 算子内 vwap = turnover / volume （安全降级 close）
          vwap: bars.map((b) => (b.volume > 0 ? b.turnover / b.volume : b.close)),
        },
      };

      let factorSeries: Array<number | null>;
      try {
        factorSeries = evalExpr(ast, series);
      } catch (e) {
        if (e instanceof ExprEvalError) continue;
        throw e;
      }

      for (let i = 0; i < bars.length; i++) {
        const date = bars[i]!.timestamp.slice(0, 10);
        const value = factorSeries[i];
        rows.push({
          symbol,
          date,
          value: typeof value === "number" && Number.isFinite(value) ? value : null,
        });
      }
    }

    return {
      rows,
      meta: input.factorId
        ? { factorId: input.factorId, rowCount: rows.length, latencyMs: Date.now() - t0 }
        : { rowCount: rows.length, latencyMs: Date.now() - t0 },
    };
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
