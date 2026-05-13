import type { CSSProperties, FC } from "react";
import { useCallback, useState } from "react";
import {
  postMarketBacktest,
  postMarketRegimeDetect,
  postMarketStructuredTune,
} from "../../api/backend";
import { useAppStore } from "../../store";

type DockTab = "backtest" | "tune";

function parseNumList(raw: string, fallback: number[]): number[] {
  const xs = raw
    .split(/[\s,;]+/)
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
  return xs.length ? xs : fallback;
}

export const IdeBacktestDock: FC = () => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const [tab, setTab] = useState<DockTab>("backtest");
  const [fastPeriod, setFastPeriod] = useState(5);
  const [slowPeriod, setSlowPeriod] = useState(20);
  const [initialCapital, setInitialCapital] = useState(10_000);
  const [commission, setCommission] = useState(0.001);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [btLoading, setBtLoading] = useState(false);
  const [btError, setBtError] = useState<string | null>(null);
  const [btSummary, setBtSummary] = useState<string | null>(null);
  const [tuneFast, setTuneFast] = useState("3, 5, 8");
  const [tuneSlow, setTuneSlow] = useState("15, 20, 30");
  const [tuneLoading, setTuneLoading] = useState(false);
  const [tuneOut, setTuneOut] = useState<string | null>(null);
  const [regLoading, setRegLoading] = useState(false);
  const [regOut, setRegOut] = useState<string | null>(null);

  const runBacktest = useCallback(async () => {
    setBtLoading(true);
    setBtError(null);
    setBtSummary(null);
    try {
      const body = {
        kind: "sma_crossover",
        symbol: chartSpec.symbol.trim(),
        exchange: chartSpec.exchange.trim() || undefined,
        timeframe: chartSpec.timeframe,
        limit: chartSpec.limit,
        fastPeriod,
        slowPeriod,
        initialCapital,
        commission,
        ...(useCustomRange && startDate && endDate ? { startDate, endDate } : {}),
      };
      const res = await postMarketBacktest(body);
      if (!res.ok) {
        setBtError(res.error ?? "回测失败");
        return;
      }
      const r = res.data?.result as
        | {
            backtest?: {
              metrics?: {
                totalReturnPct?: number;
                maxDrawdownPct?: number;
                sharpeApprox?: number;
                tradeCount?: number;
                bars?: number;
              };
            };
          }
        | undefined;
      const m = r?.backtest?.metrics;
      if (m) {
        setBtSummary(
          `收益 ${(m.totalReturnPct ?? 0).toFixed(2)}% · 最大回撤 ${(m.maxDrawdownPct ?? 0).toFixed(2)}% · Sharpe≈${(m.sharpeApprox ?? 0).toFixed(2)} · 成交 ${m.tradeCount ?? 0} 笔 · K线 ${m.bars ?? 0} 根`
        );
      } else {
        setBtSummary(JSON.stringify(res.data?.result ?? res.data, null, 2).slice(0, 800));
      }
    } catch (e) {
      setBtError(e instanceof Error ? e.message : String(e));
    } finally {
      setBtLoading(false);
    }
  }, [
    chartSpec.exchange,
    chartSpec.limit,
    chartSpec.symbol,
    chartSpec.timeframe,
    commission,
    endDate,
    fastPeriod,
    initialCapital,
    slowPeriod,
    startDate,
    useCustomRange,
  ]);

  const runTune = useCallback(async () => {
    setTuneLoading(true);
    setTuneOut(null);
    try {
      const res = await postMarketStructuredTune({
        base: {
          symbol: chartSpec.symbol.trim(),
          exchange: chartSpec.exchange.trim() || undefined,
          timeframe: chartSpec.timeframe,
          limit: chartSpec.limit,
          ...(useCustomRange && startDate && endDate ? { startDate, endDate } : {}),
        },
        fastPeriods: parseNumList(tuneFast, [3, 5, 8]),
        slowPeriods: parseNumList(tuneSlow, [15, 20, 30]),
        initialCapital,
        commission,
      });
      if (!res.ok) {
        setTuneOut(`错误: ${res.error ?? "unknown"}`);
        return;
      }
      setTuneOut(JSON.stringify(res.data, null, 2).slice(0, 4000));
    } catch (e) {
      setTuneOut(e instanceof Error ? e.message : String(e));
    } finally {
      setTuneLoading(false);
    }
  }, [
    chartSpec.exchange,
    chartSpec.limit,
    chartSpec.symbol,
    chartSpec.timeframe,
    commission,
    endDate,
    initialCapital,
    startDate,
    tuneFast,
    tuneSlow,
    useCustomRange,
  ]);

  const runRegime = useCallback(async () => {
    setRegLoading(true);
    setRegOut(null);
    try {
      const res = await postMarketRegimeDetect({
        symbol: chartSpec.symbol.trim(),
        exchange: chartSpec.exchange.trim() || undefined,
        timeframe: chartSpec.timeframe,
        limit: chartSpec.limit,
        ...(useCustomRange && startDate && endDate ? { startDate, endDate } : {}),
      });
      if (!res.ok) {
        setRegOut(`错误: ${res.error ?? "unknown"}`);
        return;
      }
      setRegOut(JSON.stringify(res.data, null, 2).slice(0, 2000));
    } catch (e) {
      setRegOut(e instanceof Error ? e.message : String(e));
    } finally {
      setRegLoading(false);
    }
  }, [
    chartSpec.exchange,
    chartSpec.limit,
    chartSpec.symbol,
    chartSpec.timeframe,
    endDate,
    startDate,
    useCustomRange,
  ]);

  return (
    <aside style={styles.dock} aria-label="回测与调参">
      <div style={styles.tabs}>
        <button
          type="button"
          style={{ ...styles.tab, ...(tab === "backtest" ? styles.tabOn : {}) }}
          onClick={() => setTab("backtest")}
        >
          回测参数
        </button>
        <button
          type="button"
          style={{ ...styles.tab, ...(tab === "tune" ? styles.tabOn : {}) }}
          onClick={() => setTab("tune")}
        >
          智能调参
        </button>
      </div>
      {tab === "backtest" ? (
        <div style={styles.body}>
          <div style={styles.grid}>
            <label style={styles.field}>
              <span>快线周期</span>
              <input
                type="number"
                style={styles.inp}
                min={1}
                value={fastPeriod}
                onChange={(e) => setFastPeriod(Number(e.target.value) || 5)}
              />
            </label>
            <label style={styles.field}>
              <span>慢线周期</span>
              <input
                type="number"
                style={styles.inp}
                min={2}
                value={slowPeriod}
                onChange={(e) => setSlowPeriod(Number(e.target.value) || 20)}
              />
            </label>
            <label style={styles.field}>
              <span>初始资金</span>
              <input
                type="number"
                style={styles.inp}
                min={100}
                step={100}
                value={initialCapital}
                onChange={(e) => setInitialCapital(Number(e.target.value) || 10_000)}
              />
            </label>
            <label style={styles.field}>
              <span>手续费率</span>
              <input
                type="number"
                style={styles.inp}
                min={0}
                step={0.0001}
                value={commission}
                onChange={(e) => setCommission(Number(e.target.value) || 0)}
              />
            </label>
          </div>
          <label style={styles.check}>
            <input
              type="checkbox"
              checked={useCustomRange}
              onChange={(e) => setUseCustomRange(e.target.checked)}
            />
            自定义日期区间（否则使用当前「条数」推导区间）
          </label>
          {useCustomRange ? (
            <div style={styles.grid}>
              <label style={styles.field}>
                <span>开始日期</span>
                <input style={styles.inp} value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="YYYY-MM-DD" />
              </label>
              <label style={styles.field}>
                <span>结束日期</span>
                <input style={styles.inp} value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="YYYY-MM-DD" />
              </label>
            </div>
          ) : null}
          <div style={styles.row}>
            <button type="button" style={styles.btnPrimary} disabled={btLoading} onClick={() => void runBacktest()}>
              {btLoading ? "运行中…" : "运行回测"}
            </button>
            <span style={styles.muted}>标的取自工具条 · SMA 交叉 · POST /api/v1/market/backtests</span>
          </div>
          {btError ? <div style={styles.err}>{btError}</div> : null}
          {btSummary ? <div style={styles.ok}>{btSummary}</div> : null}
          <div style={styles.pillRow}>
            <span style={styles.pillMuted}>杠杆 / 滑点 / 多空方向（QuantDinger）：UI 已预留，引擎侧后续扩展</span>
          </div>
        </div>
      ) : (
        <div style={styles.body}>
          <p style={styles.hint}>
            Structured scan（Grid）：在快线/慢线周期集合上搜索较优参数（最多 50 组试算，后端限制）。
          </p>
          <label style={styles.fieldFull}>
            <span>快线候选（逗号分隔）</span>
            <input style={styles.inp} value={tuneFast} onChange={(e) => setTuneFast(e.target.value)} />
          </label>
          <label style={styles.fieldFull}>
            <span>慢线候选（逗号分隔）</span>
            <input style={styles.inp} value={tuneSlow} onChange={(e) => setTuneSlow(e.target.value)} />
          </label>
          <div style={styles.row}>
            <button type="button" style={styles.btnPrimary} disabled={tuneLoading} onClick={() => void runTune()}>
              {tuneLoading ? "扫描中…" : "运行智能调参（Grid）"}
            </button>
            <button type="button" style={styles.btnGhost} disabled={regLoading} onClick={() => void runRegime()}>
              {regLoading ? "检测中…" : "盘势检测（Regime）"}
            </button>
          </div>
          {tuneOut ? <pre style={styles.pre}>{tuneOut}</pre> : null}
          {regOut ? <pre style={styles.preSm}>{regOut}</pre> : null}
        </div>
      )}
    </aside>
  );
};

const styles: Record<string, CSSProperties> = {
  dock: {
    flexShrink: 0,
    minHeight: 260,
    maxHeight: "min(44vh, 420px)",
    display: "flex",
    flexDirection: "column",
    borderTop: "1px solid #27272a",
    background: "#0c0c0e",
    overflow: "hidden",
  },
  tabs: {
    display: "flex",
    flexDirection: "row",
    borderBottom: "1px solid #27272a",
    flexShrink: 0,
  },
  tab: {
    padding: "10px 16px",
    fontSize: 13,
    border: "none",
    background: "transparent",
    color: "#71717a",
    cursor: "pointer",
  },
  tabOn: {
    color: "#e4e4e7",
    fontWeight: 600,
    boxShadow: "inset 0 -2px 0 #3b82f6",
  },
  body: {
    flex: 1,
    padding: "10px 12px",
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
    gap: 8,
  },
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#71717a" },
  fieldFull: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#71717a" },
  inp: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
  },
  check: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#a1a1aa" },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 },
  btnPrimary: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnGhost: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
    cursor: "pointer",
  },
  muted: { fontSize: 11, color: "#52525b", flex: 1, minWidth: 120 },
  hint: { margin: 0, fontSize: 12, color: "#a1a1aa", lineHeight: 1.45 },
  err: { fontSize: 12, color: "#fca5a5" },
  ok: { fontSize: 12, color: "#86efac", lineHeight: 1.4 },
  pre: {
    margin: 0,
    padding: 8,
    borderRadius: 6,
    background: "#09090b",
    border: "1px solid #27272a",
    fontSize: 10,
    color: "#a1a1aa",
    overflow: "auto",
    maxHeight: 160,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  preSm: {
    margin: 0,
    padding: 8,
    borderRadius: 6,
    background: "#09090b",
    border: "1px solid #27272a",
    fontSize: 10,
    color: "#93c5fd",
    overflow: "auto",
    maxHeight: 100,
    whiteSpace: "pre-wrap",
  },
  pillRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  pillMuted: { fontSize: 10, color: "#3f3f46" },
};
