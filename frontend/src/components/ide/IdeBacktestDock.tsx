import type { CSSProperties, FC } from "react";
import { useCallback, useState } from "react";
import {
  postMarketBacktest,
  postMarketRegimeDetect,
  postMarketStructuredTune,
} from "../../api/backend";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";

type DockTab = "backtest" | "tune";
type BacktestKind = "python_strategy" | "sma_crossover";

function parseNumList(raw: string, fallback: number[]): number[] {
  const xs = raw
    .split(/[\s,;]+/)
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0);
  return xs.length ? xs : fallback;
}

export const IdeBacktestDock: FC = () => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const ideStrategySource = useAppStore((s) => s.ideStrategySource);
  const { t } = useTranslation();
  const [tab, setTab] = useState<DockTab>("backtest");
  const [kind, setKind] = useState<BacktestKind>("python_strategy");
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
  const [btStderr, setBtStderr] = useState<string | null>(null);
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
    setBtStderr(null);
    try {
      const baseBody = {
        symbol: chartSpec.symbol.trim(),
        exchange: chartSpec.exchange.trim() || undefined,
        timeframe: chartSpec.timeframe,
        limit: chartSpec.limit,
        initialCapital,
        commission,
        ...(useCustomRange && startDate && endDate ? { startDate, endDate } : {}),
      };
      const body =
        kind === "python_strategy"
          ? {
              ...baseBody,
              kind: "python_strategy" as const,
              strategyCode: ideStrategySource,
            }
          : {
              ...baseBody,
              kind: "sma_crossover" as const,
              fastPeriod,
              slowPeriod,
            };
      const res = await postMarketBacktest(body);
      if (!res.ok) {
        setBtError(res.error ?? t("ide.backtest.run.failedDefault"));
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
                lastPosition?: number;
              };
            };
            stderrText?: string;
          }
        | undefined;
      const m = r?.backtest?.metrics;
      if (m) {
        const posTail =
          kind === "python_strategy" && typeof m.lastPosition === "number"
            ? t("ide.backtest.run.posTail", { pos: m.lastPosition.toFixed(4) })
            : "";
        setBtSummary(
          t("ide.backtest.run.summary", {
            ret: (m.totalReturnPct ?? 0).toFixed(2),
            dd: (m.maxDrawdownPct ?? 0).toFixed(2),
            sharpe: (m.sharpeApprox ?? 0).toFixed(2),
            trades: m.tradeCount ?? 0,
            bars: m.bars ?? 0,
            posTail,
          }),
        );
      } else {
        setBtSummary(JSON.stringify(res.data?.result ?? res.data, null, 2).slice(0, 800));
      }
      if (kind === "python_strategy" && r?.stderrText) {
        setBtStderr(r.stderrText);
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
    ideStrategySource,
    initialCapital,
    kind,
    slowPeriod,
    startDate,
    t,
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
        setTuneOut(t("ide.backtest.tune.errorPrefix", { err: res.error ?? "unknown" }));
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
    t,
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
        setRegOut(t("ide.backtest.tune.errorPrefix", { err: res.error ?? "unknown" }));
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
    t,
    useCustomRange,
  ]);

  return (
    <aside style={styles.dock} aria-label={t("ide.backtest.dockAriaLabel")}>
      <div className="qb-dock-tabstrip" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "backtest"}
          className={`qb-dock-tab${tab === "backtest" ? " qb-dock-tab--active" : ""}`}
          onClick={() => setTab("backtest")}
        >
          {t("ide.backtest.tabs.backtest")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tune"}
          className={`qb-dock-tab${tab === "tune" ? " qb-dock-tab--active" : ""}`}
          onClick={() => setTab("tune")}
        >
          {t("ide.backtest.tabs.tune")}
        </button>
      </div>
      {tab === "backtest" ? (
        <div style={styles.body}>
          <div style={styles.kindRow}>
            <span style={styles.kindLabel}>{t("ide.backtest.kind.label")}</span>
            <label style={styles.kindOpt}>
              <input
                type="radio"
                name="bt-kind"
                checked={kind === "python_strategy"}
                onChange={() => setKind("python_strategy")}
              />
              <span>{t("ide.backtest.kind.python")}</span>
            </label>
            <label style={styles.kindOpt}>
              <input
                type="radio"
                name="bt-kind"
                checked={kind === "sma_crossover"}
                onChange={() => setKind("sma_crossover")}
              />
              <span>{t("ide.backtest.kind.sma")}</span>
            </label>
          </div>
          <div style={styles.grid}>
            {kind === "sma_crossover" ? (
              <>
                <label style={styles.field}>
                  <span>{t("ide.backtest.fields.fastPeriod")}</span>
                  <input
                    type="number"
                    style={styles.inp}
                    min={1}
                    value={fastPeriod}
                    onChange={(e) => setFastPeriod(Number(e.target.value) || 5)}
                  />
                </label>
                <label style={styles.field}>
                  <span>{t("ide.backtest.fields.slowPeriod")}</span>
                  <input
                    type="number"
                    style={styles.inp}
                    min={2}
                    value={slowPeriod}
                    onChange={(e) => setSlowPeriod(Number(e.target.value) || 20)}
                  />
                </label>
              </>
            ) : null}
            <label style={styles.field}>
              <span>{t("ide.backtest.fields.initialCapital")}</span>
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
              <span>{t("ide.backtest.fields.commission")}</span>
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
            {t("ide.backtest.fields.customRange")}
          </label>
          {useCustomRange ? (
            <div style={styles.grid}>
              <label style={styles.field}>
                <span>{t("ide.backtest.fields.startDate")}</span>
                <input style={styles.inp} value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="YYYY-MM-DD" />
              </label>
              <label style={styles.field}>
                <span>{t("ide.backtest.fields.endDate")}</span>
                <input style={styles.inp} value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="YYYY-MM-DD" />
              </label>
            </div>
          ) : null}
          <div style={styles.row}>
            <button type="button" className="qb-btn-primary" disabled={btLoading} onClick={() => void runBacktest()}>
              {btLoading ? t("ide.backtest.run.running") : t("ide.backtest.run.button")}
            </button>
            <span style={styles.muted}>
              {t("ide.backtest.run.symbolFromToolbar")} ·{" "}
              {kind === "python_strategy"
                ? t("ide.backtest.run.pythonPathHint")
                : t("ide.backtest.run.smaPathHint")}
              · POST /api/v1/market/backtests
            </span>
          </div>
          {btError ? <div style={styles.err}>{btError}</div> : null}
          {btSummary ? <div style={styles.ok}>{btSummary}</div> : null}
          {btStderr ? (
            <details style={styles.stdoutBox}>
              <summary style={styles.stdoutSum}>
                {t("ide.backtest.run.stdoutSummary", { n: btStderr.length })}
              </summary>
              <pre style={styles.pre}>{btStderr}</pre>
            </details>
          ) : null}
          <div style={styles.pillRow}>
            <span style={styles.pillMuted}>{t("ide.backtest.run.runtimeHint")}</span>
          </div>
        </div>
      ) : (
        <div style={styles.body}>
          <p style={styles.hint}>{t("ide.backtest.tune.intro")}</p>
          <label style={styles.fieldFull}>
            <span>{t("ide.backtest.tune.fastList")}</span>
            <input style={styles.inp} value={tuneFast} onChange={(e) => setTuneFast(e.target.value)} />
          </label>
          <label style={styles.fieldFull}>
            <span>{t("ide.backtest.tune.slowList")}</span>
            <input style={styles.inp} value={tuneSlow} onChange={(e) => setTuneSlow(e.target.value)} />
          </label>
          <div style={styles.row}>
            <button type="button" className="qb-btn-primary" disabled={tuneLoading} onClick={() => void runTune()}>
              {tuneLoading ? t("ide.backtest.tune.running") : t("ide.backtest.tune.run")}
            </button>
            <button type="button" className="qb-btn-ghost" disabled={regLoading} onClick={() => void runRegime()}>
              {regLoading ? t("ide.backtest.tune.regimeRunning") : t("ide.backtest.tune.regimeRun")}
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
    borderTop: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-team-stage-bg, #0c0c0e)",
    overflow: "hidden",
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
  field: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--qb-main-meta, #71717a)" },
  fieldFull: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--qb-main-meta, #71717a)" },
  inp: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 12,
  },
  check: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 },
  muted: { fontSize: 11, color: "var(--qb-main-meta, #52525b)", flex: 1, minWidth: 120 },
  hint: { margin: 0, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)", lineHeight: 1.45 },
  err: { fontSize: 12, color: "#fca5a5" },
  ok: { fontSize: 12, color: "#86efac", lineHeight: 1.4 },
  pre: {
    margin: 0,
    padding: 8,
    borderRadius: 6,
    background: "var(--qb-stream-box-bg, #09090b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    fontSize: 10,
    color: "var(--qb-stream-box-fg, #a1a1aa)",
    overflow: "auto",
    maxHeight: 160,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  preSm: {
    margin: 0,
    padding: 8,
    borderRadius: 6,
    background: "var(--qb-stream-box-bg, #09090b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    fontSize: 10,
    color: "var(--qb-blue, #93c5fd)",
    overflow: "auto",
    maxHeight: 100,
    whiteSpace: "pre-wrap",
  },
  pillRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  pillMuted: { fontSize: 10, color: "var(--qb-main-input-border, #3f3f46)" },
  kindRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    padding: "6px 8px",
    border: "1px dashed var(--qb-main-input-border, #27272a)",
    borderRadius: 6,
    background: "var(--qb-stream-box-bg, #09090b)",
  },
  kindLabel: { fontSize: 11, color: "var(--qb-main-meta, #71717a)", flexShrink: 0 },
  kindOpt: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--qb-main-fg, #e4e4e7)",
    cursor: "pointer",
  },
  stdoutBox: {
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 6,
    background: "var(--qb-stream-box-bg, #09090b)",
  },
  stdoutSum: {
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: 11,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
};
