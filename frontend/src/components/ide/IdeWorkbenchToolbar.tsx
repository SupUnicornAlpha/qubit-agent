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
import { useTranslation } from "../../i18n";

const chipLayout: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 8,
  fontSize: 12,
  cursor: "pointer",
};

/**
 * 指标模板下拉选项：使用稳定 id 作为持久化值，切换语言后只影响展示。
 * 老版本可能在 localStorage / store 里残留中文 label —— 但当前 store 没有对它做持久化，
 * 切语言不会引入历史值不一致问题。
 */
const INDICATOR_IDS = ["none", "smaCross", "rsiRange", "macdHist", "boll"] as const;

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
  const { t } = useTranslation();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    requestChartReload();
  };

  return (
    <header className="qb-workbench-toolbar" style={styles.outer}>
      <form style={styles.rowMain} onSubmit={onSubmit}>
        <div className="qb-toolbar-group">
          <span style={styles.lab}>{t("ide.toolbar.labels.watchlist")}</span>
          <input
            style={styles.fieldControl}
            value={chartSpec.symbol}
            onChange={(e) => setChartSpec({ symbol: e.target.value })}
            placeholder={t("ide.toolbar.labels.symbol")}
            aria-label={t("ide.toolbar.labels.symbolAria")}
          />
          <span style={styles.slash}>/</span>
          <ChartMarketSelect
            style={{ ...styles.fieldControl, fontSize: 12 }}
            value={chartSpec.exchange}
            onChange={(exchange) => setChartSpec({ exchange })}
          />
        </div>
        <span className="qb-toolbar-vsep" aria-hidden />
        <div className="qb-toolbar-group" role="group" aria-label={t("ide.toolbar.labels.period")}>
          {CHART_TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              type="button"
              className={`qb-chip${chartSpec.timeframe === tf ? " qb-chip--active" : ""}`}
              style={chipLayout}
              title={t("ide.toolbar.labels.periodTitle", { tf })}
              onClick={() => setChartSpec({ timeframe: tf })}
            >
              {tf}
            </button>
          ))}
        </div>
        <span className="qb-toolbar-vsep" aria-hidden />
        <div className="qb-toolbar-group">
          <label style={styles.labInline}>
            {t("ide.toolbar.labels.bars")}
            <input
              style={{ ...styles.inpSm, width: 72 }}
              type="number"
              min={1}
              max={2000}
              value={chartSpec.limit}
              onChange={(e) => setChartSpec({ limit: Number(e.target.value) || 120 })}
              title={t("ide.toolbar.labels.barsTitle")}
            />
          </label>
          <select
            style={styles.select}
            value={(INDICATOR_IDS as readonly string[]).includes(ideIndicatorLabel)
              ? ideIndicatorLabel
              : "none"}
            onChange={(e) => setIdeIndicatorLabel(e.target.value)}
            aria-label={t("ide.toolbar.labels.indicators")}
            title={t("ide.toolbar.labels.indicatorsTitle")}
          >
            {INDICATOR_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`ide.indicators.${id}`)}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.spacer} />
        <button
          type="submit"
          className="qb-btn-primary"
          title={t("ide.toolbar.labels.refreshTitle")}
        >
          {t("ide.toolbar.labels.refresh")}
        </button>
      </form>
      <div style={styles.rowSub}>
        <span style={styles.subLab}>{t("ide.toolbar.labels.mainOverlay")}</span>
        <div className="qb-toolbar-group">
          <IconToolbarButton
            Icon={ChartLine}
            label={t("ide.toolbar.overlays.sma20")}
            active={chartOverlays.sma20}
            onClick={() => toggleChartOverlay("sma20")}
          />
          <IconToolbarButton
            Icon={Waves}
            label={t("ide.toolbar.overlays.ema20")}
            active={chartOverlays.ema20}
            onClick={() => toggleChartOverlay("ema20")}
          />
          <IconToolbarButton
            Icon={Activity}
            label={t("ide.toolbar.overlays.rsi14")}
            active={chartOverlays.rsi14}
            onClick={() => toggleChartOverlay("rsi14")}
          />
          <IconToolbarButton
            Icon={BarChart2}
            label={t("ide.toolbar.overlays.macd")}
            active={chartOverlays.macd}
            onClick={() => toggleChartOverlay("macd")}
          />
          <IconToolbarButton
            Icon={CircleDashed}
            label={t("ide.toolbar.overlays.bb20")}
            active={chartOverlays.bb20}
            onClick={() => toggleChartOverlay("bb20")}
          />
        </div>
        <span className="qb-toolbar-vsep" aria-hidden />
        <span style={styles.subLab}>{t("ide.toolbar.labels.panels")}</span>
        <div className="qb-toolbar-group">
          <IconToolbarButton
            Icon={LayoutPanelLeft}
            label={t("ide.toolbar.panelToggles.left")}
            active={idePanels.left}
            onClick={() => toggleIdePanelVisible("left")}
          />
          <IconToolbarButton
            Icon={ChartCandlestick}
            label={t("ide.toolbar.panelToggles.chart")}
            active={idePanels.chart}
            onClick={() => toggleIdePanelVisible("chart")}
          />
          <IconToolbarButton
            Icon={FlaskConical}
            label={t("ide.toolbar.panelToggles.backtest")}
            active={idePanels.backtest}
            onClick={() => toggleIdePanelVisible("backtest")}
          />
          <IconToolbarButton
            Icon={Banknote}
            label={t("ide.toolbar.panelToggles.quickTrade")}
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
