import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, ChartCandlestick, CircleAlert, Play, RefreshCw } from "lucide-react";
import {
  backtestStrategyContractApi,
  compileStrategyContract,
  getProjectStrategyScript,
  type StrategyManifestV2,
} from "../../api/backend";
import type { QuantStrategyScriptDetail } from "../../api/backend";
import { assessStrategyChartCompatibility } from "../../lib/strategyChartCompatibility";
import { isStrategyApiV2Code, preferStrategyApiCode } from "../../lib/strategyApiCode";
import { useAppStore } from "../../store";
import { MarketTerminalDock } from "../market/MarketTerminalDock";

type DockTab = "options" | "backtest";

function chartMarket(exchange: string): string {
  const market = exchange.trim().toUpperCase();
  if (["NASDAQ", "NYSE", "AMEX", "ARCA", "OPRA", "OCC"].includes(market)) return "US";
  if (market === "HKEX") return "HK";
  if (["SH", "SZ", "SSE", "SZSE", "XSHG", "XSHE"].includes(market)) return "CN";
  return market || "UNKNOWN";
}

const metric = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";

/** K 线底部坞：期权链优先；回测只由 Strategy API Manifest 驱动。 */
export const IdeBacktestDock: FC = () => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const ideStrategySource = useAppStore((s) => s.ideStrategySource);
  const activeStrategyScriptId = useAppStore((s) => s.ideActiveStrategyScriptId);
  const pushTraderMarker = useAppStore((s) => s.pushTraderMarker);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const [tab, setTab] = useState<DockTab>("options");
  const [linkedScript, setLinkedScript] = useState<QuantStrategyScriptDetail | null>(null);
  const [strategyLoading, setStrategyLoading] = useState(false);
  const [manifest, setManifest] = useState<StrategyManifestV2 | null>(null);
  const [busy, setBusy] = useState<"validate" | "backtest" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    setManifest(null);
    setError(null);
    setSummary(null);
    if (!activeStrategyScriptId) {
      setLinkedScript(null);
      return;
    }
    let cancelled = false;
    setStrategyLoading(true);
    void getProjectStrategyScript(activeStrategyScriptId)
      .then((next) => { if (!cancelled) setLinkedScript(next); })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLinkedScript(null);
          setError(`读取关联策略失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      })
      .finally(() => { if (!cancelled) setStrategyLoading(false); });
    return () => { cancelled = true; };
  }, [activeStrategyScriptId]);

  const strategyCode = useMemo(
    () => linkedScript ? preferStrategyApiCode(linkedScript) : ideStrategySource.trim(),
    [ideStrategySource, linkedScript],
  );
  const strategyName = linkedScript?.name ?? "当前 IDE 草稿";
  const compatibility = useMemo(
    () => manifest ? assessStrategyChartCompatibility({ manifest, symbol: chartSpec.symbol, exchange: chartSpec.exchange, timeframe: chartSpec.timeframe }) : null,
    [chartSpec.exchange, chartSpec.symbol, chartSpec.timeframe, manifest],
  );

  const validate = useCallback(async (): Promise<StrategyManifestV2 | null> => {
    if (!strategyCode.trim()) {
      setError("请先选择或编写策略。");
      return null;
    }
    if (!isStrategyApiV2Code(strategyCode)) {
      setError("当前是旧版策略脚本，无法判断 Universe 与 K 线周期。请使用包含 initialize()、set_universe() 和 handle_data() 的 Strategy API 策略。");
      return null;
    }
    const compiled = await compileStrategyContract(strategyCode, { persist: false });
    if (!compiled.ok) {
      setError(`策略契约校验失败：${compiled.error}`);
      return null;
    }
    setManifest(compiled.manifest);
    return compiled.manifest;
  }, [strategyCode]);

  const validateAgainstChart = useCallback(async () => {
    setBusy("validate");
    setError(null);
    setSummary(null);
    try {
      const nextManifest = await validate();
      if (!nextManifest) return;
      const result = assessStrategyChartCompatibility({ manifest: nextManifest, symbol: chartSpec.symbol, exchange: chartSpec.exchange, timeframe: chartSpec.timeframe });
      setSummary(result.compatible ? "策略与当前 K 线匹配，可以回测。" : result.reason);
    } finally {
      setBusy(null);
    }
  }, [chartSpec.exchange, chartSpec.symbol, chartSpec.timeframe, validate]);

  const runBacktest = useCallback(async () => {
    setBusy("backtest");
    setError(null);
    setSummary(null);
    try {
      const nextManifest = await validate();
      if (!nextManifest) return;
      const match = assessStrategyChartCompatibility({ manifest: nextManifest, symbol: chartSpec.symbol, exchange: chartSpec.exchange, timeframe: chartSpec.timeframe });
      if (!match.compatible) {
        setSummary(match.reason);
        return;
      }
      const result = await backtestStrategyContractApi({
        code: strategyCode,
        symbol: `${chartMarket(chartSpec.exchange)}:${chartSpec.symbol.trim().toUpperCase()}`,
        timeframe: chartSpec.timeframe,
        limit: chartSpec.limit,
        initialCapital: 100_000,
      });
      if (!result.ok || !result.data) {
        setError(`策略回测失败：${result.error ?? "unknown"}`);
        return;
      }
      setManifest(result.data.manifest);
      for (const [index, trade] of (result.data.trades ?? []).entries()) {
        const side = trade.side === "sell" ? "sell" : "buy";
        pushTraderMarker({
          id: `strategy-backtest:${result.data.manifest.codeHash}:${trade.time ?? index}`,
          side,
          source: "strategy",
          barTime: trade.time,
          text: `${side === "buy" ? "B" : "S"} 回测${trade.reason ? ` · ${trade.reason}` : ""}`,
        });
      }
      const m = result.data.metrics;
      setSummary(`已在当前 K 线上完成回测 · 收益 ${metric(m.totalReturnPct)}% · 最大回撤 ${metric(m.maxDrawdownPct)}% · Sharpe ${metric(m.sharpeApprox)} · ${m.tradeCount} 笔交易。买卖点已标记到图表。`);
    } finally {
      setBusy(null);
    }
  }, [chartSpec.exchange, chartSpec.limit, chartSpec.symbol, chartSpec.timeframe, pushTraderMarker, strategyCode, validate]);

  return (
    <aside style={styles.dock} aria-label="期权链与策略回测">
      <div className="qb-dock-tabstrip" role="tablist" aria-label="行情工具">
        <button type="button" role="tab" aria-selected={tab === "options"} className={`qb-dock-tab${tab === "options" ? " qb-dock-tab--active" : ""}`} onClick={() => setTab("options")}>期权链</button>
        <button type="button" role="tab" aria-selected={tab === "backtest"} className={`qb-dock-tab${tab === "backtest" ? " qb-dock-tab--active" : ""}`} onClick={() => setTab("backtest")}>策略回测</button>
      </div>
      {tab === "options" ? <MarketTerminalDock optionsOnly /> : (
        <div style={styles.body}>
          <div style={styles.strategyCard}>
            <div style={styles.cardHead}>
              <div><span style={styles.eyebrow}>STRATEGY ↔ CHART</span><strong>{strategyName}</strong></div>
              <span style={styles.status}>{strategyLoading ? "读取策略…" : linkedScript ? "已关联策略" : "未保存草稿"}</span>
            </div>
            <div style={styles.chartScope}><ChartCandlestick size={14} aria-hidden /> 当前 K 线：{chartSpec.symbol || "—"} · {chartSpec.exchange || "AUTO"} · {chartSpec.timeframe}</div>
            {manifest ? <div style={{ ...styles.compatibility, ...(compatibility?.compatible ? styles.compatible : styles.incompatible) }}>
              {compatibility?.compatible ? <BadgeCheck size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
              <span>{compatibility?.reason}</span>
              <small style={styles.scopeLine}>Universe：{compatibility?.universeLabel} · 主周期：{compatibility?.strategyTimeframe}</small>
            </div> : <div style={styles.hint}>回测前先解析策略的 Universe、策略类型和主 K 线周期；不会再把任意图表直接套进策略。</div>}
          </div>
          <div style={styles.actions}>
            <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={() => { setQuantTab("script"); setActiveView("quant"); }}>从策略工坊关联</button>
            <button type="button" className="qb-btn-secondary qb-btn--compact" disabled={busy !== null || strategyLoading} onClick={() => void validateAgainstChart()}><RefreshCw size={13} aria-hidden /> {busy === "validate" ? "校验中…" : "校验当前 K 线"}</button>
            <button type="button" className="qb-btn-primary" disabled={busy !== null || strategyLoading} onClick={() => void runBacktest()}><Play size={13} aria-hidden /> {busy === "backtest" ? "回测中…" : "在当前 K 线上回测"}</button>
          </div>
          <div style={styles.assumption}>执行假设：Strategy API 默认参数 · 初始资金 100,000 · 手续费 0.10% · next-open 成交。策略参数由脚本 Manifest 声明，不再使用旧版 SMA 调参。</div>
          {error ? <div role="alert" style={styles.error}>{error}</div> : null}
          {summary ? <output style={styles.summary}>{summary}</output> : null}
        </div>
      )}
    </aside>
  );
};

const styles: Record<string, CSSProperties> = {
  dock: { flexShrink: 0, minHeight: 260, maxHeight: "min(44vh, 420px)", display: "flex", flexDirection: "column", borderTop: "1px solid var(--qb-main-input-border, #27272a)", background: "var(--qb-team-stage-bg, #0c0c0e)", overflow: "hidden" },
  body: { flex: 1, minHeight: 0, padding: "10px 12px", overflow: "auto", display: "flex", flexDirection: "column", gap: 9 },
  strategyCard: { display: "grid", gap: 7, padding: 9, borderRadius: 7, border: "1px solid var(--qb-main-input-border, #3f3f46)", background: "var(--qb-stream-box-bg, #09090b)" },
  cardHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  eyebrow: { display: "block", marginBottom: 3, color: "var(--qb-main-meta, #71717a)", fontSize: 9, letterSpacing: "0.12em", fontWeight: 700 },
  status: { flexShrink: 0, color: "var(--qb-info, #60a5fa)", fontSize: 10 },
  chartScope: { display: "flex", alignItems: "center", gap: 5, color: "var(--qb-main-meta, #a1a1aa)", fontSize: 11, fontFamily: "var(--qb-font-mono, ui-monospace, monospace)" },
  compatibility: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 6px", padding: "6px 7px", borderRadius: 5, fontSize: 11, lineHeight: 1.4 },
  scopeLine: { gridColumn: "1 / -1", opacity: 0.78 },
  compatible: { color: "var(--qb-success, #34d399)", background: "color-mix(in srgb, var(--qb-success, #34d399) 10%, transparent)" },
  incompatible: { color: "var(--qb-warn, #f59e0b)", background: "color-mix(in srgb, var(--qb-warn, #f59e0b) 10%, transparent)" },
  hint: { color: "var(--qb-main-meta, #a1a1aa)", fontSize: 11, lineHeight: 1.45 },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
  assumption: { color: "var(--qb-main-meta, #71717a)", fontSize: 10, lineHeight: 1.4 },
  error: { padding: "6px 8px", color: "#fca5a5", background: "color-mix(in srgb, #ef4444 10%, transparent)", fontSize: 11, lineHeight: 1.45 },
  summary: { display: "block", padding: "6px 8px", color: "#86efac", background: "color-mix(in srgb, #22c55e 10%, transparent)", fontSize: 11, lineHeight: 1.45 },
};
