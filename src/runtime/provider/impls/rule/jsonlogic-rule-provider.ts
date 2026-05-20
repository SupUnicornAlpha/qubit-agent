/**
 * 内置 fallback：JsonLogicRuleProvider
 *
 * 实现轻量 JSONLogic 子集：
 *   逻辑：and / or / not / if
 *   比较：==, !=, <, <=, >, >=
 *   数学：+, -, *, /, abs
 *   聚合：weighted_sum、min、max、sum
 *   因子访问：{"factor": "mom_20"}
 *   上下文访问：{"var": "industry"}
 *   集合：{"in": [needle, haystack]}
 *
 * 规则形态（appliesTo='score' 示例）：
 *   {
 *     "when":  { "and": [ {"<": [{"factor":"pe_ttm"},30]}, {">": [{"factor":"mom_20"},0.05]} ] },
 *     "score": { "weighted_sum": [ {"factor":"mom_20","w":0.5}, {"factor":"quality","w":0.5} ] },
 *     "order": { "top_n": 30, "weight": "rank_ic_weighted" }
 *   }
 */

import {
  type ProviderMeta,
  type RuleEngineProvider,
  type RuleEvalContext,
  type RuleEvalResult,
  type RuleEvalSymbolOutcome,
  type RuleSpec,
} from "../../types";

const META: ProviderMeta = {
  kind: "rule_engine",
  key: "jsonlogic",
  displayName: "JSONLogic Rule Engine（内置）",
  description: "轻量 JSONLogic 子集；因子/上下文原语；适合 Agent 读写。",
  version: "0.1.0",
  capability: {
    features: ["jsonlogic_subset", "factor_aware", "score", "filter"],
    performanceProfile: "realtime",
  },
  isBuiltin: true,
  isFallback: true,
};

type Json = unknown;

interface EvalCtx {
  factors: Record<string, number | null>;
  vars: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function evalNode(node: Json, ctx: EvalCtx): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => evalNode(n, ctx));
  const obj = node as Record<string, Json>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    // 普通 map：递归各字段
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = evalNode(obj[k], ctx);
    return out;
  }
  const op = keys[0]!;
  const args = obj[op];

  switch (op) {
    case "factor": {
      const name = String(args);
      return ctx.factors[name] ?? null;
    }
    case "var": {
      const name = String(args);
      return ctx.vars[name];
    }
    case "and": {
      const a = (args as Json[]).map((n) => evalNode(n, ctx));
      return a.every((v) => Boolean(v));
    }
    case "or": {
      const a = (args as Json[]).map((n) => evalNode(n, ctx));
      return a.some((v) => Boolean(v));
    }
    case "not": {
      const a = Array.isArray(args) ? evalNode(args[0], ctx) : evalNode(args, ctx);
      return !a;
    }
    case "if": {
      // [cond, then, else, cond, then, ...] 模式
      const a = args as Json[];
      for (let i = 0; i + 1 < a.length; i += 2) {
        if (Boolean(evalNode(a[i]!, ctx))) return evalNode(a[i + 1]!, ctx);
      }
      if (a.length % 2 === 1) return evalNode(a[a.length - 1]!, ctx);
      return null;
    }
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const [l, r] = (args as Json[]).map((n) => evalNode(n, ctx));
      const ln = asNumber(l);
      const rn = asNumber(r);
      if (ln === null || rn === null) {
        if (op === "==") return l === r;
        if (op === "!=") return l !== r;
        return false;
      }
      switch (op) {
        case "==":
          return ln === rn;
        case "!=":
          return ln !== rn;
        case "<":
          return ln < rn;
        case "<=":
          return ln <= rn;
        case ">":
          return ln > rn;
        case ">=":
          return ln >= rn;
      }
    }
    case "+":
    case "-":
    case "*":
    case "/": {
      const nums = (args as Json[])
        .map((n) => asNumber(evalNode(n, ctx)))
        .filter((v): v is number => v !== null);
      if (nums.length === 0) return null;
      const first = nums[0]!;
      switch (op) {
        case "+":
          return nums.reduce((a, b) => a + b, 0);
        case "-":
          return nums.slice(1).reduce((a, b) => a - b, first);
        case "*":
          return nums.reduce((a, b) => a * b, 1);
        case "/":
          return nums.slice(1).reduce((a, b) => (b === 0 ? Number.NaN : a / b), first);
      }
    }
    case "abs": {
      const n = asNumber(evalNode(Array.isArray(args) ? args[0] : args, ctx));
      return n === null ? null : Math.abs(n);
    }
    case "min":
    case "max":
    case "sum": {
      const nums = (args as Json[])
        .map((n) => asNumber(evalNode(n, ctx)))
        .filter((v): v is number => v !== null);
      if (nums.length === 0) return null;
      if (op === "min") return Math.min(...nums);
      if (op === "max") return Math.max(...nums);
      return nums.reduce((a, b) => a + b, 0);
    }
    case "in": {
      const [needle, hay] = (args as Json[]).map((n) => evalNode(n, ctx));
      if (Array.isArray(hay)) return hay.includes(needle as never);
      if (typeof hay === "string" && typeof needle === "string") return hay.includes(needle);
      return false;
    }
    case "weighted_sum": {
      // [{factor: "...", w: 0.5}, ...]
      const items = args as Array<{ factor?: string; var?: string; w: number }>;
      let acc = 0;
      let used = 0;
      for (const it of items) {
        const v = it.factor
          ? ctx.factors[it.factor]
          : it.var
            ? asNumber(ctx.vars[it.var])
            : null;
        if (v == null || !Number.isFinite(v)) continue;
        acc += v * (it.w ?? 0);
        used += 1;
      }
      return used === 0 ? null : acc;
    }
    default:
      // 未知 op：保守返回 null
      return null;
  }
}

export class JsonLogicRuleProvider implements RuleEngineProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async parse(dsl: unknown, lang: string): Promise<{ ok: boolean; ast?: unknown; error?: string }> {
    if (lang !== "jsonlogic") {
      return { ok: false, error: `lang_unsupported: ${lang}` };
    }
    if (!isObject(dsl)) return { ok: false, error: "dsl_not_object" };
    // 必须至少有 when / score / order 之一
    const d = dsl as Record<string, Json>;
    if (d.when === undefined && d.score === undefined && d.filter === undefined) {
      return { ok: false, error: "must_have_when_or_score_or_filter" };
    }
    return { ok: true, ast: dsl };
  }

  async evaluate(rule: RuleSpec, ctx: RuleEvalContext): Promise<RuleEvalResult> {
    const t0 = Date.now();
    const dsl = rule.dsl as Record<string, Json>;
    const symbols = Object.keys(ctx.factorContext ?? {});
    const symbolsOut: RuleEvalSymbolOutcome[] = [];

    for (const sym of symbols) {
      const factors = ctx.factorContext?.[sym] ?? {};
      const vars = { ...(ctx.extraContext ?? {}), symbol: sym };
      const evalCtx: EvalCtx = { factors, vars };

      let passed = true;
      if (dsl.when !== undefined) {
        passed = Boolean(evalNode(dsl.when, evalCtx));
      }
      if (!passed) {
        symbolsOut.push({ symbol: sym, passed: false });
        continue;
      }

      const scoreVal =
        dsl.score !== undefined ? asNumber(evalNode(dsl.score, evalCtx)) : null;

      symbolsOut.push(
        scoreVal === null
          ? { symbol: sym, passed: true }
          : { symbol: sym, passed: true, score: scoreVal }
      );
    }

    return {
      symbols: symbolsOut,
      metrics: { sampleSize: symbols.length, latencyMs: Date.now() - t0 },
    };
  }
}
