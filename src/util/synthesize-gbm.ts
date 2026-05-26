/**
 * Seeded GBM 价格合成器：根据 symbol 字符串确定性地生成"几何布朗运动"价格序列。
 *
 * **用途**：因子 / 策略的 dry-run / 离线评估占位数据；同一 symbol 反复调用必然返回完全相同的序列，
 * 用于：
 *   - `factor-service` 注册时的 expression dry-run
 *   - `discovery-service` 无真实行情可拉时的兜底
 *
 * **绝对不可用于回测真实策略**：序列与真实市场分布无关。
 *
 * 历史：原本在 `factor-service.synthGbmSeries`（PriceSeries 列存）和
 * `discovery-service.synthesizeBars`（BarData 行存）各写了一份完全同构的代码；
 * 抽到这里复用。详见 `docs/AGENT_STABILITY_REVIEW.md` §六-行动建议。
 */

export interface GbmTick {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

const MIN_LENGTH = 40;

/**
 * 生成 `count` 个 GBM tick。
 *
 * @param symbol 用于 seed 哈希；同 symbol 永远返回同序列
 * @param count  期望长度；小于 {@link MIN_LENGTH} 时按 {@link MIN_LENGTH} 取
 */
export function generateGbmTicks(symbol: string, count: number): GbmTick[] {
  const n = Math.max(MIN_LENGTH, count);
  let seed = 0;
  for (const ch of symbol) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let px = 50 + (seed % 80);
  const ticks: GbmTick[] = [];
  for (let i = 0; i < n; i++) {
    const ret = (rand() - 0.5) * 0.04;
    const open = px;
    px = Math.max(1, px * (1 + ret));
    const close = px;
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    const volume = 1_000_000 * (0.5 + rand());
    ticks.push({
      open,
      high,
      low,
      close,
      volume,
      turnover: volume * close,
    });
  }
  return ticks;
}

/** 兼容旧 caller 的最小长度常量（factor-service 的 90 天默认） */
export const GBM_MIN_LENGTH = MIN_LENGTH;
