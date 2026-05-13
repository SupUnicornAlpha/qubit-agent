import type { CSSProperties, FC, FormEvent } from "react";
import { useAppStore } from "../../store";
import { CHART_MARKET_OPTIONS, CHART_TIMEFRAMES, coerceChartMarketExchange } from "../../lib/chartSpec";

const chipBase: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #3f3f46",
  background: "#18181b",
  color: "#a1a1aa",
  fontSize: 12,
  cursor: "pointer",
};
const chipActive: CSSProperties = {
  background: "#2563eb",
  borderColor: "#3b82f6",
  color: "#fff",
  fontWeight: 600,
};

export const IdeWorkbenchToolbar: FC = () => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const requestChartReload = useAppStore((s) => s.requestChartReload);
  const ideIndicatorLabel = useAppStore((s) => s.ideIndicatorLabel);
  const setIdeIndicatorLabel = useAppStore((s) => s.setIdeIndicatorLabel);
  const ideQuickTradeOpen = useAppStore((s) => s.ideQuickTradeOpen);
  const setIdeQuickTradeOpen = useAppStore((s) => s.setIdeQuickTradeOpen);
  const idePanels = useAppStore((s) => s.idePanels);
  const toggleIdePanelVisible = useAppStore((s) => s.toggleIdePanelVisible);
  const chartOverlays = useAppStore((s) => s.chartOverlays);
  const toggleChartOverlay = useAppStore((s) => s.toggleChartOverlay);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    requestChartReload();
  };

  return (
    <header style={styles.outer}>
      <form style={styles.rowMain} onSubmit={onSubmit}>
        <span style={styles.lab}>自选</span>
        <input
          style={styles.inpSm}
          value={chartSpec.symbol}
          onChange={(e) => setChartSpec({ symbol: e.target.value })}
          placeholder="代码"
          aria-label="品种代码"
        />
        <span style={styles.slash}>/</span>
        <select
          style={{ ...styles.select, minWidth: 128, maxWidth: 200, fontSize: 12 }}
          value={coerceChartMarketExchange(chartSpec.exchange)}
          onChange={(e) => setChartSpec({ exchange: e.target.value })}
          aria-label="市场"
        >
          {CHART_MARKET_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <div style={styles.tfRow} role="group" aria-label="周期">
          {CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              style={{
                ...chipBase,
                ...(chartSpec.timeframe === tf ? chipActive : {}),
              }}
              onClick={() => setChartSpec({ timeframe: tf })}
            >
              {tf}
            </button>
          ))}
        </div>
        <label style={styles.labInline}>
          条数
          <input
            style={{ ...styles.inpSm, width: 72 }}
            type="number"
            min={1}
            max={2000}
            value={chartSpec.limit}
            onChange={(e) => setChartSpec({ limit: Number(e.target.value) || 120 })}
          />
        </label>
        <select
          style={styles.select}
          value={ideIndicatorLabel}
          onChange={(e) => setIdeIndicatorLabel(e.target.value)}
          aria-label="指标模板"
        >
          <option value="（未选指标）">（未选指标）</option>
          <option value="双均线交叉">双均线交叉</option>
          <option value="RSI 区间">RSI 区间</option>
          <option value="MACD 柱">MACD 柱</option>
          <option value="布林带">布林带</option>
        </select>
        <button type="submit" style={styles.btn}>
          刷新
        </button>
      </form>
      <div style={styles.rowSub}>
        <span style={styles.subLab}>主图叠加</span>
        <button
          type="button"
          style={{ ...chipBase, ...(chartOverlays.sma20 ? chipActive : {}) }}
          onClick={() => toggleChartOverlay("sma20")}
        >
          SMA20
        </button>
        <button
          type="button"
          style={{ ...chipBase, ...(chartOverlays.ema20 ? chipActive : {}) }}
          onClick={() => toggleChartOverlay("ema20")}
        >
          EMA20
        </button>
        <button
          type="button"
          style={{ ...chipBase, ...(chartOverlays.rsi14 ? chipActive : {}) }}
          onClick={() => toggleChartOverlay("rsi14")}
          title="RSI14 副图"
        >
          RSI
        </button>
        <button
          type="button"
          style={{ ...chipBase, ...(chartOverlays.macd ? chipActive : {}) }}
          onClick={() => toggleChartOverlay("macd")}
          title="MACD 副图（与 RSI 二选一）"
        >
          MACD
        </button>
        <button
          type="button"
          style={{ ...chipBase, ...(chartOverlays.bb20 ? chipActive : {}) }}
          onClick={() => toggleChartOverlay("bb20")}
          title="布林带（20, 2）主图叠加"
        >
          BB
        </button>
        <div style={styles.spacer} />
        <span style={styles.subLab}>面板</span>
        <button
          type="button"
          style={{ ...chipBase, ...(idePanels.left ? chipActive : {}) }}
          onClick={() => toggleIdePanelVisible("left")}
        >
          会话
        </button>
        <button
          type="button"
          style={{ ...chipBase, ...(idePanels.chart ? chipActive : {}) }}
          onClick={() => toggleIdePanelVisible("chart")}
        >
          K线
        </button>
        <button
          type="button"
          style={{ ...chipBase, ...(idePanels.backtest ? chipActive : {}) }}
          onClick={() => toggleIdePanelVisible("backtest")}
        >
          回测
        </button>
        <button
          type="button"
          style={{
            ...chipBase,
            ...(ideQuickTradeOpen ? chipActive : {}),
          }}
          onClick={() => setIdeQuickTradeOpen(!ideQuickTradeOpen)}
        >
          快捷交易
        </button>
      </div>
    </header>
  );
};

const styles: Record<string, CSSProperties> = {
  outer: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 0,
    background: "#111114",
    borderBottom: "1px solid #27272a",
  },
  rowMain: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px 4px",
    minWidth: 0,
  },
  rowSub: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px 8px",
    borderTop: "1px solid #1f1f23",
    minWidth: 0,
  },
  subLab: {
    fontSize: 11,
    color: "#52525b",
    fontWeight: 600,
    marginRight: 4,
  },
  slash: { fontSize: 12, color: "#52525b", padding: "0 2px" },
  lab: { fontSize: 11, color: "#71717a", fontWeight: 600, letterSpacing: "0.04em" },
  labInline: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "#71717a",
  },
  inpSm: {
    width: 88,
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
  },
  tfRow: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" },
  select: {
    minWidth: 140,
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
  },
  btn: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  spacer: { flex: 1, minWidth: 8 },
  quickBtn: {
    flexShrink: 0,
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  quickBtnOn: {
    background: "#1e3a8a",
    borderColor: "#3b82f6",
    color: "#fff",
  },
};
