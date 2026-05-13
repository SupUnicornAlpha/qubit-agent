import type { BarData } from "../../connectors/data/data.connector";

export interface RegimeResult {
  regime: string;
  note: string;
  features: {
    return10: number;
    relVol20: number;
  };
}

/** Rule-based regime label from recent closes (no ML). */
export function detectRegimeFromBars(bars: BarData[]): RegimeResult {
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  if (n < 12) {
    return {
      regime: "unknown",
      note: "样本不足（需要至少约 12 根 K 线）",
      features: { return10: 0, relVol20: 0 },
    };
  }
  const c0 = closes[n - 11];
  const c1 = closes[n - 1];
  const ret10 = c0 > 0 ? (c1 - c0) / c0 : 0;
  const window = closes.slice(-Math.min(20, n));
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, x) => a + (x - mean) ** 2, 0) / window.length;
  const std = Math.sqrt(variance);
  const relVol20 = mean > 1e-8 ? std / mean : 0;

  let regime = "range";
  if (ret10 > 0.03 && relVol20 < 0.025) regime = "uptrend_calm";
  else if (ret10 < -0.03 && relVol20 < 0.025) regime = "downtrend_calm";
  else if (relVol20 > 0.045) regime = "high_volatility";
  else if (ret10 > 0.015) regime = "drift_up";
  else if (ret10 < -0.015) regime = "drift_down";

  const note = `近10根收益 ${(ret10 * 100).toFixed(2)}%，近${window.length}根相对波动 ${(relVol20 * 100).toFixed(2)}%`;
  return { regime, note, features: { return10: ret10, relVol20 } };
}
