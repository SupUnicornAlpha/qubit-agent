/**
 * BacktestStudioTab — 事件驱动回测工坊
 *
 * 三栏：
 *   左：发起表单（strategyVersion / composition 或手写 signals / 参数）
 *   中：选中 job 详情 + Metrics 卡片 + Equity SVG 曲线
 *   右：Trades & 历史任务
 *
 * 与后端 /api/v1/backtest-jobs 对接。strategy_version 由 /api/v1/strategies/versions 提供。
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getBacktestJob,
  listBacktestJobs,
  listStrategyCompositions,
  listStrategyVersions,
  runBacktestJobNow,
  type BacktestEquityPoint,
  type BacktestJobRecord,
  type BacktestSignalSpec,
  type StrategyCompositionRecord,
  type StrategyVersionFlatRecord,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";

type Source = "composition" | "raw";
type Rebalance = "daily" | "weekly" | "monthly";

const STATUS_TONES: Record<BacktestJobRecord["status"], string> = {
  pending: "var(--qb-text-muted)",
  running: "#3b82f6",
  completed: "var(--qb-success, #36ad6a)",
  failed: "#c54040",
};

export const BacktestStudioTab: FC = () => {
  const { projectId, loading: projectLoading, error: projectError } = useDefaultProject();

  const [versions, setVersions] = useState<StrategyVersionFlatRecord[]>([]);
  const [versionId, setVersionId] = useState<string>("");
  const [compositions, setCompositions] = useState<StrategyCompositionRecord[]>([]);
  const [compositionId, setCompositionId] = useState<string>("");

  const [source, setSource] = useState<Source>("composition");
  const [rawExpr, setRawExpr] = useState("Mean($close, 20) - Mean($close, 60)");
  const [rawReverse, setRawReverse] = useState(false);

  const [symbols, setSymbols] = useState("AAPL,MSFT,GOOG");
  const [startDate, setStartDate] = useState("2026-01-01");
  const [endDate, setEndDate] = useState("2026-04-30");
  const [capital, setCapital] = useState(100_000);
  const [commissionBps, setCommissionBps] = useState(5);
  const [slippageBps, setSlippageBps] = useState(5);
  const [rebalance, setRebalance] = useState<Rebalance>("daily");
  const [topN, setTopN] = useState<number | "">("");

  const [jobs, setJobs] = useState<BacktestJobRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<BacktestJobRecord | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const symbolsList = useMemo(
    () =>
      symbols
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [symbols]
  );

  const reloadVersions = useCallback(async () => {
    if (!projectId) return;
    try {
      const rows = await listStrategyVersions(projectId);
      setVersions(rows);
      if (!versionId && rows.length > 0) setVersionId(rows[0]!.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId, versionId]);

  const reloadCompositions = useCallback(async () => {
    if (!versionId) {
      setCompositions([]);
      setCompositionId("");
      return;
    }
    try {
      const rows = await listStrategyCompositions(versionId);
      setCompositions(rows);
      if (rows.length > 0) setCompositionId(rows[0]!.id);
      else setCompositionId("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [versionId]);

  const reloadJobs = useCallback(async () => {
    try {
      const rows = await listBacktestJobs();
      setJobs(rows);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0]!.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadVersions();
  }, [reloadVersions]);

  useEffect(() => {
    void reloadCompositions();
  }, [reloadCompositions]);

  useEffect(() => {
    void reloadJobs();
  }, [reloadJobs]);

  const reloadSelected = useCallback(async () => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    try {
      const job = await getBacktestJob(selectedId);
      setSelected(job);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadSelected();
  }, [reloadSelected]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!versionId) {
        setError("先选择一个 strategy version");
        return;
      }
      if (source === "composition" && !compositionId) {
        setError("先选择一个 composition，或切换到 raw signals 模式");
        return;
      }
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const rawSignal: BacktestSignalSpec = {
          kind: "factor_score",
          expr: rawExpr,
          lang: "qlib_expr",
          reverse: rawReverse,
        };
        const job = await runBacktestJobNow({
          strategyVersionId: versionId,
          ...(source === "composition" ? { compositionId } : { signals: rawSignal }),
          symbols: symbolsList,
          startDate,
          endDate,
          capital,
          costs: { commissionBps, slippageBps },
          rebalance,
          ...(typeof topN === "number" ? { topN } : {}),
        });
        setInfo(
          `回测 ${job.status}：${job.result?.metrics.tradeCount ?? 0} 笔交易 · 总收益 ${(((job.result?.metrics.totalReturn ?? 0) * 100).toFixed(2))}%`
        );
        await reloadJobs();
        setSelectedId(job.id);
        setSelected(job);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [
      versionId,
      source,
      compositionId,
      rawExpr,
      rawReverse,
      symbolsList,
      startDate,
      endDate,
      capital,
      commissionBps,
      slippageBps,
      rebalance,
      topN,
      reloadJobs,
    ]
  );

  if (projectLoading) {
    return <div style={styles.empty}>加载默认 project…</div>;
  }
  if (projectError) {
    return <div style={styles.errorPanel}>项目加载失败：{projectError}</div>;
  }
  if (!projectId) {
    return <div style={styles.empty}>未找到默认 project，请先初始化。</div>;
  }

  return (
    <div style={styles.root}>
      <aside style={styles.colLeft}>
        <div style={styles.colHeader}>
          <strong>发起回测</strong>
        </div>
        <form onSubmit={onSubmit} style={styles.form}>
          <label style={styles.formLabel}>
            Strategy Version
            <select
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
              style={styles.select}
              required
            >
              {versions.length === 0 ? (
                <option value="" disabled>
                  暂无 strategy_version
                </option>
              ) : null}
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.strategyName} · {v.versionTag}
                </option>
              ))}
            </select>
          </label>
          <div style={styles.sourceToggle}>
            <button
              type="button"
              onClick={() => setSource("composition")}
              style={{
                ...styles.toggleBtn,
                ...(source === "composition" ? styles.toggleBtnActive : null),
              }}
            >
              Composition
            </button>
            <button
              type="button"
              onClick={() => setSource("raw")}
              style={{
                ...styles.toggleBtn,
                ...(source === "raw" ? styles.toggleBtnActive : null),
              }}
            >
              Raw Signal
            </button>
          </div>
          {source === "composition" ? (
            <label style={styles.formLabel}>
              Composition
              <select
                value={compositionId}
                onChange={(e) => setCompositionId(e.target.value)}
                style={styles.select}
                disabled={compositions.length === 0}
              >
                {compositions.length === 0 ? (
                  <option value="">无 composition（请先定义或切到 Raw）</option>
                ) : null}
                {compositions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.kind} · {c.factorIds.length} factors · {c.ruleIds.length} rules
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label style={styles.formLabel}>
                因子表达式 (qlib_expr)
                <textarea
                  value={rawExpr}
                  onChange={(e) => setRawExpr(e.target.value)}
                  rows={2}
                  style={styles.textarea}
                />
              </label>
              <label style={styles.formInline}>
                <input
                  type="checkbox"
                  checked={rawReverse}
                  onChange={(e) => setRawReverse(e.target.checked)}
                />
                反向（rank 越小越好）
              </label>
            </>
          )}
          <label style={styles.formLabel}>
            Symbols
            <input
              type="text"
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              placeholder="AAPL,MSFT,GOOG"
              style={styles.input}
            />
          </label>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              起
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              止
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={styles.input}
              />
            </label>
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              Capital
              <input
                type="number"
                value={capital}
                onChange={(e) => setCapital(Number.parseInt(e.target.value, 10) || 0)}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              Rebalance
              <select
                value={rebalance}
                onChange={(e) => setRebalance(e.target.value as Rebalance)}
                style={styles.select}
              >
                <option value="daily">每日</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </label>
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              Commission bps
              <input
                type="number"
                min={0}
                value={commissionBps}
                onChange={(e) => setCommissionBps(Number.parseFloat(e.target.value) || 0)}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              Slippage bps
              <input
                type="number"
                min={0}
                value={slippageBps}
                onChange={(e) => setSlippageBps(Number.parseFloat(e.target.value) || 0)}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              TopN
              <input
                type="number"
                min={1}
                value={topN}
                onChange={(e) =>
                  setTopN(e.target.value === "" ? "" : Number.parseInt(e.target.value, 10))
                }
                placeholder="自动"
                style={styles.input}
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={busy || symbolsList.length === 0 || !versionId}
            style={styles.btnPrimary}
          >
            {busy ? "运行中…" : "Run Now"}
          </button>
        </form>
        <div style={styles.colHeader}>
          <strong>历史任务</strong>
          <span style={styles.muted}>{jobs.length}</span>
        </div>
        <div style={styles.list}>
          {jobs.length === 0 ? <div style={styles.empty}>暂无任务</div> : null}
          {jobs.map((j) => (
            <button
              key={j.id}
              type="button"
              onClick={() => setSelectedId(j.id)}
              style={{
                ...styles.listItem,
                ...(j.id === selectedId ? styles.listItemActive : null),
              }}
            >
              <div style={styles.listItemTop}>
                <span style={{ color: STATUS_TONES[j.status], fontWeight: 600 }}>{j.status}</span>
                <span style={styles.muted}>
                  {j.result ? `${(j.result.metrics.totalReturn * 100).toFixed(2)}%` : "—"}
                </span>
              </div>
              <div style={styles.listItemMeta}>
                {j.engineKey} · {new Date(j.startedAt).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section style={styles.colMid}>
        {selected ? (
          <BacktestResultView job={selected} onRefresh={reloadSelected} />
        ) : (
          <div style={styles.empty}>左侧选择历史任务或新建回测。</div>
        )}
      </section>

      <aside style={styles.colRight}>
        <div style={styles.colHeader}>
          <strong>Trades</strong>
          <span style={styles.muted}>{selected?.result?.trades.length ?? 0}</span>
        </div>
        <div style={styles.tradesList}>
          {(selected?.result?.trades ?? []).slice(0, 200).map((t, i) => (
            <div key={i} style={styles.tradeRow}>
              <span style={styles.muted}>{t.date}</span>
              <span style={t.side === "buy" ? styles.buy : styles.sell}>{t.side}</span>
              <span>{t.symbol}</span>
              <span style={styles.tradeNum}>{t.qty.toFixed(4)}</span>
              <span style={styles.tradeNum}>${t.price.toFixed(2)}</span>
            </div>
          ))}
          {(selected?.result?.trades.length ?? 0) === 0 ? (
            <div style={styles.empty}>—</div>
          ) : null}
        </div>
      </aside>

      {error ? <div style={styles.toastErr}>{error}</div> : null}
      {info ? <div style={styles.toastInfo}>{info}</div> : null}
    </div>
  );
};

const BacktestResultView: FC<{ job: BacktestJobRecord; onRefresh: () => Promise<void> }> = ({
  job,
  onRefresh,
}) => {
  const m = job.result?.metrics;
  const equity = job.result?.equityCurve ?? [];

  return (
    <>
      <div style={styles.detailHeader}>
        <div>
          <div style={styles.detailTitle}>
            <span style={{ color: STATUS_TONES[job.status] }}>{job.status.toUpperCase()}</span> ·{" "}
            {job.engineKey}
          </div>
          <div style={styles.detailMeta}>
            {job.config.startDate} ~ {job.config.endDate} · capital=${job.config.capital} ·{" "}
            {job.config.symbols.length} symbols · rebalance={job.config.rebalance ?? "daily"}
          </div>
        </div>
        <button type="button" onClick={onRefresh} style={styles.btnGhost}>
          刷新
        </button>
      </div>
      {job.result?.error ? <div style={styles.errorPanel}>{job.result.error}</div> : null}
      {m ? (
        <div style={styles.metricsGrid}>
          <Metric label="总收益" value={m.totalReturn} pct />
          <Metric label="年化收益" value={m.annualReturn} pct />
          <Metric label="年化波动" value={m.annualVol} pct />
          <Metric label="Sharpe" value={m.sharpe} />
          <Metric label="最大回撤" value={m.maxDrawdown} pct />
          <Metric label="胜率" value={m.winRate} pct />
          <Metric label="交易笔数" value={m.tradeCount} digits={0} />
          <Metric label="换手率" value={m.turnover} />
        </div>
      ) : null}
      {equity.length > 1 ? <EquityChart data={equity} capital={job.config.capital} /> : null}
    </>
  );
};

const Metric: FC<{ label: string; value: number; pct?: boolean; digits?: number }> = ({
  label,
  value,
  pct = false,
  digits = 4,
}) => {
  if (!Number.isFinite(value)) {
    return (
      <div style={styles.metric}>
        <div style={styles.metricLabel}>{label}</div>
        <div style={styles.metricValue}>—</div>
      </div>
    );
  }
  const text = pct ? `${(value * 100).toFixed(2)}%` : value.toFixed(digits);
  return (
    <div style={styles.metric}>
      <div style={styles.metricLabel}>{label}</div>
      <div style={styles.metricValue}>{text}</div>
    </div>
  );
};

const EquityChart: FC<{ data: BacktestEquityPoint[]; capital: number }> = ({ data, capital }) => {
  const w = 720;
  const h = 220;
  const padL = 40;
  const padR = 12;
  const padT = 10;
  const padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const minV = Math.min(...data.map((d) => d.equity));
  const maxV = Math.max(...data.map((d) => d.equity));
  const range = Math.max(1e-6, maxV - minV);

  const pts = data.map((d, i) => {
    const x = padL + (i / (data.length - 1)) * innerW;
    const y = padT + (1 - (d.equity - minV) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const baselineY = padT + (1 - (capital - minV) / range) * innerH;

  return (
    <div style={styles.chartWrap}>
      <div style={styles.chartTitle}>Equity Curve</div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line
          x1={padL}
          y1={baselineY}
          x2={w - padR}
          y2={baselineY}
          stroke="var(--qb-border-subtle)"
          strokeDasharray="4 4"
        />
        <polyline
          points={pts.join(" ")}
          fill="none"
          stroke="var(--qb-success, #36ad6a)"
          strokeWidth={1.5}
        />
        <text x={padL} y={padT + 10} fontSize="10" fill="var(--qb-text-muted)">
          {maxV.toFixed(0)}
        </text>
        <text x={padL} y={padT + innerH - 2} fontSize="10" fill="var(--qb-text-muted)">
          {minV.toFixed(0)}
        </text>
        <text x={padL} y={h - 6} fontSize="10" fill="var(--qb-text-muted)">
          {data[0]!.date}
        </text>
        <text x={w - padR - 60} y={h - 6} fontSize="10" fill="var(--qb-text-muted)">
          {data[data.length - 1]!.date}
        </text>
      </svg>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 340px) 1fr minmax(220px, 280px)",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  colLeft: {
    borderRight: "1px solid var(--qb-border-subtle)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  colMid: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    padding: "12px 16px 20px",
    gap: 12,
    overflow: "auto",
    position: "relative",
  },
  colRight: {
    borderLeft: "1px solid var(--qb-border-subtle)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  colHeader: {
    flex: "0 0 auto",
    padding: "10px 12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontSize: 12,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
  },
  formRow: { display: "flex", gap: 8 },
  formInline: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    fontSize: 11,
    color: "var(--qb-text-muted)",
  },
  formLabel: {
    display: "flex",
    flexDirection: "column",
    fontSize: 11,
    color: "var(--qb-text-muted)",
    gap: 2,
    minWidth: 0,
    flex: 1,
  },
  input: {
    fontSize: 12,
    padding: "4px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  textarea: {
    fontSize: 11,
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    padding: "6px 8px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
    resize: "vertical",
  },
  select: {
    fontSize: 12,
    padding: "4px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  sourceToggle: { display: "flex", gap: 4, padding: "2px 0" },
  toggleBtn: {
    flex: 1,
    padding: "4px 8px",
    fontSize: 11,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "transparent",
    cursor: "pointer",
    color: "var(--qb-text-muted)",
  },
  toggleBtnActive: { background: "var(--qb-bg-surface)", color: "inherit" },
  btnPrimary: {
    padding: "4px 10px",
    fontSize: 12,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-elevated)",
    cursor: "pointer",
    color: "inherit",
  },
  btnGhost: {
    padding: "4px 10px",
    fontSize: 11,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "transparent",
    cursor: "pointer",
    color: "var(--qb-text-muted)",
  },
  list: { flex: 1, minHeight: 0, overflow: "auto" },
  listItem: {
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--qb-border-subtle)",
    cursor: "pointer",
    color: "inherit",
  },
  listItemActive: { background: "var(--qb-bg-elevated)" },
  listItemTop: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
  },
  listItemMeta: { fontSize: 10, color: "var(--qb-text-muted)", marginTop: 2 },
  detailHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  detailTitle: { fontSize: 14, fontWeight: 600 },
  detailMeta: { fontSize: 11, color: "var(--qb-text-muted)", marginTop: 4 },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(100px, 1fr))",
    gap: 6,
  },
  metric: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    padding: "8px 10px",
  },
  metricLabel: { fontSize: 10, color: "var(--qb-text-muted)" },
  metricValue: { fontSize: 13, fontWeight: 600, marginTop: 2 },
  chartWrap: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "8px 12px",
  },
  chartTitle: { fontSize: 11, color: "var(--qb-text-muted)", marginBottom: 4 },
  tradesList: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 10px" },
  tradeRow: {
    display: "grid",
    gridTemplateColumns: "auto auto 1fr auto auto",
    gap: 6,
    fontSize: 11,
    padding: "3px 0",
    borderBottom: "1px solid var(--qb-border-subtle)",
    alignItems: "center",
  },
  buy: { color: "var(--qb-success, #36ad6a)", fontWeight: 600 },
  sell: { color: "#c54040", fontWeight: 600 },
  tradeNum: {
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    textAlign: "right",
  },
  muted: { color: "var(--qb-text-muted)", fontSize: 11 },
  empty: {
    padding: "16px 12px",
    color: "var(--qb-text-muted)",
    fontSize: 12,
    textAlign: "center",
  },
  errorPanel: {
    padding: "8px 12px",
    color: "#c54040",
    fontSize: 12,
    border: "1px solid #c54040",
    borderRadius: 6,
  },
  toastErr: {
    position: "absolute",
    bottom: 8,
    left: 16,
    right: 16,
    padding: "6px 10px",
    border: "1px solid #c54040",
    borderRadius: 4,
    color: "#c54040",
    fontSize: 11,
    background: "var(--qb-bg-surface)",
  },
  toastInfo: {
    position: "absolute",
    bottom: 8,
    left: 16,
    right: 16,
    padding: "6px 10px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    fontSize: 11,
    background: "var(--qb-bg-elevated)",
  },
};
