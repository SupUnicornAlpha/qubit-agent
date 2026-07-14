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
  runWalkForwardEvaluation,
  type BacktestJobRecord,
  type BacktestSignalSpec,
  type StrategyCompositionRecord,
  type StrategyVersionFlatRecord,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";
import { pickColor, SvgLineChart, type ChartSeries } from "./charts/SvgLineChart";
import { LineageBadge, LineageTrail } from "./LineageBadge";
import { useAppStore } from "../../store";

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

  // 对比模式：多选历史任务在同一 equity 图叠加
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  /**
   * 消费 quantHandoff —— Discovery / Composer 切到这里时预填表单。
   * 仅在组件挂载时跑一次：消费后立即清空，避免重渲染时重复填表。
   */
  const handoff = useAppStore((s) => s.quantHandoff);
  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  useEffect(() => {
    if (!handoff) return;
    if (handoff.kind === "raw") {
      setSource("raw");
      setRawExpr(handoff.expr);
      setRawReverse(handoff.reverse ?? false);
      setInfo(`已预填 raw signal · ${handoff.note ?? "来自其他 tab"}`);
      setQuantHandoff(null);
    } else if (handoff.kind === "composition") {
      setSource("composition");
      setCompositionId(handoff.compositionId);
      setInfo(`已预选 composition · ${handoff.note ?? handoff.compositionId.slice(0, 8)}`);
      setQuantHandoff(null);
    }
    // factor-ids-to-composer 不属于 backtest 路径：不消费 / 不清空，留给 ComposerTab 接管。
  }, [handoff, setQuantHandoff]);

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

  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 比较任务 series
  const compareJobs = useMemo(
    () => jobs.filter((j) => compareIds.has(j.id) && j.result),
    [jobs, compareIds]
  );

  const compareEquitySeries = useMemo<ChartSeries[]>(() => {
    if (compareJobs.length === 0) return [];
    const out: ChartSeries[] = [];
    compareJobs.forEach((j, idx) => {
      const eq = j.result?.equityCurve ?? [];
      out.push({
        name: `${j.id.slice(0, 6)}… (${((j.result?.metrics.totalReturn ?? 0) * 100).toFixed(1)}%)`,
        color: pickColor(idx),
        points: eq.map((p) => ({ x: p.date, y: p.equity })),
      });
    });
    return out;
  }, [compareJobs]);

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
          `回测 ${job.status}：${job.result?.metrics.tradeCount ?? 0} 笔交易 · 总收益 ${((job.result?.metrics.totalReturn ?? 0) * 100).toFixed(2)}%`
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
    <div
      className="qb-quant-tab-root qb-quant-tab-root--backtest"
      data-qb-quant-tab="backtest"
      style={styles.root}
    >
      <aside className="qb-quant-col qb-quant-col--left" style={styles.colLeft}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>发起回测</strong>
        </div>
        <form onSubmit={onSubmit} className="qb-quant-form" style={styles.form}>
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
          <div className="qb-quant-toggle-bar" style={styles.sourceToggle}>
            <button
              type="button"
              onClick={() => setSource("composition")}
              className={`qb-quant-toggle-btn${source === "composition" ? " qb-quant-toggle-btn--active" : ""}`}
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
              className={`qb-quant-toggle-btn${source === "raw" ? " qb-quant-toggle-btn--active" : ""}`}
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
            className="qb-quant-btn qb-quant-btn--primary qb-quant-btn--run"
            style={styles.btnPrimary}
          >
            {busy ? "运行中…" : "Run Now"}
          </button>
        </form>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>历史任务</strong>
          <button
            type="button"
            onClick={() => setCompareMode((v) => !v)}
            className={`qb-quant-btn qb-quant-btn--ghost${compareMode ? " qb-quant-btn--ghost-active" : ""}`}
            style={{
              ...styles.btnGhost,
              ...(compareMode ? { background: "var(--qb-bg-elevated)", color: "inherit" } : null),
            }}
          >
            {compareMode ? `对比中 (${compareIds.size})` : "对比模式"}
          </button>
        </div>
        <div className="qb-quant-list" style={styles.list}>
          {jobs.length === 0 ? (
            <div className="qb-quant-empty" style={styles.empty}>
              暂无任务
            </div>
          ) : null}
          {jobs.map((j) => (
            <div
              key={j.id}
              className={`qb-quant-list-item${j.id === selectedId ? " qb-quant-list-item--active" : ""}`}
              data-qb-quant-status={j.status}
              style={{
                ...styles.listItem,
                ...(j.id === selectedId ? styles.listItemActive : null),
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {compareMode ? (
                <input
                  type="checkbox"
                  checked={compareIds.has(j.id)}
                  onChange={() => toggleCompare(j.id)}
                  onClick={(e) => e.stopPropagation()}
                  disabled={!j.result}
                  title={j.result ? "加入对比" : "任务无结果不可对比"}
                  style={{ flexShrink: 0 }}
                />
              ) : null}
              <button
                type="button"
                onClick={() => setSelectedId(j.id)}
                style={{
                  flex: 1,
                  background: "transparent",
                  border: "none",
                  textAlign: "left",
                  cursor: "pointer",
                  color: "inherit",
                  padding: 0,
                }}
              >
                <div className="qb-quant-list-item-top" style={styles.listItemTop}>
                  <span style={{ display: "flex", alignItems: "center" }}>
                    <span className="qb-quant-status-dot" data-status={j.status} aria-hidden />
                    <span
                      className="qb-quant-status-tag"
                      data-qb-quant-status={j.status}
                      style={{ color: STATUS_TONES[j.status], fontWeight: 600 }}
                    >
                      {j.status}
                    </span>
                  </span>
                  <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    <LineageBadge createdBy={j.createdBy ?? "user"} size="small" />
                    {j.result ? (
                      <strong
                        style={{
                          color:
                            j.result.metrics.totalReturn >= 0
                              ? "var(--qb-success)"
                              : "var(--qb-error)",
                          fontFamily: "var(--qb-font-mono)",
                          fontVariantNumeric: "tabular-nums",
                          fontSize: 11,
                        }}
                      >
                        {(j.result.metrics.totalReturn * 100).toFixed(2)}%
                      </strong>
                    ) : (
                      <span className="qb-quant-muted" style={styles.muted}>
                        —
                      </span>
                    )}
                  </span>
                </div>
                <div className="qb-quant-list-item-meta" style={styles.listItemMeta}>
                  {j.engineKey} · {new Date(j.startedAt).toLocaleString()}
                </div>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="qb-quant-col qb-quant-col--mid" style={styles.colMid}>
        {compareMode && compareJobs.length >= 2 ? (
          <CompareView jobs={compareJobs} equitySeries={compareEquitySeries} />
        ) : selected ? (
          <BacktestResultView job={selected} onRefresh={reloadSelected} />
        ) : (
          <div className="qb-quant-empty" style={styles.empty}>
            左侧选择历史任务或新建回测。
          </div>
        )}
      </section>

      <aside className="qb-quant-col qb-quant-col--right" style={styles.colRight}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>Trades</strong>
          <span className="qb-quant-muted" style={styles.muted}>
            {selected?.result?.trades.length ?? 0}
          </span>
        </div>
        <div className="qb-quant-trades-list" style={styles.tradesList}>
          {(selected?.result?.trades ?? []).slice(0, 200).map((t, i) => (
            <div
              key={i}
              className="qb-quant-trade-row"
              data-qb-quant-side={t.side}
              style={styles.tradeRow}
            >
              <span className="qb-quant-muted" style={styles.muted}>
                {t.date}
              </span>
              <span
                className={
                  t.side === "buy"
                    ? "qb-quant-side qb-quant-side--buy"
                    : "qb-quant-side qb-quant-side--sell"
                }
                style={t.side === "buy" ? styles.buy : styles.sell}
              >
                {t.side}
              </span>
              <span>{t.symbol}</span>
              <span className="qb-quant-num" style={styles.tradeNum}>
                {t.qty.toFixed(4)}
              </span>
              <span className="qb-quant-num" style={styles.tradeNum}>
                ${t.price.toFixed(2)}
              </span>
            </div>
          ))}
          {(selected?.result?.trades.length ?? 0) === 0 ? (
            <div className="qb-quant-empty" style={styles.empty}>
              —
            </div>
          ) : null}
        </div>
      </aside>

      {error ? (
        <div className="qb-quant-toast qb-quant-toast--err" style={styles.toastErr}>
          {error}
        </div>
      ) : null}
      {info ? (
        <div className="qb-quant-toast qb-quant-toast--info" style={styles.toastInfo}>
          {info}
        </div>
      ) : null}
    </div>
  );
};

const BacktestResultView: FC<{ job: BacktestJobRecord; onRefresh: () => Promise<void> }> = ({
  job,
  onRefresh,
}) => {
  const m = job.result?.metrics;
  const equity = job.result?.equityCurve ?? [];
  const [walkForward, setWalkForward] = useState<Awaited<
    ReturnType<typeof runWalkForwardEvaluation>
  > | null>(null);
  const [walkForwardBusy, setWalkForwardBusy] = useState(false);
  const [walkForwardError, setWalkForwardError] = useState<string | null>(null);
  const [walkForwardFolds, setWalkForwardFolds] = useState(3);
  const [walkForwardPurgeDays, setWalkForwardPurgeDays] = useState(5);

  const runWalkForward = async () => {
    setWalkForwardBusy(true);
    setWalkForwardError(null);
    try {
      setWalkForward(
        await runWalkForwardEvaluation(job.id, {
          folds: walkForwardFolds,
          purgeDays: walkForwardPurgeDays,
        })
      );
    } catch (error) {
      setWalkForwardError(error instanceof Error ? error.message : "walk_forward_failed");
    } finally {
      setWalkForwardBusy(false);
    }
  };

  const equitySeries = useMemo<ChartSeries[]>(() => {
    if (equity.length === 0) return [];
    const hasBench = equity.some(
      (p) => typeof p.benchmarkEquity === "number" && Number.isFinite(p.benchmarkEquity)
    );
    const series: ChartSeries[] = [
      {
        name: "Strategy",
        color: "var(--qb-success, #36ad6a)",
        points: equity.map((p) => ({ x: p.date, y: p.equity })),
      },
    ];
    if (hasBench) {
      series.push({
        name: "Benchmark",
        color: "#94a3b8",
        dashed: true,
        points: equity.map((p) => ({ x: p.date, y: p.benchmarkEquity ?? null })),
      });
    }
    return series;
  }, [equity]);

  return (
    <>
      <div
        className="qb-quant-hero-card"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div className="qb-quant-detail-header" style={styles.detailHeader}>
          <div>
            <div
              className="qb-quant-detail-title"
              style={{ ...styles.detailTitle, display: "flex", alignItems: "center", gap: 8 }}
            >
              <span className="qb-quant-status-dot" data-status={job.status} aria-hidden />
              <span
                className="qb-quant-status-tag"
                data-qb-quant-status={job.status}
                style={{ color: STATUS_TONES[job.status] }}
              >
                {job.status.toUpperCase()}
              </span>{" "}
              · {job.engineKey}
              <LineageBadge createdBy={job.createdBy ?? "user"} size="normal" />
            </div>
            <div className="qb-quant-detail-meta" style={styles.detailMeta}>
              {job.config.startDate} ~ {job.config.endDate} · capital=${job.config.capital} ·{" "}
              {job.config.symbols.length} symbols · rebalance={job.config.rebalance ?? "daily"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label className="qb-quant-detail-meta" style={styles.detailMeta}>
              折数
              <input
                type="number"
                min={2}
                max={8}
                value={walkForwardFolds}
                onChange={(event) => setWalkForwardFolds(Number(event.target.value))}
                style={{ width: 48, marginLeft: 4 }}
              />
            </label>
            <label className="qb-quant-detail-meta" style={styles.detailMeta}>
              Purge
              <input
                type="number"
                min={0}
                max={30}
                value={walkForwardPurgeDays}
                onChange={(event) => setWalkForwardPurgeDays(Number(event.target.value))}
                style={{ width: 48, marginLeft: 4 }}
              />
            </label>
            <button
              type="button"
              onClick={onRefresh}
              className="qb-quant-btn qb-quant-btn--ghost"
              style={styles.btnGhost}
            >
              刷新
            </button>
            <button
              type="button"
              onClick={() => void runWalkForward()}
              disabled={walkForwardBusy || job.status !== "completed"}
              className="qb-quant-btn qb-quant-btn--primary"
            >
              {walkForwardBusy ? "OOS 评估中…" : "运行 Walk-forward"}
            </button>
          </div>
        </div>
        <LineageTrail kind="backtest_run" id={job.id} />
      </div>
      {job.result?.error ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {job.result.error}
        </div>
      ) : null}
      {job.evaluation ? (
        <div
          className="qb-quant-hero-card"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div>
              <strong>策略晋级 Gate</strong>
              <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                成本后指标 · 可复现规则 · 未通过时不得直接进入 live
              </div>
            </div>
            <span
              className="qb-quant-status-tag"
              style={{
                color: job.evaluation.pass
                  ? "var(--qb-success, #36ad6a)"
                  : "var(--qb-warning, #d99a32)",
              }}
            >
              {job.evaluation.pass ? "BACKTEST PASSED" : "RESEARCH ONLY"}
            </span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 8,
            }}
          >
            {job.evaluation.checks.map((check) => (
              <div
                key={check.key}
                style={{ padding: 10, borderRadius: 8, background: "rgba(255,255,255,.025)" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{check.label}</span>
                  <strong
                    style={{
                      color: check.pass
                        ? "var(--qb-success, #36ad6a)"
                        : "var(--qb-danger, #dc5d62)",
                    }}
                  >
                    {check.pass ? "通过" : "未通过"}
                  </strong>
                </div>
                <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                  {check.value.toFixed(3)} {check.operator} {check.threshold}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {walkForwardError ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {walkForwardError}
        </div>
      ) : null}
      {walkForward ? (
        <div
          className="qb-quant-hero-card"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <strong>Walk-forward / OOS</strong>
              <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                扩展训练窗 · {walkForward.folds[0]?.purgeDays ?? 0} 日 purge · 独立测试折 · regime
                稳定性
              </div>
            </div>
            <strong
              style={{
                color: walkForward.pass
                  ? "var(--qb-success, #36ad6a)"
                  : "var(--qb-warning, #d99a32)",
              }}
            >
              {walkForward.pass ? "PASSED" : "NOT STABLE"}
            </strong>
          </div>
          <div className="qb-quant-metrics-grid" style={styles.metricsGrid}>
            <Metric
              label="OOS 复合收益"
              value={walkForward.aggregate.compoundedOosReturn}
              pct
              tone="emerald"
              signed
            />
            <Metric
              label="平均 Sharpe"
              value={walkForward.aggregate.averageSharpe}
              tone="indigo"
              signed
            />
            <Metric
              label="最差回撤"
              value={walkForward.aggregate.worstMaxDrawdown}
              pct
              tone="amber"
            />
            <Metric
              label="正收益折占比"
              value={walkForward.aggregate.positiveFoldRate}
              pct
              tone="cyan"
            />
            <Metric
              label="Regime 稳定性"
              value={walkForward.aggregate.regimeStability}
              pct
              tone="pink"
            />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 8,
            }}
          >
            {walkForward.folds.map((fold) => (
              <div
                key={fold.fold}
                style={{ padding: 10, borderRadius: 8, background: "rgba(255,255,255,.025)" }}
              >
                <strong>
                  Fold {fold.fold} · {fold.regime}
                </strong>
                <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                  Train {fold.trainStart}–{fold.trainEnd}
                  <br />
                  Test {fold.testStart}–{fold.testEnd}
                  <br />
                  Return {(fold.metrics.totalReturn * 100).toFixed(2)}% · Sharpe{" "}
                  {fold.metrics.sharpe.toFixed(2)}
                  <br />
                  Regime source: {fold.regimeSource}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {m ? (
        <div className="qb-quant-metrics-grid" style={styles.metricsGrid}>
          <Metric
            label="总收益"
            value={m.totalReturn}
            pct
            tone="emerald"
            highlight={m.totalReturn !== 0}
            signed
          />
          <Metric label="年化收益" value={m.annualReturn} pct tone="emerald" signed />
          <Metric label="年化波动" value={m.annualVol} pct tone="cyan" />
          <Metric label="Sharpe" value={m.sharpe} tone="indigo" signed />
          <Metric label="最大回撤" value={m.maxDrawdown} pct tone="amber" />
          <Metric label="胜率" value={m.winRate} pct tone="pink" />
          <Metric label="交易笔数" value={m.tradeCount} digits={0} tone="cyan" />
          <Metric label="换手率" value={m.turnover} tone="indigo" />
        </div>
      ) : null}
      {equitySeries.length > 0 ? (
        <SvgLineChart
          title="Equity Curve"
          series={equitySeries}
          baseline={job.config.capital}
          yFormatter={(v) => v.toFixed(0)}
        />
      ) : null}
    </>
  );
};

/** 多回测对比视图：equity 叠加 + metrics 横向对比 */
const CompareView: FC<{ jobs: BacktestJobRecord[]; equitySeries: ChartSeries[] }> = ({
  jobs,
  equitySeries,
}) => {
  return (
    <>
      <div className="qb-quant-detail-header" style={styles.detailHeader}>
        <div>
          <div className="qb-quant-detail-title" style={styles.detailTitle}>
            对比模式 — {jobs.length} 个回测同图
          </div>
          <div className="qb-quant-detail-meta" style={styles.detailMeta}>
            勾选左侧任务加入或移除；至少 2 个才会显示对比图
          </div>
        </div>
      </div>
      {equitySeries.length > 0 ? (
        <SvgLineChart
          title="Equity Curves (overlay)"
          series={equitySeries}
          yFormatter={(v) => v.toFixed(0)}
        />
      ) : null}
      <div className="qb-quant-table-wrap" style={styles.tableWrap}>
        <table className="qb-quant-table qb-quant-table--compare" style={styles.compTable}>
          <thead>
            <tr>
              <th style={styles.th}>Job</th>
              <th style={styles.thNum}>总收益</th>
              <th style={styles.thNum}>年化</th>
              <th style={styles.thNum}>波动</th>
              <th style={styles.thNum}>Sharpe</th>
              <th style={styles.thNum}>MDD</th>
              <th style={styles.thNum}>胜率</th>
              <th style={styles.thNum}>笔数</th>
              <th style={styles.thNum}>换手</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const m = j.result!.metrics;
              return (
                <tr key={j.id}>
                  <td style={styles.tdMono}>{j.id.slice(0, 8)}…</td>
                  <td style={styles.tdNum}>{(m.totalReturn * 100).toFixed(2)}%</td>
                  <td style={styles.tdNum}>{(m.annualReturn * 100).toFixed(2)}%</td>
                  <td style={styles.tdNum}>{(m.annualVol * 100).toFixed(2)}%</td>
                  <td style={styles.tdNum}>{m.sharpe.toFixed(2)}</td>
                  <td style={styles.tdNum}>{(m.maxDrawdown * 100).toFixed(2)}%</td>
                  <td style={styles.tdNum}>{(m.winRate * 100).toFixed(2)}%</td>
                  <td style={styles.tdNum}>{m.tradeCount}</td>
                  <td style={styles.tdNum}>{m.turnover.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

const TONE_COLOR: Record<string, string> = {
  emerald: "var(--qb-quant-accent-5)",
  cyan: "var(--qb-quant-accent-2)",
  indigo: "var(--qb-quant-accent-1)",
  amber: "var(--qb-quant-accent-3)",
  pink: "var(--qb-quant-accent-4)",
};

const Metric: FC<{
  label: string;
  value: number;
  pct?: boolean;
  digits?: number;
  tone?: keyof typeof TONE_COLOR;
  /** signed=true 时按正/负染色为绿/红，覆盖 tone */
  signed?: boolean;
  highlight?: boolean;
}> = ({ label, value, pct = false, digits = 4, tone, signed = false, highlight = false }) => {
  const dotColor = signed
    ? value >= 0
      ? "var(--qb-success)"
      : "var(--qb-error)"
    : tone
      ? TONE_COLOR[tone]
      : "var(--qb-quant-accent-1)";
  const valueColor = signed
    ? value > 0
      ? "var(--qb-success)"
      : value < 0
        ? "var(--qb-error)"
        : "var(--qb-text-strong)"
    : "var(--qb-text-strong)";
  if (!Number.isFinite(value)) {
    return (
      <div className="qb-quant-metric" style={{ ...styles.metric, position: "relative" }}>
        <span
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor,
            opacity: 0.6,
          }}
        />
        <div className="qb-quant-metric-label" style={styles.metricLabel}>
          {label}
        </div>
        <div className="qb-quant-metric-value" style={styles.metricValue}>
          —
        </div>
      </div>
    );
  }
  const text = pct ? `${(value * 100).toFixed(2)}%` : value.toFixed(digits);
  return (
    <div
      className="qb-quant-metric"
      style={{
        ...styles.metric,
        position: "relative",
        borderColor: highlight
          ? `color-mix(in srgb, ${dotColor} 50%, var(--qb-border-subtle))`
          : undefined,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          width: 6,
          height: 6,
          borderRadius: 999,
          background: dotColor,
          boxShadow: `0 0 0 3px color-mix(in srgb, ${dotColor} 22%, transparent)`,
        }}
      />
      <div className="qb-quant-metric-label" style={styles.metricLabel}>
        {label}
      </div>
      <div className="qb-quant-metric-value" style={{ ...styles.metricValue, color: valueColor }}>
        {text}
      </div>
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
  compTable: { width: "100%", borderCollapse: "collapse", fontSize: 11 },
  tableWrap: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    overflow: "auto",
  },
  th: {
    textAlign: "left",
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
    position: "sticky",
    top: 0,
  },
  thNum: {
    textAlign: "right",
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
    position: "sticky",
    top: 0,
  },
  tdMono: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
  },
  tdNum: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    textAlign: "right",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
  },
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
