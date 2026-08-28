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

import type { CSSProperties, FC, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getBacktestJob,
  listStrategyCompositions,
  runBacktestJobNow,
  createMarketSnapshot,
  runWalkForwardEvaluation,
  runSensitivityAnalysis,
  runMonteCarloSimulation,
  runPitAudit,
  type BacktestJobRecord,
  type BacktestMetricsDto,
  type BacktestSignalSpec,
  type StrategyCompositionRecord,
  type StrategyVersionFlatRecord,
  type SensitivityAnalysisDto,
  type MonteCarloSimulationDto,
  type PitAuditReportDto,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";
import {
  fetchQuantBacktestJobs,
  fetchQuantStrategyVersions,
} from "../../lib/quantListScope";
import { pickColor, SvgLineChart, type ChartSeries } from "./charts/SvgLineChart";
import { LineageBadge, LineageTrail } from "./LineageBadge";
import { GenomeEvolutionPanel } from "./GenomeEvolutionPanel";
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
  const {
    projectId,
    defaultProjectId,
    listProjectFilter,
    lineageFilter,
    listScopeKey,
    scopeAllProjects,
    scopeProjectId,
    loading: projectLoading,
    error: projectError,
  } = useDefaultProject();

  const [versions, setVersions] = useState<StrategyVersionFlatRecord[]>([]);
  const [versionId, setVersionId] = useState<string>("");
  const [compositions, setCompositions] = useState<StrategyCompositionRecord[]>([]);
  const [compositionId, setCompositionId] = useState<string>("");

  const [source, setSource] = useState<Source>("composition");
  const [rawExpr, setRawExpr] = useState("Mean($close, 20) - Mean($close, 60)");
  const [rawReverse, setRawReverse] = useState(false);

  const [symbols, setSymbols] = useState("AAPL,MSFT,GOOG");
  // 默认以 SPY 衡量美股组合的市场暴露；留空即可只计算绝对收益指标。
  const [benchmark, setBenchmark] = useState("SPY");
  const [startDate, setStartDate] = useState("2026-01-01");
  const [endDate, setEndDate] = useState("2026-04-30");
  const [capital, setCapital] = useState(100_000);
  const [commissionBps, setCommissionBps] = useState(5);
  const [slippageBps, setSlippageBps] = useState(5);
  const [slippageModel, setSlippageModel] = useState<
    "fixed_bps" | "square_root" | "volatility_adjusted"
  >("fixed_bps");
  const [borrowRateBps, setBorrowRateBps] = useState<number>(0);
  const [maxVolumeParticipation, setMaxVolumeParticipation] = useState<number>(0);
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
   * 消费 quantHandoff —— Discovery / Composer / 研究产出 切到这里时预填表单。
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
      if (handoff.strategyVersionId) setVersionId(handoff.strategyVersionId);
      setCompositionId(handoff.compositionId);
      setInfo(`已预选 composition · ${handoff.note ?? handoff.compositionId.slice(0, 8)}`);
      setQuantHandoff(null);
    } else if (handoff.kind === "strategy-version-to-backtest") {
      setSource("composition");
      setVersionId(handoff.strategyVersionId);
      if (handoff.compositionId) setCompositionId(handoff.compositionId);
      setInfo(`已打开策略版本 · ${handoff.note ?? handoff.strategyVersionId.slice(0, 8)}`);
      setQuantHandoff(null);
    } else if (handoff.kind === "backtest-job") {
      setSelectedId(handoff.jobId);
      setInfo(`已打开回测 · ${handoff.note ?? handoff.jobId.slice(0, 8)}`);
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
    if (projectLoading) return;
    try {
      const rows = await fetchQuantStrategyVersions(listProjectFilter, lineageFilter);
      setVersions(rows);
      if (!versionId && rows.length > 0) setVersionId(rows[0]!.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectLoading, listScopeKey, versionId]);

  const reloadCompositions = useCallback(async () => {
    if (!versionId) {
      setCompositions([]);
      setCompositionId("");
      return;
    }
    try {
      const rows = await listStrategyCompositions(versionId);
      setCompositions(rows);
      setCompositionId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows[0]?.id ?? "";
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [versionId]);

  const reloadJobs = useCallback(async () => {
    if (projectLoading) return;
    try {
      const rows = await fetchQuantBacktestJobs(listProjectFilter, lineageFilter);
      setJobs(rows);
      setSelectedId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectLoading, listScopeKey]);

  useEffect(() => {
    void reloadVersions();
  }, [reloadVersions]);

  useEffect(() => {
    void reloadCompositions();
  }, [reloadCompositions]);

  useEffect(() => {
    if (projectLoading) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchQuantBacktestJobs(listProjectFilter, lineageFilter);
        if (cancelled) return;
        setJobs(rows);
        setSelectedId((prev) => {
          if (prev && rows.some((r) => r.id === prev)) return prev;
          return rows[0]?.id ?? null;
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectLoading, listProjectFilter, lineageFilter]);

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

  /** List API strips equityCurve; compare mode loads full jobs on demand. */
  const [compareFullJobs, setCompareFullJobs] = useState<BacktestJobRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    const ids = Array.from(compareIds);
    if (ids.length === 0) {
      setCompareFullJobs([]);
      return;
    }
    void (async () => {
      const rows = await Promise.all(ids.map((id) => getBacktestJob(id).catch(() => null)));
      if (!cancelled) {
        setCompareFullJobs(rows.filter((j): j is BacktestJobRecord => Boolean(j)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareIds]);

  const compareEquitySeries = useMemo<ChartSeries[]>(() => {
    if (compareFullJobs.length === 0) return [];
    const out: ChartSeries[] = [];
    compareFullJobs.forEach((j, idx) => {
      const eqRaw = j.result?.equityCurve;
      const eq = Array.isArray(eqRaw) ? eqRaw : [];
      out.push({
        name: `${j.id.slice(0, 6)}… (${((j.result?.metrics?.totalReturn ?? 0) * 100).toFixed(1)}%)`,
        color: pickColor(idx),
        points: eq.map((p) => ({ x: p.date, y: p.equity })),
      });
    });
    return out;
  }, [compareFullJobs]);

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
        const benchmarkSymbol = benchmark.trim().toUpperCase();
        const snapshotSymbols = [
          ...new Set([...symbolsList, ...(benchmarkSymbol ? [benchmarkSymbol] : [])]),
        ];
        const rangeDays = Math.max(
          1,
          Math.ceil(
            (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
          )
        );
        const dataset = await createMarketSnapshot({
          symbols: snapshotSymbols,
          asOf: `${endDate}T23:59:59.999Z`,
          timeframe: "1d",
          // 交易日缓冲；超过当前快照上限时由服务端明确拒绝覆盖不足的提交。
          limit: Math.min(500, Math.ceil(rangeDays * 1.55) + 10),
          purpose: "backtest",
        });
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
          datasetSnapshotId: dataset.snapshotId,
          startDate,
          endDate,
          capital,
          costs: {
            commissionBps,
            slippageBps,
            slippageModel,
            borrowRateAnnualBps: borrowRateBps > 0 ? borrowRateBps : undefined,
            maxVolumeParticipation: maxVolumeParticipation > 0 ? maxVolumeParticipation : undefined,
          },
          // UI does not optimize parameters during this run; freeze the chosen
          // values so walk-forward can audit parameter-selection timing.
          experiment: { parameterSelection: "fixed_before_run", candidateTrials: 1 },
          rebalance,
          ...(benchmarkSymbol ? { benchmark: benchmarkSymbol } : {}),
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
      benchmark,
      topN,
      reloadJobs,
    ]
  );

  if (projectLoading) {
    return <div style={styles.empty}>加载 project…</div>;
  }
  if (projectError) {
    return <div style={styles.errorPanel}>项目加载失败：{projectError}</div>;
  }
  if (!scopeAllProjects && !scopeProjectId) {
    return <div style={styles.empty}>未找到所选 project，请切换数据范围。</div>;
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
          <label style={styles.formLabel}>
            基准（用于 Alpha / Beta）
            <input
              type="text"
              value={benchmark}
              onChange={(e) => setBenchmark(e.target.value)}
              placeholder="SPY；留空则不计算相对指标"
              style={styles.input}
            />
            <span style={styles.formHelp}>
              美股组合通常使用 SPY；输入可用行情标的，留空仅计算绝对收益。
            </span>
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
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              滑点冲击模型
              <select
                value={slippageModel}
                onChange={(e) => setSlippageModel(e.target.value as any)}
                style={styles.select}
              >
                <option value="fixed_bps">固定基点 (Fixed)</option>
                <option value="square_root">平方根冲击 (Square-Root)</option>
                <option value="volatility_adjusted">波动率自适应 (Vol-Adjusted)</option>
              </select>
            </label>
            <label style={styles.formLabel}>
              融券年利率 (Bps)
              <input
                type="number"
                min={0}
                value={borrowRateBps}
                onChange={(e) => setBorrowRateBps(Number.parseFloat(e.target.value) || 0)}
                placeholder="0 (无融券利息)"
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              最大参与率 (0~1)
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={maxVolumeParticipation}
                onChange={(e) => setMaxVolumeParticipation(Number.parseFloat(e.target.value) || 0)}
                placeholder="0 (不限)"
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
        {compareMode && compareFullJobs.length >= 2 ? (
          <CompareView jobs={compareFullJobs} equitySeries={compareEquitySeries} />
        ) : selected ? (
          <BacktestResultView
            job={selected}
            projectId={projectId ?? defaultProjectId ?? ""}
            onRefresh={reloadSelected}
          />
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
            {Array.isArray(selected?.result?.trades) ? selected.result.trades.length : 0}
          </span>
        </div>
        <div className="qb-quant-trades-list" style={styles.tradesList}>
          {(Array.isArray(selected?.result?.trades) ? selected.result.trades : [])
            .slice(0, 200)
            .map((t, i) => (
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
          {(Array.isArray(selected?.result?.trades) ? selected.result.trades.length : 0) === 0 ? (
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

type BacktestCalloutTone = "info" | "pass" | "warn" | "fail";

const BacktestCallout: FC<{ tone: BacktestCalloutTone; label: string; children: ReactNode }> = ({
  tone,
  label,
  children,
}) => (
  <div className="qb-bt-callout" data-tone={tone}>
    <span className="qb-bt-callout-label">{label}</span>
    <div className="qb-bt-callout-body">{children}</div>
  </div>
);

const BacktestKpi: FC<{
  label: string;
  value: number;
  pct?: boolean;
  digits?: number;
  signed?: boolean;
}> = ({ label, value, pct = false, digits = 4, signed = false }) => {
  if (!Number.isFinite(value)) {
    return (
      <div className="qb-bt-kpi" data-tone="neutral">
        <span className="qb-bt-kpi-label">{label}</span>
        <span className="qb-bt-kpi-value">—</span>
      </div>
    );
  }
  const text = pct ? `${(value * 100).toFixed(2)}%` : value.toFixed(digits);
  const tone = signed ? (value > 0 ? "positive" : value < 0 ? "negative" : "neutral") : "accent";
  const signAttr = signed ? (value > 0 ? "pos" : value < 0 ? "neg" : undefined) : undefined;
  return (
    <div className="qb-bt-kpi" data-tone={tone}>
      <span className="qb-bt-kpi-label">{label}</span>
      <span className="qb-bt-kpi-value" {...(signAttr ? { "data-sign": signAttr } : {})}>
        {text}
      </span>
    </div>
  );
};

const BacktestResultView: FC<{
  job: BacktestJobRecord;
  projectId: string;
  onRefresh: () => Promise<void>;
}> = ({ job, projectId, onRefresh }) => {
  const m = job.result?.metrics;
  const equityRaw = job.result?.equityCurve;
  const equity = Array.isArray(equityRaw) ? equityRaw : [];

  const [activeAnalysisTab, setActiveAnalysisTab] = useState<
    "walk_forward" | "sensitivity" | "monte_carlo" | "pit_audit"
  >("walk_forward");

  const [walkForward, setWalkForward] = useState<Awaited<
    ReturnType<typeof runWalkForwardEvaluation>
  > | null>(null);
  const [walkForwardBusy, setWalkForwardBusy] = useState(false);
  const [walkForwardError, setWalkForwardError] = useState<string | null>(null);
  const walkForwardFolds = 3;
  const walkForwardPurgeDays = 5;
  const walkForwardEmbargoDays = 5;
  const [walkForwardTune, setWalkForwardTune] = useState(false);

  const [sensitivity, setSensitivity] = useState<SensitivityAnalysisDto | null>(null);
  const [sensitivityBusy, setSensitivityBusy] = useState(false);
  const [sensitivityError, setSensitivityError] = useState<string | null>(null);

  const [monteCarlo, setMonteCarlo] = useState<MonteCarloSimulationDto | null>(null);
  const [monteCarloBusy, setMonteCarloBusy] = useState(false);
  const [monteCarloError, setMonteCarloError] = useState<string | null>(null);

  const [pitAudit, setPitAudit] = useState<PitAuditReportDto | null>(null);
  const [pitAuditBusy, setPitAuditBusy] = useState(false);
  const [pitAuditError, setPitAuditError] = useState<string | null>(null);

  const runWalkForward = async () => {
    setWalkForwardBusy(true);
    setWalkForwardError(null);
    try {
      const maxTopN = Math.max(1, job.config.symbols.length);
      const baseTopN = Math.max(1, Math.min(maxTopN, job.config.topN ?? Math.min(5, maxTopN)));
      const topNCandidates = Array.from(new Set([1, baseTopN, Math.min(maxTopN, baseTopN + 2)]));
      const parameterCandidates = topNCandidates.flatMap((candidateTopN) =>
        (["daily", "weekly", "monthly"] as const).map((candidateRebalance) => ({
          topN: candidateTopN,
          rebalance: candidateRebalance,
          longShort: job.config.longShort ?? false,
        }))
      );
      setWalkForward(
        await runWalkForwardEvaluation(job.id, {
          folds: walkForwardFolds,
          purgeDays: walkForwardPurgeDays,
          embargoDays: walkForwardEmbargoDays,
          ...(walkForwardTune
            ? {
                selection: {
                  objective: "sharpe",
                  candidates: parameterCandidates,
                },
              }
            : {}),
        })
      );
      setActiveAnalysisTab("walk_forward");
    } catch (error) {
      setWalkForwardError(error instanceof Error ? error.message : "walk_forward_failed");
    } finally {
      setWalkForwardBusy(false);
    }
  };

  const runSensitivity = async () => {
    setSensitivityBusy(true);
    setSensitivityError(null);
    try {
      const data = await runSensitivityAnalysis(job.id);
      setSensitivity(data);
      setActiveAnalysisTab("sensitivity");
    } catch (error) {
      setSensitivityError(error instanceof Error ? error.message : "sensitivity_analysis_failed");
    } finally {
      setSensitivityBusy(false);
    }
  };

  const runMonteCarlo = async () => {
    setMonteCarloBusy(true);
    setMonteCarloError(null);
    try {
      const data = await runMonteCarloSimulation(job.id, {
        simulations: 500,
        blockSize: 5,
      });
      setMonteCarlo(data);
      setActiveAnalysisTab("monte_carlo");
    } catch (error) {
      setMonteCarloError(error instanceof Error ? error.message : "monte_carlo_failed");
    } finally {
      setMonteCarloBusy(false);
    }
  };

  const runAudit = async () => {
    setPitAuditBusy(true);
    setPitAuditError(null);
    try {
      const data = await runPitAudit(job.id);
      setPitAudit(data);
      setActiveAnalysisTab("pit_audit");
    } catch (error) {
      setPitAuditError(error instanceof Error ? error.message : "pit_audit_failed");
    } finally {
      setPitAuditBusy(false);
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

  const mcSeries = useMemo<ChartSeries[]>(() => {
    if (!monteCarlo || monteCarlo.simulatedPathsSummary.length === 0) return [];
    return [
      {
        name: "95% 优选路径 (P95)",
        color: "#10b981",
        points: monteCarlo.simulatedPathsSummary.map((p) => ({ x: p.date, y: p.p95Best })),
      },
      {
        name: "中位数基线 (Median)",
        color: "#38bdf8",
        points: monteCarlo.simulatedPathsSummary.map((p) => ({ x: p.date, y: p.median })),
      },
      {
        name: "5% 极限最坏路径 (P5)",
        color: "#f43f5e",
        dashed: true,
        points: monteCarlo.simulatedPathsSummary.map((p) => ({ x: p.date, y: p.p5Worst })),
      },
    ];
  }, [monteCarlo]);

  return (
    <>
      <div className="qb-bt-report">
        <header className="qb-bt-report-header">
          <div className="qb-bt-report-header-top">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="qb-bt-report-identity">
                <span className="qb-bt-status" data-status={job.status}>
                  <span className="qb-quant-status-dot" data-status={job.status} aria-hidden />
                  {job.status.toUpperCase()}
                </span>
                <h3 className="qb-bt-engine">{job.engineKey}</h3>
                <LineageBadge createdBy={job.createdBy ?? "user"} size="normal" />
              </div>
              <div className="qb-bt-report-meta">
                <strong>{job.config.startDate}</strong> — <strong>{job.config.endDate}</strong>
                {" · "}
                <span title={job.config.symbols.join(", ") || "无标的"}>
                  {job.config.symbols.length > 0 ? job.config.symbols.join(" · ") : "无标的"}
                </span>
                {" · "}
                资金 <strong>${job.config.capital.toLocaleString()}</strong>
                {" · "}
                调仓 <strong>{job.config.rebalance ?? "daily"}</strong>
                {job.config.costs?.slippageModel && job.config.costs.slippageModel !== "fixed_bps"
                  ? ` · 冲击 ${job.config.costs.slippageModel}`
                  : ""}
              </div>
            </div>
          </div>
          <LineageTrail kind="backtest_run" id={job.id} />
          <div className="qb-bt-toolbar" role="toolbar" aria-label="回测分析工具">
            <span className="qb-bt-toolbar-label">分析</span>
            <button type="button" onClick={onRefresh} className="qb-bt-tool-btn">
              刷新
            </button>
            <button
              type="button"
              onClick={() => void runWalkForward()}
              disabled={walkForwardBusy || job.status !== "completed"}
              className={`qb-bt-tool-btn${activeAnalysisTab === "walk_forward" ? " is-active" : ""}`}
            >
              {walkForwardBusy ? "OOS 评估中…" : "Walk-Forward"}
            </button>
            <button
              type="button"
              onClick={() => void runSensitivity()}
              disabled={sensitivityBusy || job.status !== "completed"}
              className={`qb-bt-tool-btn${activeAnalysisTab === "sensitivity" ? " is-active" : ""}`}
            >
              {sensitivityBusy ? "扫描中…" : "敏感性"}
            </button>
            <button
              type="button"
              onClick={() => void runMonteCarlo()}
              disabled={monteCarloBusy || job.status !== "completed"}
              className={`qb-bt-tool-btn${activeAnalysisTab === "monte_carlo" ? " is-active" : ""}`}
            >
              {monteCarloBusy ? "模拟中…" : "Monte Carlo"}
            </button>
            <button
              type="button"
              onClick={() => void runAudit()}
              disabled={pitAuditBusy || job.status !== "completed"}
              className={`qb-bt-tool-btn${activeAnalysisTab === "pit_audit" ? " is-active" : ""}`}
            >
              {pitAuditBusy ? "审计中…" : "PIT 审计"}
            </button>
            <label
              className="qb-bt-toolbar-opt"
              title="仅在每折训练区间比较候选，冻结赢家后进入该折 OOS"
            >
              <input
                type="checkbox"
                checked={walkForwardTune}
                onChange={(event) => setWalkForwardTune(event.target.checked)}
                disabled={walkForwardBusy}
              />
              训练窗选参
            </label>
          </div>
        </header>
        {job.result?.meta.datasetQualification ||
        job.result?.meta.antiLeakageReport ||
        job.result?.meta.statisticalValidationReport ||
        job.result?.meta.assetLifecycleReport ? (
          <div className="qb-bt-callouts">
            {job.result?.meta.datasetQualification ? (
              <BacktestCallout tone="warn" label="数据资格">
                {job.result.meta.datasetQualification.useClass === "research_only"
                  ? "研究级数据集，不能直接晋级实盘"
                  : "策略验证级数据集"}
                {job.result.meta.datasetQualification.limitations.length > 0
                  ? ` · ${job.result.meta.datasetQualification.limitations.join("、")}`
                  : ""}
              </BacktestCallout>
            ) : null}
            {job.result?.meta.antiLeakageReport ? (
              <BacktestCallout
                tone={job.result.meta.antiLeakageReport.status === "passed" ? "pass" : "warn"}
                label="Anti-leakage"
              >
                {job.result.meta.antiLeakageReport.status}
                {job.result.meta.antiLeakageReport.failedChecks.length > 0
                  ? ` · failed: ${job.result.meta.antiLeakageReport.failedChecks.join(", ")}`
                  : ""}
                {job.result.meta.antiLeakageReport.unknownChecks.length > 0
                  ? ` · unknown: ${job.result.meta.antiLeakageReport.unknownChecks.join(", ")}`
                  : ""}
              </BacktestCallout>
            ) : null}
            {job.result?.meta.statisticalValidationReport ? (
              <BacktestCallout
                tone={
                  job.result.meta.statisticalValidationReport.status === "passed" ? "pass" : "warn"
                }
                label="统计置信"
              >
                {job.result.meta.statisticalValidationReport.status}
                {job.result.meta.statisticalValidationReport.sharpeConfidenceInterval
                  ? ` · Sharpe CI [${job.result.meta.statisticalValidationReport.sharpeConfidenceInterval.lower.toFixed(2)}, ${job.result.meta.statisticalValidationReport.sharpeConfidenceInterval.upper.toFixed(2)}]`
                  : " · CI unavailable"}
                {` · trials ${job.result.meta.statisticalValidationReport.candidateTrials ?? "unknown"}`}
                {job.result.meta.statisticalValidationReport.bonferroniAdjustedPValue != null
                  ? ` · adjusted p ${job.result.meta.statisticalValidationReport.bonferroniAdjustedPValue.toFixed(4)}`
                  : ""}
                {job.result.meta.statisticalValidationReport.deflatedSharpe
                  ? ` · DSR ${(job.result.meta.statisticalValidationReport.deflatedSharpe.probability * 100).toFixed(1)}%`
                  : " · DSR unavailable"}
              </BacktestCallout>
            ) : null}
            {job.result?.meta.assetLifecycleReport ? (
              <BacktestCallout
                tone={job.result.meta.assetLifecycleReport.status === "passed" ? "pass" : "warn"}
                label="资产生命周期"
              >
                {job.result.meta.assetLifecycleReport.status}
                {job.result.meta.assetLifecycleReport.assetClasses.length > 0
                  ? ` · ${job.result.meta.assetLifecycleReport.assetClasses.join(" / ")}`
                  : ""}
                {Array.isArray(job.result.meta.assetLifecycleEvents) &&
                job.result.meta.assetLifecycleEvents.length > 0
                  ? ` · ${job.result.meta.assetLifecycleEvents.length} events (${job.result.meta.assetLifecycleEvents
                      .slice(-3)
                      .map((event) => event.kind)
                      .join(", ")})`
                  : ""}
                {job.result.meta.assetLifecycleReport.limitations.length > 0
                  ? ` · ${job.result.meta.assetLifecycleReport.limitations.join("、")}`
                  : ""}
              </BacktestCallout>
            ) : null}
          </div>
        ) : null}
      </div>
      {job.result?.error ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {job.result.error}
        </div>
      ) : null}
      {walkForwardError ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {walkForwardError}
        </div>
      ) : null}
      {sensitivityError ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {sensitivityError}
        </div>
      ) : null}
      {monteCarloError ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {monteCarloError}
        </div>
      ) : null}
      {pitAuditError ? (
        <div className="qb-quant-error-panel" style={styles.errorPanel}>
          {pitAuditError}
        </div>
      ) : null}

      {/* 参数敏感性热力图展示 */}
      {sensitivity ? (
        <div
          className="qb-quant-hero-card"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>参数敏感性热力图 (Parameter Sensitivity Heatmap)</strong>
              <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                {sensitivity.xDimension.label} × {sensitivity.yDimension.label} 网格扫描 ·{" "}
                {sensitivity.meta.totalEvaluations} 次评估
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span
                className="qb-quant-status-tag"
                style={{
                  color: sensitivity.parameterCliffDetected ? "#f43f5e" : "#10b981",
                  border: "1px solid currentColor",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                }}
              >
                {sensitivity.parameterCliffDetected
                  ? "参数悬崖警示 (过拟合风险)"
                  : "参数平原稳健 (Plateau)"}
              </span>
              <span className="qb-quant-detail-meta" style={styles.detailMeta}>
                稳健度: {(sensitivity.stabilityScore * 100).toFixed(1)}%
              </span>
            </div>
          </div>

          <div
            style={{
              padding: "8px 10px",
              border: "1px solid rgba(245, 158, 11, 0.45)",
              color: "#f59e0b",
              fontSize: 11,
            }}
          >
            RESEARCH ONLY · 全窗口网格选择存在选择偏差。先冻结候选参数，再运行独立的 purged OOS
            验证。
          </div>

          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 11,
                textAlign: "center",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--qb-border, #333)",
                      color: "var(--qb-text-muted)",
                    }}
                  >
                    {sensitivity.yDimension.label} \ {sensitivity.xDimension.label}
                  </th>
                  {sensitivity.xDimension.values.map((xv, xi) => (
                    <th
                      key={xi}
                      style={{
                        padding: "6px 8px",
                        borderBottom: "1px solid var(--qb-border, #333)",
                      }}
                    >
                      {xv}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sensitivity.grid.map((row, yi) => (
                  <tr key={yi}>
                    <td
                      style={{
                        padding: "6px 8px",
                        fontWeight: "bold",
                        borderRight: "1px solid var(--qb-border, #333)",
                      }}
                    >
                      {sensitivity.yDimension.values[yi]}
                    </td>
                    {row.map((cell, xi) => {
                      const isOptimal =
                        cell.xValue === sensitivity.optimal.xValue &&
                        cell.yValue === sensitivity.optimal.yValue;
                      const sharpeVal = cell.sharpe;
                      const bgIntensity = Math.min(0.5, Math.max(0.05, Math.abs(sharpeVal) * 0.15));
                      const bgColor =
                        sharpeVal >= 0
                          ? `rgba(16, 185, 129, ${bgIntensity})`
                          : `rgba(244, 63, 94, ${bgIntensity})`;

                      return (
                        <td
                          key={xi}
                          style={{
                            padding: "6px 8px",
                            backgroundColor: bgColor,
                            border: isOptimal
                              ? "2px solid #38bdf8"
                              : "1px solid rgba(255,255,255,0.04)",
                            borderRadius: 4,
                          }}
                        >
                          <div style={{ fontWeight: isOptimal ? "bold" : "normal" }}>
                            Sharpe: {cell.sharpe.toFixed(2)}
                          </div>
                          <div style={{ fontSize: 10, opacity: 0.75 }}>
                            DD: {(cell.maxDrawdown * 100).toFixed(1)}%
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
            * 探索性候选（非验证结论）：{sensitivity.xDimension.label} ={" "}
            <strong>{sensitivity.optimal.xValue}</strong>，{sensitivity.yDimension.label} ={" "}
            <strong>{sensitivity.optimal.yValue}</strong>（最优 Sharpe:{" "}
            {sensitivity.optimal.metrics.sharpe.toFixed(2)}，最大回撤:{" "}
            {(sensitivity.optimal.metrics.maxDrawdown * 100).toFixed(1)}%）
          </div>
        </div>
      ) : null}

      {/* 蒙特卡洛压力测试展示 */}
      {monteCarlo ? (
        <div
          className="qb-quant-hero-card"
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>蒙特卡洛压力测试与重抽样 (Monte Carlo Stress Test)</strong>
              <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                Block Bootstrap {monteCarlo.simulationCount} 次模拟 · seed {monteCarlo.meta.seed} ·
                初始资金 ${monteCarlo.initialCapital}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span
                className="qb-quant-status-tag"
                style={{
                  color:
                    monteCarlo.drawdownRiskRating === "low"
                      ? "#10b981"
                      : monteCarlo.drawdownRiskRating === "moderate"
                        ? "#38bdf8"
                        : monteCarlo.drawdownRiskRating === "high"
                          ? "#f59e0b"
                          : "#f43f5e",
                  border: "1px solid currentColor",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                }}
              >
                风险评级: {monteCarlo.drawdownRiskRating.toUpperCase()}
              </span>
              <span className="qb-quant-detail-meta" style={styles.detailMeta}>
                破产概率: {(monteCarlo.probabilityOfRuin * 100).toFixed(2)}%
              </span>
            </div>
          </div>

          <div className="qb-quant-metrics-grid" style={styles.metricsGrid}>
            <Metric
              label="5% 极限最坏收益 (P5)"
              value={monteCarlo.metrics.totalReturnPercentiles.p5}
              pct
              tone="rose"
              signed
            />
            <Metric
              label="中位数预期收益 (P50)"
              value={monteCarlo.metrics.totalReturnPercentiles.median}
              pct
              tone="emerald"
              signed
            />
            <Metric
              label="95% 极端最大回撤 (P95)"
              value={monteCarlo.metrics.maxDrawdownPercentiles.p95}
              pct
              tone="amber"
            />
            <Metric
              label="中位数 Sharpe (P50)"
              value={monteCarlo.metrics.sharpePercentiles.median}
              tone="indigo"
              signed
            />
            <Metric label="压力稳健评分" value={monteCarlo.stressScore} pct tone="pink" />
          </div>

          {mcSeries.length > 0 ? (
            <SvgLineChart
              title="Monte Carlo Representative Pathways (P5 Worst / Median / P95 Best)"
              series={mcSeries}
              height={180}
            />
          ) : null}
        </div>
      ) : null}

      {/* PIT 数据防未来函数审计报告 */}
      {pitAudit ? (
        <div
          className="qb-quant-hero-card"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>Point-In-Time (PIT) 数据时序隔离与防未来函数审计</strong>
              <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                已审计 {pitAudit.totalBarsAudited} 根 Bar · 跨 {pitAudit.symbolCount} 标的 · AsOf
                边界: {pitAudit.asOfBoundary || "未设限"}
              </div>
            </div>
            <strong
              style={{
                color:
                  pitAudit.verdict === "point_in_time_clean"
                    ? "var(--qb-success, #36ad6a)"
                    : pitAudit.verdict === "point_in_time_degraded"
                      ? "var(--qb-warning, #d99a32)"
                      : "var(--qb-danger, #dc5d62)",
              }}
            >
              {pitAudit.verdict.toUpperCase().replace(/_/g, " ")}
            </strong>
          </div>
          <div className="qb-quant-metrics-grid" style={styles.metricsGrid}>
            <Metric
              label="前视偏差风险分"
              value={pitAudit.lookAheadRiskScore}
              tone={pitAudit.lookAheadRiskScore === 0 ? "emerald" : "rose"}
            />
            <Metric
              label="已校验 K 线总数"
              value={pitAudit.totalBarsAudited}
              digits={0}
              tone="cyan"
            />
            <Metric
              label="异常点数量"
              value={pitAudit.anomalyCount}
              digits={0}
              tone={pitAudit.anomalyCount === 0 ? "emerald" : "amber"}
            />
          </div>
          {pitAudit.recommendations.map((rec, ri) => (
            <div
              key={ri}
              style={{
                fontSize: 12,
                color: pitAudit.pass ? "#a7f3d0" : "#fca5a5",
                background: pitAudit.pass ? "rgba(16, 185, 129, 0.08)" : "rgba(244, 63, 94, 0.08)",
                padding: "6px 10px",
                borderRadius: 4,
              }}
            >
              • {rec}
            </div>
          ))}
        </div>
      ) : null}
      {job.evaluation ? (
        <section className="qb-bt-section qb-bt-gate">
          <header className="qb-bt-section-header">
            <div>
              <h4 className="qb-bt-section-title">策略晋级 Gate</h4>
              <div className="qb-bt-section-desc">
                成本后指标 · 可复现规则 · 未通过时不得直接进入 live
              </div>
            </div>
            <span className="qb-bt-verdict" data-pass={job.evaluation.pass ? "true" : "false"}>
              {job.evaluation.pass ? "BACKTEST PASSED" : "RESEARCH ONLY"}
            </span>
          </header>
          <div className="qb-bt-gate-grid">
            {job.evaluation.checks.map((check) => (
              <div key={check.key} className="qb-bt-gate-cell">
                <div className="qb-bt-gate-cell-head">
                  <span className="qb-bt-gate-label">{check.label}</span>
                  <span className="qb-bt-gate-verdict" data-pass={check.pass ? "true" : "false"}>
                    {check.pass ? "通过" : "未通过"}
                  </span>
                </div>
                <div className="qb-bt-gate-threshold">
                  {check.value.toFixed(3)} {check.operator} {check.threshold}
                </div>
              </div>
            ))}
          </div>
        </section>
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
                {walkForward.folds.some((fold) => fold.selection) ? "训练窗选参后冻结" : "固定参数"}{" "}
                · expanding-window 切分 · {walkForward.folds[0]?.purgeDays ?? 0} 日 purge +{" "}
                {walkForward.folds[0]?.embargoDays ?? 0} 日 embargo · 独立测试折 · regime 稳定性
              </div>
            </div>
            <strong
              style={{
                color: walkForward.pass
                  ? "var(--qb-success, #36ad6a)"
                  : "var(--qb-warning, #d99a32)",
              }}
            >
              {walkForward.pass
                ? "VALIDATED"
                : !walkForward.selectionIntegrityPass
                  ? "RESEARCH ONLY · TRAIN FAMILY TEST NOT PASSED"
                  : walkForward.performancePass
                    ? `RESEARCH ONLY · ${walkForward.integrityReport.status}/${walkForward.statisticalValidationReport.status}`
                    : "NOT STABLE"}
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
                  Isolation: purge {fold.purgeStart ?? "—"}–{fold.purgeEnd ?? "—"}; embargo{" "}
                  {fold.embargoStart ?? "—"}–{fold.embargoEnd ?? "—"}
                  <br />
                  Return {(fold.metrics.totalReturn * 100).toFixed(2)}% · Sharpe{" "}
                  {fold.metrics.sharpe.toFixed(2)}
                  <br />
                  {fold.selection ? (
                    <>
                      Selected: topN={fold.selection.selected.topN ?? "default"} ·{" "}
                      {fold.selection.selected.rebalance ?? "default"}
                      {" · "}train Sharpe {fold.selection.trainMetrics.sharpe.toFixed(2)} /{" "}
                      {fold.selection.candidateCount} candidates
                      <br />
                      FDR {fold.selection.selectedFdrPass ? "pass" : "not passed"} · discoveries{" "}
                      {fold.selection.falseDiscoveryRate.discoveryCount}/
                      {fold.selection.falseDiscoveryRate.hypothesisCount}
                      <br />
                      White RC {fold.selection.realityCheck.status} · p{" "}
                      {fold.selection.realityCheck.pValue?.toFixed(4) ?? "n/a"}
                      <br />
                    </>
                  ) : null}
                  Regime source: {fold.regimeSource}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {m ? (
        <section className="qb-bt-section qb-bt-kpi-section">
          <header className="qb-bt-section-header">
            <div>
              <h4 className="qb-bt-section-title">核心绩效指标</h4>
              <div className="qb-bt-section-desc">成本后净值 · 与 Gate 规则同源</div>
            </div>
          </header>
          <div className="qb-bt-kpi-grid">
            <BacktestKpi label="总收益" value={m.totalReturn} pct signed />
            <BacktestKpi label="年化收益" value={m.annualReturn} pct signed />
            <BacktestKpi label="年化波动" value={m.annualVol} pct />
            <BacktestKpi label="Sharpe" value={m.sharpe} signed />
            <BacktestKpi label="Sortino" value={m.sortino ?? Number.NaN} signed />
            <BacktestKpi label="Calmar" value={m.calmar ?? Number.NaN} signed />
            <BacktestKpi label="最大回撤" value={m.maxDrawdown} pct />
            <BacktestKpi label="胜率" value={m.winRate} pct />
            <BacktestKpi label="交易笔数" value={m.tradeCount} digits={0} />
            <BacktestKpi label="换手率" value={m.turnover} />
          </div>
        </section>
      ) : null}
      {m ? <PerformanceDiagnostics metrics={m} /> : null}
      {equitySeries.length > 0 ? (
        <SvgLineChart
          title="Equity Curve"
          series={equitySeries}
          baseline={job.config.capital}
          yFormatter={(v) => v.toFixed(0)}
        />
      ) : null}
      <GenomeEvolutionPanel projectId={projectId} />
    </>
  );
};

const PerformanceDiagnostics: FC<{ metrics: BacktestMetricsDto }> = ({ metrics }) => {
  const benchmark = metrics.benchmark;
  return (
    <section
      className="qb-quant-hero-card qb-quant-performance-diagnostics qb-bt-diagnostics qb-bt-section"
      style={styles.diagnostics}
    >
      <header className="qb-bt-section-header">
        <div>
          <h4 className="qb-bt-section-title">全维绩效画像</h4>
          <div className="qb-bt-section-desc">
            以成本后净值为准；用于判断回测是否具备继续验证和进入自进化的条件。
          </div>
        </div>
        <span className="qb-bt-report-meta">
          {benchmark
            ? `基准观测 ${benchmark.observations} 期`
            : "未配置基准 · 左侧填入 SPY 后重新回测"}
        </span>
      </header>
      <div className="qb-quant-performance-grid" style={styles.diagnosticColumns}>
        <DiagnosticGroup title="下行与尾部" description="比波动率更关注亏损形态">
          <DiagnosticValue label="下行波动" value={metrics.downsideDeviation} pct />
          <DiagnosticValue label="VaR 95%" value={metrics.valueAtRisk95} pct risk />
          <DiagnosticValue label="CVaR 95%" value={metrics.conditionalValueAtRisk95} pct risk />
          <DiagnosticValue label="Ulcer 指数" value={metrics.ulcerIndex} pct risk />
          <DiagnosticValue label="最长回撤期" value={metrics.maxDrawdownDuration} suffix=" 期" />
        </DiagnosticGroup>
        <DiagnosticGroup title="稳定性与执行" description="避免偶然收益和高成本策略">
          <DiagnosticValue label="正收益期占比" value={metrics.positivePeriodRate} pct />
          <DiagnosticValue
            label="最大连亏期"
            value={metrics.maxConsecutiveLosses}
            suffix=" 期"
            risk
          />
          <DiagnosticValue label="累计佣金" value={metrics.totalCommission} prefix="$" digits={2} />
          <DiagnosticValue label="收益偏度" value={metrics.returnSkewness} signed />
          <DiagnosticValue label="超额峰度" value={metrics.excessKurtosis} signed />
        </DiagnosticGroup>
        <DiagnosticGroup title="相对基准" description="区分市场 Beta 与真正的 Alpha">
          <DiagnosticValue label="年化 Alpha" value={benchmark?.alpha} pct signed />
          <DiagnosticValue label="Beta" value={benchmark?.beta} digits={2} />
          <DiagnosticValue label="信息比率" value={benchmark?.informationRatio} signed />
          <DiagnosticValue label="跟踪误差" value={benchmark?.trackingError} pct />
          <DiagnosticValue label="相关性" value={benchmark?.correlation} digits={2} />
          <DiagnosticValue
            label="上 / 下行捕获"
            composite={[benchmark?.upCapture, benchmark?.downCapture]}
          />
        </DiagnosticGroup>
      </div>
    </section>
  );
};

const DiagnosticGroup: FC<{ title: string; description: string; children: ReactNode }> = ({
  title,
  description,
  children,
}) => (
  <div className="qb-quant-performance-group qb-bt-diag-group">
    <div className="qb-bt-diag-group-title">{title}</div>
    <div className="qb-bt-diag-group-desc">{description}</div>
    <div className="qb-bt-diag-list">{children}</div>
  </div>
);

const DiagnosticValue: FC<{
  label: string;
  value?: number | null;
  composite?: [number | null | undefined, number | null | undefined];
  pct?: boolean;
  digits?: number;
  prefix?: string;
  suffix?: string;
  signed?: boolean;
  risk?: boolean;
}> = ({
  label,
  value,
  composite,
  pct = false,
  digits = 3,
  prefix = "",
  suffix = "",
  signed = false,
  risk = false,
}) => {
  const text = composite
    ? composite.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? `${composite[0]?.toFixed(2) ?? "—"} / ${composite[1]?.toFixed(2) ?? "—"}`
      : "—"
    : typeof value === "number" && Number.isFinite(value)
      ? `${prefix}${pct ? `${(value * 100).toFixed(2)}%` : value.toFixed(digits)}${suffix}`
      : "—";
  const tone =
    signed && typeof value === "number" && value !== 0
      ? value > 0
        ? "var(--qb-success, #36ad6a)"
        : "var(--qb-danger, #dc5d62)"
      : risk
        ? "var(--qb-warning, #d99a32)"
        : "var(--qb-text-strong)";
  return (
    <div className="qb-bt-diag-row">
      <span className="qb-bt-diag-label">{label}</span>
      <strong className="qb-bt-diag-value" style={{ color: tone }}>
        {text}
      </strong>
    </div>
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
    overflow: "auto",
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
  formHelp: { fontSize: 10, lineHeight: 1.35, color: "var(--qb-text-muted)" },
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
  list: { flex: "0 0 auto", minHeight: 120 },
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
  diagnostics: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    height: "auto",
    minHeight: "max-content",
    maxHeight: "none",
    alignSelf: "stretch",
  },
  diagnosticsHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  diagnosticColumns: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 205px), 1fr))",
    gap: 14,
    alignItems: "start",
  },
  diagnosticGroup: {
    borderLeft: "2px solid var(--qb-border-subtle)",
    paddingLeft: 10,
    minWidth: 0,
  },
  diagnosticGroupTitle: { fontSize: 11, fontWeight: 650 },
  diagnosticGroupDescription: { color: "var(--qb-text-muted)", fontSize: 10, marginTop: 2 },
  diagnosticList: { display: "flex", flexDirection: "column", marginTop: 7, gap: 4 },
  diagnosticValue: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 11,
    color: "var(--qb-text-muted)",
  },
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
