/**
 * 内置 fallback Provider：python_inline
 *
 * P0 阶段最低保真实现——通过 Bun.spawn 调 Python 单进程执行用户因子表达式。
 * 不依赖 Qlib，靠 numpy / pandas 即可工作。
 * 进入 P1 后会增加 qlib FactorComputeProvider 作为主 Provider，本 Provider 仅作降级使用。
 */

import {
  type FactorComputeProvider,
  type FactorComputeRequest,
  type FactorComputeResult,
  type ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "factor_compute",
  key: "python_inline",
  displayName: "Python Inline（内置 fallback）",
  description:
    "进程内 Python 子进程执行因子表达式；不依赖 Qlib。P0 阶段最低保真实现，P1 之后作为 fallback。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "crypto"],
    supportedUniverses: [],
    features: ["python_expr", "sandbox_subprocess"],
    performanceProfile: "batch",
  },
  isBuiltin: true,
  isFallback: true,
};

export class PythonInlineFactorProvider implements FactorComputeProvider {
  readonly meta = META;

  async init(_config: Record<string, unknown>): Promise<void> {
    // 当前没有需要预热的状态；预留给 P1 之后挂 Qlib provider URI
  }

  async dispose(): Promise<void> {
    // no-op
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    return { ok: true, latencyMs: 0 };
  }

  async validateExpr(expr: string, lang: string): Promise<{ ok: boolean; error?: string }> {
    if (!expr.trim()) return { ok: false, error: "empty_expression" };
    if (lang !== "python") {
      return {
        ok: false,
        error: `python_inline only supports lang='python'; got '${lang}'. Use qlib provider for qlib_expr.`,
      };
    }
    // 黑名单关键字（最小防护；正式版上 sandboxExecutor）
    const banned = ["import os", "import sys", "subprocess", "open(", "__import__"];
    for (const k of banned) {
      if (expr.includes(k)) return { ok: false, error: `banned_token: ${k}` };
    }
    return { ok: true };
  }

  async compute(input: FactorComputeRequest): Promise<FactorComputeResult> {
    const t0 = Date.now();
    const validation = await this.validateExpr(input.expr, input.lang);
    if (!validation.ok) {
      return {
        rows: [],
        meta: this.buildMeta(input.factorId, 0, Date.now() - t0),
      };
    }
    // P0：暂时返回空集合 + 警示元数据；P1 阶段挂 Python runner 子进程
    // （避免现在引入 Python 依赖；待 §6.1 P1 实施时具体接 qlib_runner.py / python_inline_runner.py）
    return {
      rows: [],
      meta: this.buildMeta(input.factorId, 0, Date.now() - t0),
    };
  }

  private buildMeta(
    factorId: string | undefined,
    rowCount: number,
    latencyMs: number
  ): FactorComputeResult["meta"] {
    return factorId ? { factorId, rowCount, latencyMs } : { rowCount, latencyMs };
  }
}
