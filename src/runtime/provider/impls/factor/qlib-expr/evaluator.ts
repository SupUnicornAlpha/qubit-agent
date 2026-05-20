/**
 * Qlib-like expression evaluator
 *
 * 求值模型：所有操作 element-wise 作用在序列（数组）上。
 *   - 字段 close/open/... 返回 该 symbol 的整段时间序列
 *   - 标量参与 binop 时自动广播
 *   - 时序算子（Ref/Mean/Std/...）的第二参数必须是整数常量（rolling window）
 *
 * 算子（与 Qlib 名字对齐）：
 *   Ref(expr, n)              n 期前的值（lag）
 *   Mean(expr, n)             rolling mean (SMA)
 *   Std(expr, n)              rolling std
 *   Sum(expr, n)              rolling sum
 *   Min(expr, n)              rolling min
 *   Max(expr, n)              rolling max
 *   Rank(expr, n)             rolling rank（0~1，最新值的相对位置）
 *   Delta(expr, n)            x_t - x_{t-n}
 *   Sign(expr)                +1/0/-1
 *   Abs(expr)                 绝对值
 *   Log(expr)                 自然对数
 *   EMA(expr, n)              指数移动平均，alpha = 2/(n+1)
 *   Corr(expr1, expr2, n)     rolling 皮尔逊相关
 *   Slope(expr, n)            rolling 线性回归斜率（对 [0..n-1] 自变量）
 *   IfPos(cond, then, else)   element-wise 条件
 *
 * 长度不足或类型错误 → 该位置返回 NaN（不抛错，向下游传递）。
 */

import { type Ast } from "./parser";

export interface PriceSeries {
  /** symbol 到 时序数组 的映射；每个数组以"日期升序"对齐，缺值填 null */
  fields: Record<string, Array<number | null>>;
  /** 序列长度（所有字段应当一致；以 max 为准） */
  length: number;
}

export class ExprEvalError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ExprEvalError";
  }
}

type Series = Array<number | null>;

function isNum(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function broadcastBinop(
  left: Series | number,
  right: Series | number,
  op: (a: number, b: number) => number,
  n: number
): Series {
  const out: Series = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = typeof left === "number" ? left : left[i];
    const b = typeof right === "number" ? right : right[i];
    out[i] = isNum(a) && isNum(b) ? op(a, b) : null;
  }
  return out;
}

function rollingWindow(
  series: Series,
  window: number,
  reducer: (vals: number[]) => number | null
): Series {
  const n = series.length;
  const out: Series = new Array(n);
  for (let i = 0; i < n; i++) {
    if (i + 1 < window) {
      out[i] = null;
      continue;
    }
    const vals: number[] = [];
    for (let j = i - window + 1; j <= i; j++) {
      const v = series[j];
      if (isNum(v)) vals.push(v);
    }
    out[i] = vals.length === window ? reducer(vals) : null;
  }
  return out;
}

function getIntArg(arg: Series | number, name: string): number {
  if (typeof arg === "number") {
    if (!Number.isInteger(arg) || arg < 1) {
      throw new ExprEvalError("invalid_window", `${name} window must be positive int, got ${arg}`);
    }
    return arg;
  }
  throw new ExprEvalError("invalid_window", `${name} window must be a numeric literal`);
}

// ─── 算子实现 ───────────────────────────────────────────────────────────────

const OPS: Record<
  string,
  (args: Array<Series | number>, n: number) => Series | number
> = {
  Ref(args, n) {
    const x = args[0] as Series;
    const k = getIntArg(args[1]!, "Ref");
    const out: Series = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i - k >= 0 ? x[i - k]! : null;
    return out;
  },
  Mean(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Mean");
    return rollingWindow(x, w, (vs) => {
      let s = 0;
      for (const v of vs) s += v;
      return s / vs.length;
    });
  },
  Sum(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Sum");
    return rollingWindow(x, w, (vs) => {
      let s = 0;
      for (const v of vs) s += v;
      return s;
    });
  },
  Std(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Std");
    return rollingWindow(x, w, (vs) => {
      const n = vs.length;
      let m = 0;
      for (const v of vs) m += v;
      m /= n;
      let s = 0;
      for (const v of vs) s += (v - m) * (v - m);
      return Math.sqrt(s / Math.max(1, n - 1));
    });
  },
  Min(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Min");
    return rollingWindow(x, w, (vs) => Math.min(...vs));
  },
  Max(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Max");
    return rollingWindow(x, w, (vs) => Math.max(...vs));
  },
  Rank(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Rank");
    return rollingWindow(x, w, (vs) => {
      const last = vs[vs.length - 1]!;
      let lower = 0;
      let equal = 0;
      for (const v of vs) {
        if (v < last) lower++;
        else if (v === last) equal++;
      }
      // 0~1 之间，平均秩
      return (lower + (equal - 1) / 2) / Math.max(1, vs.length - 1);
    });
  },
  Delta(args, n) {
    const x = args[0] as Series;
    const k = getIntArg(args[1]!, "Delta");
    const out: Series = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = x[i];
      const b = i - k >= 0 ? x[i - k] : null;
      out[i] = isNum(a) && isNum(b) ? a - b : null;
    }
    return out;
  },
  Sign(args, n) {
    const x = args[0] as Series;
    const out: Series = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = x[i];
      out[i] = isNum(v) ? Math.sign(v) : null;
    }
    return out;
  },
  Abs(args, n) {
    const x = args[0] as Series;
    const out: Series = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = x[i];
      out[i] = isNum(v) ? Math.abs(v) : null;
    }
    return out;
  },
  Log(args, n) {
    const x = args[0] as Series;
    const out: Series = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = x[i];
      out[i] = isNum(v) && v > 0 ? Math.log(v) : null;
    }
    return out;
  },
  EMA(args, n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "EMA");
    const alpha = 2 / (w + 1);
    const out: Series = new Array(n);
    let prev: number | null = null;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      if (!isNum(v)) {
        out[i] = prev; // 缺值时保持上一 EMA
        continue;
      }
      prev = prev == null ? v : prev + alpha * (v - prev);
      out[i] = prev;
    }
    return out;
  },
  Corr(args, _n) {
    const x = args[0] as Series;
    const y = args[1] as Series;
    const w = getIntArg(args[2]!, "Corr");
    const len = Math.min(x.length, y.length);
    const out: Series = new Array(len);
    for (let i = 0; i < len; i++) {
      if (i + 1 < w) {
        out[i] = null;
        continue;
      }
      let mx = 0;
      let my = 0;
      let cnt = 0;
      for (let j = i - w + 1; j <= i; j++) {
        const a = x[j];
        const b = y[j];
        if (!isNum(a) || !isNum(b)) continue;
        mx += a;
        my += b;
        cnt++;
      }
      if (cnt < w) {
        out[i] = null;
        continue;
      }
      mx /= w;
      my /= w;
      let num = 0;
      let dx = 0;
      let dy = 0;
      for (let j = i - w + 1; j <= i; j++) {
        const a = (x[j] as number) - mx;
        const b = (y[j] as number) - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
      }
      out[i] = dx * dy > 1e-12 ? num / Math.sqrt(dx * dy) : null;
    }
    return out;
  },
  Slope(args, _n) {
    const x = args[0] as Series;
    const w = getIntArg(args[1]!, "Slope");
    const sumX = ((w - 1) * w) / 2;
    const sumX2 = ((w - 1) * w * (2 * w - 1)) / 6;
    const meanX = sumX / w;
    return rollingWindow(x, w, (vs) => {
      let sumY = 0;
      let sumXY = 0;
      for (let i = 0; i < w; i++) {
        const v = vs[i]!;
        sumY += v;
        sumXY += i * v;
      }
      const meanY = sumY / w;
      const num = sumXY - w * meanX * meanY;
      const den = sumX2 - w * meanX * meanX;
      return den !== 0 ? num / den : null;
    });
  },
  IfPos(args, n) {
    const cond = args[0] as Series;
    const thenE = args[1]!;
    const elseE = args[2]!;
    const out: Series = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = cond[i];
      if (!isNum(c)) {
        out[i] = null;
        continue;
      }
      const branch = c > 0 ? thenE : elseE;
      const v = typeof branch === "number" ? branch : branch[i];
      out[i] = isNum(v) ? v : null;
    }
    return out;
  },
};

// ─── Public eval ────────────────────────────────────────────────────────────

export function evalAst(ast: Ast, series: PriceSeries): Series | number {
  const n = series.length;
  switch (ast.type) {
    case "num":
      return ast.value;
    case "field": {
      const arr = series.fields[ast.name];
      if (!arr) {
        // 未知字段：返回全空序列；调用方根据全 null 自行判断
        const out: Series = new Array(n).fill(null);
        return out;
      }
      return arr;
    }
    case "unary": {
      const v = evalAst(ast.operand, series);
      if (typeof v === "number") return -v;
      const out: Series = new Array(n);
      for (let i = 0; i < n; i++) out[i] = isNum(v[i]) ? -(v[i] as number) : null;
      return out;
    }
    case "binop": {
      const a = evalAst(ast.left, series);
      const b = evalAst(ast.right, series);
      if (typeof a === "number" && typeof b === "number") {
        switch (ast.op) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            return b === 0 ? Number.NaN : a / b;
        }
      }
      const fn =
        ast.op === "+"
          ? (x: number, y: number) => x + y
          : ast.op === "-"
            ? (x: number, y: number) => x - y
            : ast.op === "*"
              ? (x: number, y: number) => x * y
              : (x: number, y: number) => (y === 0 ? Number.NaN : x / y);
      return broadcastBinop(a, b, fn, n);
    }
    case "call": {
      const fn = OPS[ast.name];
      if (!fn) throw new ExprEvalError("unknown_op", `unknown_op: ${ast.name}`);
      const args = ast.args.map((a) => evalAst(a, series));
      return fn(args, n);
    }
  }
}

export function evalExpr(ast: Ast, series: PriceSeries): Series {
  const v = evalAst(ast, series);
  if (typeof v === "number") {
    const out: Series = new Array(series.length).fill(v);
    return out;
  }
  return v;
}
