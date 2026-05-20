/**
 * GP（symbolic regression）风格的因子表达式生成器
 *
 * 不是真的进化算法（避免过早引入 gplearn 依赖），而是「受约束的随机树生成」：
 *   - 字段池：close, open, high, low, volume
 *   - 一元算子池：Sign, Abs, Log, EMA(_,N)
 *   - 二元算子池：+ - * / ; Corr(_, volume, N)
 *   - 滚动算子池：Mean, Std, Sum, Min, Max, Rank, Delta, Ref, Slope (期 N ∈ {5, 10, 20})
 *
 * 每次调用 generate() 产出一个语法上合法的 qlib_expr 字符串。
 * 同种子（seed）下结果可复现，便于回归测试。
 */

const FIELDS = ["close", "open", "high", "low", "volume", "vwap"];
const UNARY = ["Sign", "Abs", "Log"];
const ROLLING = ["Mean", "Std", "Sum", "Min", "Max", "Rank", "Delta", "Ref", "EMA", "Slope"];
const WINDOWS = [5, 10, 20];

export interface GpOptions {
  /** 树最大深度，默认 3 */
  maxDepth?: number;
  /** 字段池白名单覆盖 */
  fields?: string[];
  /** 滚动算子白名单覆盖 */
  rollingOps?: string[];
  /** 窗口集 */
  windows?: number[];
  /** 是否允许在叶子位置出现数值常量 */
  allowConstants?: boolean;
  /** 伪随机种子（默认随机） */
  seed?: number;
}

export class GpGenerator {
  private rngState: number;
  private cfg: Required<GpOptions>;

  constructor(opts: GpOptions = {}) {
    this.cfg = {
      maxDepth: opts.maxDepth ?? 3,
      fields: opts.fields ?? FIELDS,
      rollingOps: opts.rollingOps ?? ROLLING,
      windows: opts.windows ?? WINDOWS,
      allowConstants: opts.allowConstants ?? true,
      seed: opts.seed ?? Math.floor(Math.random() * 1_000_000),
    };
    this.rngState = this.cfg.seed >>> 0;
  }

  /** 线性同余随机（独立于 Math.random，便于 seed 复现） */
  private rand(): number {
    this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
    return this.rngState / 0x1_0000_0000;
  }

  private pick<T>(arr: T[]): T {
    return arr[Math.floor(this.rand() * arr.length)]!;
  }

  /** 生成一个表达式字符串 */
  generate(): string {
    return this.gen(this.cfg.maxDepth);
  }

  /** 批量去重生成 N 个候选（最多尝试 N×3 次） */
  generateUnique(count: number): string[] {
    const out = new Set<string>();
    const maxTry = count * 4;
    let tries = 0;
    while (out.size < count && tries < maxTry) {
      const e = this.generate();
      if (!out.has(e)) out.add(e);
      tries++;
    }
    return [...out];
  }

  private gen(depth: number): string {
    if (depth <= 0 || this.rand() < 0.2) {
      // 叶子
      if (this.cfg.allowConstants && this.rand() < 0.15) {
        return String(Math.round(this.rand() * 20) / 10); // 0~2.0 一位小数
      }
      return this.pick(this.cfg.fields);
    }
    // 选择算子类型：30% rolling、30% binop、20% unary、20% rolling-corr
    const roll = this.rand();
    if (roll < 0.3) {
      const op = this.pick(this.cfg.rollingOps);
      const w = this.pick(this.cfg.windows);
      const inner = this.gen(depth - 1);
      return `${op}(${inner}, ${w})`;
    }
    if (roll < 0.6) {
      const ops = ["+", "-", "*", "/"] as const;
      const op = ops[Math.floor(this.rand() * ops.length)]!;
      const l = this.gen(depth - 1);
      const r = this.gen(depth - 1);
      return `(${l} ${op} ${r})`;
    }
    if (roll < 0.8) {
      const op = this.pick(UNARY);
      return `${op}(${this.gen(depth - 1)})`;
    }
    const w = this.pick(this.cfg.windows);
    return `Corr(${this.gen(depth - 1)}, ${this.pick(this.cfg.fields)}, ${w})`;
  }
}
