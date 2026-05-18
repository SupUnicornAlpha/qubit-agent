import type { CSSProperties, FC, FormEvent } from "react";
import {
  Activity,
  Banknote,
  BarChart2,
  ChartCandlestick,
  ChartLine,
  CircleDashed,
  FlaskConical,
  LayoutPanelLeft,
  Waves,
} from "lucide-react";
import { useAppStore } from "../../store";
import { CHART_TIMEFRAMES, chartControlStyle } from "../../lib/chartSpec";
import { ChartMarketSelect } from "../chart/ChartMarketSelect";
import { IconToolbarButton } from "../ui/IconToolbarButton";

const chipLayout: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
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
    <header className="qb-workbench-toolbar" style={styles.outer}>
      <form style={styles.rowMain} onSubmit={onSubmit}>
        <div className="qb-toolbar-group">
          <span style={styles.lab}>自选</span>
          <input
            style={styles.fieldControl}
            value={chartSpec.symbol}
            onChange={(e) => setChartSpec({ symbol: e.target.value })}
            placeholder="代码"
            aria-label="品种代码"
          />
          <span style={styles.slash}>/</span>
          <ChartMarketSelect
            style={{ ...styles.fieldControl, fontSize: 12 }}
            value={chartSpec.exchange}
            onChange={(exchange) => setChartSpec({ exchange })}
          />
        </div>
        <span className="qb-toolbar-vsep" aria-hidden />
        <div className="qb-toolbar-group" role="group" aria-label="周期">
          {CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              className={`qb-chip${chartSpec.timeframe === tf ? " qb-chip--active" : ""}`}
              style={chipLayout}
              title={`K 线周期：${tf}`}
              onClick={() => setChartSpec({ timeframe: tf })}
            >
              {tf}
            </button>
          ))}
        </div>
        <span className="qb-toolbar-vsep" aria-hidden />
        <div className="qb-toolbar-group">
          <label style={styles.labInline}>
            条数
            <input
              style={{ ...styles.inpSm, width: 72 }}
              type="number"
              min={1}
              max={2000}
              value={chartSpec.limit}
              onChange={(e) => setChartSpec({ limit: Number(e.target.value) || 120 })}
              title="拉取 K 线根数上限"
            />
          </label>
          <select
            style={styles.select}
            value={ideIndicatorLabel}
            onChange={(e) => setIdeIndicatorLabel(e.target.value)}
            aria-label="指标模板"
            title="研究侧加载的指标脚本模板"
          >
            <option value="（未选指标）">（未选指标）</option>
            <option value="双均线交叉">双均线交叉</option>
            <option value="RSI 区间">RSI 区间</option>
            <option value="MACD 柱">MACD 柱</option>
            <option value="布林带">布林带</option>
          </select>
        </div>
        <div style={styles.spacer} />
        <button type="submit" className="qb-btn-primary" title="按当前自选与周期重新请求 K 线">
          刷新数据
        </button>
      </form>
      <div style={styles.rowSub}>
        <span style={styles.subLab}>主图叠加</span>
        <div className="qb-toolbar-group">
          <IconToolbarButton
            Icon={ChartLine}
            label="SMA20 主图均线"
            active={chartOverlays.sma20}
            onClick={() => toggleChartOverlay("sma20")}
          />
          <IconToolbarButton
            Icon={Waves}
            label="EMA20 主图均线"
            active={chartOverlays.ema20}
            onClick={() => toggleChartOverlay("ema20")}
          />
          <IconToolbarButton
            Icon={Activity}
            label="RSI14 副图"
            active={chartOverlays.rsi14}
            onClick={() => toggleChartOverlay("rsi14")}
          />
          <IconToolbarButton
            Icon={BarChart2}
            label="MACD 副图（与 RSI 二选一）"
            active={chartOverlays.macd}
            onClick={() => toggleChartOverlay("macd")}
          />
          <IconToolbarButton
            Icon={CircleDashed}
            label="布林带（20, 2）主图叠加"
            active={chartOverlays.bb20}
            onClick={() => toggleChartOverlay("bb20")}
          />
        </div>
        <span className="qb-toolbar-vsep" aria-hidden />
        <span style={styles.subLab}>面板</span>
        <div className="qb-toolbar-group">
          <IconToolbarButton
            Icon={LayoutPanelLeft}
            label="显示或隐藏左侧会话列"
            active={idePanels.left}
            onClick={() => toggleIdePanelVisible("left")}
          />
          <IconToolbarButton
            Icon={ChartCandlestick}
            label="显示或隐藏 K 线主图"
            active={idePanels.chart}
            onClick={() => toggleIdePanelVisible("chart")}
          />
          <IconToolbarButton
            Icon={FlaskConical}
            label="显示或隐藏回测停靠栏"
            active={idePanels.backtest}
            onClick={() => toggleIdePanelVisible("backtest")}
          />
          <IconToolbarButton
            Icon={Banknote}
            label="打开或关闭快捷交易侧栏"
            active={ideQuickTradeOpen}
            onClick={() => setIdeQuickTradeOpen(!ideQuickTradeOpen)}
          />
        </div>
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
  },
  rowMain: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 0,
    padding: "8px 14px 6px",
    minWidth: 0,
  },
  rowSub: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    padding: "6px 14px 10px",
    borderTop: "1px solid rgba(42, 42, 46, 0.9)",
    minWidth: 0,
  },
  subLab: {
    fontSize: 11,
    color: "#636366",
    fontWeight: 600,
    letterSpacing: "0.02em",
    marginRight: 2,
  },
  slash: { fontSize: 12, color: "#52525b", padding: "0 2px" },
  lab: { fontSize: 11, color: "#8e8e93", fontWeight: 600, letterSpacing: "0.04em" },
  labInline: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "#8e8e93",
  },
  inpSm: {
    width: 88,
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid rgba(63, 63, 70, 0.95)",
    background: "rgba(24, 24, 27, 0.96)",
    color: "#e4e4e7",
    fontSize: 12,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  fieldControl: {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid rgba(63, 63, 70, 0.95)",
    background: "rgba(24, 24, 27, 0.96)",
    color: "#e4e4e7",
    fontSize: 12,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
    ...chartControlStyle,
  },
  select: {
    minWidth: 140,
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid rgba(63, 63, 70, 0.95)",
    background: "rgba(24, 24, 27, 0.96)",
    color: "#e4e4e7",
    fontSize: 12,
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
  },
  spacer: { flex: 1, minWidth: 12 },
};
