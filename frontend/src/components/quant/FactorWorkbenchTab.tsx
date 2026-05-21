/**
 * FactorWorkbenchTab — 因子工坊
 *
 * 三栏布局：
 *   左：因子列表（带 status / category 过滤）+ 注册按钮
 *   中：选中因子详情（表达式 / lang / horizon / 状态 / lineage）+ 操作
 *        - compute（跑表达式 → 写入 DuckDB）
 *        - auto-evaluate（取因子值 + 价格未来收益 → IC/IR/Decay/Group/Turnover）
 *        - values 预览（最近 N 条 / 按区间）
 *   右：评估历史（factor_evaluation 行）
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  autoEvaluateFactor,
  computeFactor,
  factorValuesStats,
  getFactor,
  listFactorEvaluations,
  listFactors,
  loadFactorValues,
  registerFactor,
  setFactorStatus,
  type FactorCategory,
  type FactorEvalResultDto,
  type FactorEvaluationLogRow,
  type FactorLang,
  type FactorRecord,
  type FactorStatus,
  type FactorValueRow,
  type FactorValueStats,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";
import { pickColor, SvgLineChart, type ChartSeries } from "./charts/SvgLineChart";

const CATEGORY_LABELS: Record<FactorCategory, string> = {
  value: "Value",
  momentum: "Momentum",
  volatility: "Volatility",
  news: "News",
  quality: "Quality",
  macro: "Macro",
};

const STATUS_LABELS: Record<FactorStatus, string> = {
  draft: "草稿",
  active: "启用",
  archived: "归档",
};

const STATUS_TONES: Record<FactorStatus, string> = {
  draft: "var(--qb-text-muted)",
  active: "var(--qb-success, #36ad6a)",
  archived: "#a4654c",
};

interface RegisterFormState {
  name: string;
  category: FactorCategory;
  expr: string;
  lang: FactorLang;
  universe: string;
  horizon: number;
}

const INITIAL_FORM: RegisterFormState = {
  name: "",
  category: "momentum",
  expr: "Mean($close, 20) - Mean($close, 60)",
  lang: "qlib_expr",
  universe: "default",
  horizon: 5,
};

const DEFAULT_SYMBOLS = "AAPL,MSFT,GOOG";

export const FactorWorkbenchTab: FC = () => {
  const { projectId, loading: projectLoading, error: projectError } = useDefaultProject();

  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [filterCategory, setFilterCategory] = useState<FactorCategory | "all">("all");
  const [filterStatus, setFilterStatus] = useState<FactorStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<FactorRecord | null>(null);
  const [evaluations, setEvaluations] = useState<FactorEvaluationLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // operations
  const [opStart, setOpStart] = useState("2026-01-01");
  const [opEnd, setOpEnd] = useState("2026-04-30");
  const [opSymbols, setOpSymbols] = useState(DEFAULT_SYMBOLS);
  const [opHorizon, setOpHorizon] = useState(5);
  const [opGroups, setOpGroups] = useState(5);

  // register form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<RegisterFormState>({ ...INITIAL_FORM });

  // preview values
  const [valuePreview, setValuePreview] = useState<FactorValueRow[]>([]);
  const [valueStats, setValueStats] = useState<FactorValueStats | null>(null);

  // last evaluation result
  const [lastEval, setLastEval] = useState<FactorEvalResultDto | null>(null);

  // 对比模式：多选因子在 IC 时序图上叠加
  const [compareIds, setCompareIds] = useState<Set<string>>(new Set());
  const [compareEvalsByFactor, setCompareEvalsByFactor] = useState<
    Record<string, FactorEvaluationLogRow[]>
  >({});

  const reloadList = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await listFactors({
        projectId,
        category: filterCategory === "all" ? undefined : filterCategory,
        status: filterStatus === "all" ? undefined : filterStatus,
      });
      setFactors(rows);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0]!.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectId, filterCategory, filterStatus, selectedId]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  const reloadSelected = useCallback(async () => {
    if (!selectedId) {
      setSelected(null);
      setEvaluations([]);
      setValueStats(null);
      return;
    }
    try {
      const [rec, evals, stats] = await Promise.all([
        getFactor(selectedId),
        listFactorEvaluations(selectedId, 20),
        factorValuesStats(selectedId).catch(() => null),
      ]);
      setSelected(rec);
      setEvaluations(evals);
      setValueStats(stats);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadSelected();
  }, [reloadSelected]);

  const filtered = factors;

  const symbolsList = useMemo(
    () =>
      opSymbols
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [opSymbols]
  );

  const onSubmitRegister = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!projectId) return;
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const rec = await registerFactor({
          projectId,
          name: form.name.trim(),
          category: form.category,
          expr: form.expr.trim(),
          lang: form.lang,
          universe: form.universe.trim() || "default",
          horizon: form.horizon,
          status: "draft",
        });
        setInfo(`已注册因子 ${rec.name}（${rec.id.slice(0, 8)}…）`);
        setShowForm(false);
        setForm({ ...INITIAL_FORM });
        await reloadList();
        setSelectedId(rec.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [projectId, form, reloadList]
  );

  const onCompute = useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await computeFactor(selectedId, {
        startDate: opStart,
        endDate: opEnd,
        symbols: symbolsList.length > 0 ? symbolsList : undefined,
      });
      setInfo(`compute 完成：写入 ${r.meta.rowCount} 行 (耗时 ${r.meta.latencyMs}ms)`);
      const fresh = await loadFactorValues(selectedId, { latestN: 30 });
      setValuePreview(fresh);
      const stats = await factorValuesStats(selectedId).catch(() => null);
      setValueStats(stats);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [selectedId, opStart, opEnd, symbolsList]);

  const onAutoEvaluate = useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    setLastEval(null);
    try {
      const r = await autoEvaluateFactor(selectedId, {
        startDate: opStart,
        endDate: opEnd,
        symbols: symbolsList.length > 0 ? symbolsList : undefined,
        horizonDays: opHorizon,
        groupCount: opGroups,
        decayHorizons: [1, 3, 5, 10, 20],
      });
      setLastEval(r);
      setInfo(`评估完成：IC=${r.ic.toFixed(4)} RankIC=${r.rankIc.toFixed(4)} IR=${r.ir.toFixed(4)}`);
      const evals = await listFactorEvaluations(selectedId, 20);
      setEvaluations(evals);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [selectedId, opStart, opEnd, symbolsList, opHorizon, opGroups]);

  const onLoadValues = useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await loadFactorValues(selectedId, {
        symbols: symbolsList.length > 0 ? symbolsList : undefined,
        startDate: opStart,
        endDate: opEnd,
        latestN: 80,
      });
      setValuePreview(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [selectedId, symbolsList, opStart, opEnd]);

  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 拉取对比组的评估历史
  useEffect(() => {
    if (compareIds.size === 0) {
      setCompareEvalsByFactor({});
      return;
    }
    let cancelled = false;
    (async () => {
      const idsArr = Array.from(compareIds);
      try {
        const results = await Promise.all(
          idsArr.map((id) =>
            listFactorEvaluations(id, 60)
              .then((rows) => ({ id, rows }))
              .catch(() => ({ id, rows: [] as FactorEvaluationLogRow[] }))
          )
        );
        if (cancelled) return;
        const next: Record<string, FactorEvaluationLogRow[]> = {};
        for (const r of results) next[r.id] = r.rows;
        setCompareEvalsByFactor(next);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareIds]);

  // 单因子 IC 时序图
  const singleICSeries = useMemo<ChartSeries[]>(() => {
    if (!selected || evaluations.length === 0) return [];
    const sorted = [...evaluations].sort((a, b) => a.asof.localeCompare(b.asof));
    return [
      {
        name: `${selected.name} · IC`,
        color: pickColor(0),
        points: sorted.map((e) => ({ x: e.asof, y: e.ic ?? null })),
      },
      {
        name: `${selected.name} · RankIC`,
        color: pickColor(1),
        points: sorted.map((e) => ({ x: e.asof, y: e.rankIc ?? null })),
        dashed: true,
      },
    ];
  }, [selected, evaluations]);

  // 多因子 IC 对比时序图
  const compareSeries = useMemo<ChartSeries[]>(() => {
    const out: ChartSeries[] = [];
    let i = 0;
    for (const f of factors) {
      if (!compareIds.has(f.id)) continue;
      const rows = (compareEvalsByFactor[f.id] ?? []).slice().sort((a, b) =>
        a.asof.localeCompare(b.asof)
      );
      if (rows.length === 0) continue;
      out.push({
        name: f.name,
        color: pickColor(i),
        points: rows.map((e) => ({ x: e.asof, y: e.ic ?? null })),
      });
      i += 1;
    }
    return out;
  }, [factors, compareIds, compareEvalsByFactor]);

  const onToggleStatus = useCallback(
    async (next: FactorStatus) => {
      if (!selected) return;
      setBusy(true);
      setError(null);
      try {
        await setFactorStatus(selected.id, next);
        await reloadList();
        await reloadSelected();
        setInfo(`已切换状态为 ${STATUS_LABELS[next]}`);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [selected, reloadList, reloadSelected]
  );

  if (projectLoading) {
    return <div style={styles.empty}>加载默认 project…</div>;
  }
  if (projectError) {
    return <div style={styles.errorPanel}>项目加载失败：{projectError}</div>;
  }
  if (!projectId) {
    return <div style={styles.empty}>未找到默认 project，请先在「研究工作台」初始化。</div>;
  }

  return (
    <div className="qb-quant-tab-root qb-quant-tab-root--factor" data-qb-quant-tab="factor" style={styles.root}>
      <aside className="qb-quant-col qb-quant-col--left" style={styles.colLeft}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>因子列表</strong>
          <button type="button" onClick={() => setShowForm((s) => !s)} className="qb-quant-btn qb-quant-btn--primary" style={styles.btnPrimary}>
            {showForm ? "取消" : "+ 注册"}
          </button>
        </div>
        <div className="qb-quant-filter-row" style={styles.filterRow}>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value as FactorCategory | "all")}
            style={styles.select}
          >
            <option value="all">分类: 全部</option>
            {(Object.keys(CATEGORY_LABELS) as FactorCategory[]).map((k) => (
              <option key={k} value={k}>
                {CATEGORY_LABELS[k]}
              </option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as FactorStatus | "all")}
            style={styles.select}
          >
            <option value="all">状态: 全部</option>
            {(Object.keys(STATUS_LABELS) as FactorStatus[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {showForm ? (
          <form onSubmit={onSubmitRegister} className="qb-quant-form" style={styles.form}>
            <label style={styles.formLabel}>
              名称
              <input
                required
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              表达式
              <textarea
                required
                value={form.expr}
                onChange={(e) => setForm({ ...form, expr: e.target.value })}
                rows={3}
                style={styles.textarea}
              />
            </label>
            <div style={styles.formRow}>
              <label style={styles.formLabel}>
                分类
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value as FactorCategory })}
                  style={styles.select}
                >
                  {(Object.keys(CATEGORY_LABELS) as FactorCategory[]).map((k) => (
                    <option key={k} value={k}>
                      {CATEGORY_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label style={styles.formLabel}>
                语言
                <select
                  value={form.lang}
                  onChange={(e) => setForm({ ...form, lang: e.target.value as FactorLang })}
                  style={styles.select}
                >
                  <option value="qlib_expr">qlib_expr</option>
                  <option value="python">python</option>
                  <option value="sql">sql</option>
                  <option value="jsonlogic">jsonlogic</option>
                </select>
              </label>
            </div>
            <div style={styles.formRow}>
              <label style={styles.formLabel}>
                Universe
                <input
                  type="text"
                  value={form.universe}
                  onChange={(e) => setForm({ ...form, universe: e.target.value })}
                  style={styles.input}
                />
              </label>
              <label style={styles.formLabel}>
                Horizon
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={form.horizon}
                  onChange={(e) =>
                    setForm({ ...form, horizon: Number.parseInt(e.target.value, 10) || 5 })
                  }
                  style={styles.input}
                />
              </label>
            </div>
            <button type="submit" disabled={busy} className="qb-quant-btn qb-quant-btn--primary" style={styles.btnPrimary}>
              提交
            </button>
          </form>
        ) : null}
        <div className="qb-quant-list" style={styles.list}>
          {filtered.length === 0 ? (
            <div className="qb-quant-empty" style={styles.empty}>暂无因子，点击右上「+ 注册」新增。</div>
          ) : null}
          {filtered.map((f) => (
            <div
              key={f.id}
              className={`qb-quant-list-item${f.id === selectedId ? " qb-quant-list-item--active" : ""}`}
              data-qb-quant-status={f.status}
              style={{
                ...styles.listItem,
                ...(f.id === selectedId ? styles.listItemActive : null),
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <input
                type="checkbox"
                checked={compareIds.has(f.id)}
                onChange={() => toggleCompare(f.id)}
                onClick={(e) => e.stopPropagation()}
                title="加入对比"
                style={{ flexShrink: 0 }}
              />
              <button
                type="button"
                onClick={() => setSelectedId(f.id)}
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
                <div className="qb-quant-list-item-title" style={styles.listItemTitle}>{f.name}</div>
                <div className="qb-quant-list-item-meta" style={styles.listItemMeta}>
                  <span className="qb-quant-status-tag" data-qb-quant-status={f.status} style={{ color: STATUS_TONES[f.status] }}>{STATUS_LABELS[f.status]}</span>
                  <span> · {CATEGORY_LABELS[f.category]}</span>
                  <span> · {f.lang}</span>
                </div>
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="qb-quant-col qb-quant-col--mid" style={styles.colMid}>
        {selected ? (
          <>
            <div className="qb-quant-detail-header" style={styles.detailHeader}>
              <div>
                <div className="qb-quant-detail-title" style={styles.detailTitle}>{selected.name}</div>
                <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                  {CATEGORY_LABELS[selected.category]} · {selected.lang} · horizon={selected.horizon}
                  {" · "}
                  provider={selected.providerKey}
                </div>
              </div>
              <div className="qb-quant-status-actions" style={styles.statusActions}>
                {(Object.keys(STATUS_LABELS) as FactorStatus[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy || selected.status === s}
                    onClick={() => onToggleStatus(s)}
                    className={`qb-quant-btn qb-quant-btn--ghost${selected.status === s ? " qb-quant-btn--ghost-active" : ""}`}
                    data-qb-quant-status={s}
                    style={{
                      ...styles.btnGhost,
                      ...(selected.status === s ? styles.btnGhostActive : null),
                    }}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
            </div>
            <pre className="qb-quant-expr-box" style={styles.exprBox}>{selected.expr}</pre>

            <div className="qb-quant-op-panel" style={styles.opPanel}>
              <strong>操作</strong>
              <div style={styles.opRow}>
                <label style={styles.formLabel}>
                  起
                  <input
                    type="date"
                    value={opStart}
                    onChange={(e) => setOpStart(e.target.value)}
                    style={styles.input}
                  />
                </label>
                <label style={styles.formLabel}>
                  止
                  <input
                    type="date"
                    value={opEnd}
                    onChange={(e) => setOpEnd(e.target.value)}
                    style={styles.input}
                  />
                </label>
                <label style={{ ...styles.formLabel, flex: 1 }}>
                  Symbols
                  <input
                    type="text"
                    value={opSymbols}
                    onChange={(e) => setOpSymbols(e.target.value)}
                    placeholder="AAPL,MSFT,GOOG"
                    style={styles.input}
                  />
                </label>
              </div>
              <div style={styles.opRow}>
                <label style={styles.formLabel}>
                  Horizon
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={opHorizon}
                    onChange={(e) => setOpHorizon(Number.parseInt(e.target.value, 10) || 5)}
                    style={styles.input}
                  />
                </label>
                <label style={styles.formLabel}>
                  Groups
                  <input
                    type="number"
                    min={2}
                    max={20}
                    value={opGroups}
                    onChange={(e) => setOpGroups(Number.parseInt(e.target.value, 10) || 5)}
                    style={styles.input}
                  />
                </label>
                <div className="qb-quant-op-btn-row" style={styles.opBtnRow}>
                  <button type="button" disabled={busy} onClick={onCompute} className="qb-quant-btn qb-quant-btn--primary" style={styles.btnPrimary}>
                    Compute
                  </button>
                  <button type="button" disabled={busy} onClick={onAutoEvaluate} className="qb-quant-btn qb-quant-btn--primary" style={styles.btnPrimary}>
                    Auto-Evaluate
                  </button>
                  <button type="button" disabled={busy} onClick={onLoadValues} className="qb-quant-btn qb-quant-btn--ghost" style={styles.btnGhost}>
                    Load Values
                  </button>
                </div>
              </div>
            </div>

            {lastEval ? (
              <div className="qb-quant-eval-panel" style={styles.evalPanel}>
                <strong>最近一次评估</strong>
                <div className="qb-quant-eval-grid" style={styles.evalGrid}>
                  <MetricCell label="IC" value={lastEval.ic} />
                  <MetricCell label="RankIC" value={lastEval.rankIc} />
                  <MetricCell label="IR" value={lastEval.ir} />
                  <MetricCell label="Turnover" value={lastEval.turnover} />
                  <MetricCell label="N" value={lastEval.sampleSize} digits={0} />
                  <MetricCell label="延迟ms" value={lastEval.latencyMs} digits={0} />
                </div>
                {lastEval.decayCurve.length > 0 ? (
                  <div style={styles.evalSub}>
                    <span style={styles.subTitle}>Decay Curve</span>
                    <span style={styles.subBody}>
                      {lastEval.decayCurve.map((v, i) => (
                        <span key={i} style={styles.numCell}>
                          {v.toFixed(4)}
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
                {lastEval.groupReturns.length > 0 ? (
                  <div style={styles.evalSub}>
                    <span style={styles.subTitle}>Group Returns</span>
                    <span style={styles.subBody}>
                      {lastEval.groupReturns.map((v, i) => (
                        <span key={i} style={styles.numCell}>
                          G{i + 1}: {(v * 100).toFixed(2)}%
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
                {lastEval.error ? (
                  <div className="qb-quant-error-panel" style={styles.errorPanel}>评估警告：{lastEval.error}</div>
                ) : null}
              </div>
            ) : null}

            {singleICSeries.length > 0 ? (
              <SvgLineChart
                title="评估历史 — IC / RankIC 时序"
                series={singleICSeries}
                baseline={0}
                yFormatter={(v) => v.toFixed(3)}
              />
            ) : null}

            {compareSeries.length > 0 ? (
              <SvgLineChart
                title={`对比模式 — 多因子 IC 时序（${compareSeries.length} factors）`}
                series={compareSeries}
                baseline={0}
                height={200}
                yFormatter={(v) => v.toFixed(3)}
              />
            ) : null}

            {valueStats ? (
              <div className="qb-quant-stats-bar" style={styles.statsBar}>
                <span>已写入 {valueStats.rowCount} 行</span>
                <span> · {valueStats.symbolCount} symbols</span>
                <span>
                  {" "}
                  · {valueStats.minDate ?? "—"} ~ {valueStats.maxDate ?? "—"}
                </span>
              </div>
            ) : null}

            {valuePreview.length > 0 ? (
              <div className="qb-quant-table-wrap" style={styles.tableWrap}>
                <table className="qb-quant-table" style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Date</th>
                      <th style={styles.th}>Symbol</th>
                      <th style={styles.th}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuePreview.slice(0, 60).map((r, i) => (
                      <tr key={`${r.date}_${r.symbol}_${i}`}>
                        <td style={styles.td}>{r.date}</td>
                        <td style={styles.td}>{r.symbol}</td>
                        <td style={styles.td}>{r.value === null ? "—" : r.value.toFixed(6)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <div className="qb-quant-empty" style={styles.empty}>左侧选择或注册一个因子。</div>
        )}
      </section>

      <aside className="qb-quant-col qb-quant-col--right" style={styles.colRight}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>评估历史</strong>
          <span className="qb-quant-muted" style={styles.muted}>{evaluations.length} 条</span>
        </div>
        <div className="qb-quant-eval-list" style={styles.evalList}>
          {evaluations.length === 0 ? <div className="qb-quant-empty" style={styles.empty}>暂无</div> : null}
          {evaluations.map((e) => (
            <div key={e.id} className="qb-quant-eval-row" style={styles.evalRow}>
              <div className="qb-quant-eval-row-top" style={styles.evalRowTop}>
                <span className="qb-quant-muted" style={styles.muted}>{e.asof}</span>
                <span className="qb-quant-muted" style={styles.muted}>n={e.sampleSize}</span>
              </div>
              <div className="qb-quant-eval-row-mid" style={styles.evalRowMid}>
                <span>IC {(e.ic ?? 0).toFixed(4)}</span>
                <span>RankIC {(e.rankIc ?? 0).toFixed(4)}</span>
                <span>IR {(e.ir ?? 0).toFixed(4)}</span>
              </div>
              {e.error ? <div className="qb-quant-eval-err" style={styles.evalErr}>{e.error}</div> : null}
            </div>
          ))}
        </div>
      </aside>

      {error ? <div className="qb-quant-toast qb-quant-toast--err" style={styles.toastErr}>{error}</div> : null}
      {info ? <div className="qb-quant-toast qb-quant-toast--info" style={styles.toastInfo}>{info}</div> : null}
    </div>
  );
};

const MetricCell: FC<{ label: string; value: number; digits?: number }> = ({
  label,
  value,
  digits = 4,
}) => (
  <div className="qb-quant-metric" style={styles.metric}>
    <div className="qb-quant-metric-label" style={styles.metricLabel}>{label}</div>
    <div className="qb-quant-metric-value" style={styles.metricValue}>
      {Number.isFinite(value) ? value.toFixed(digits) : "—"}
    </div>
  </div>
);

const styles: Record<string, CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, 320px) 1fr minmax(220px, 280px)",
    gap: 0,
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
  filterRow: {
    flex: "0 0 auto",
    display: "flex",
    gap: 6,
    padding: "6px 10px 8px",
    borderBottom: "1px solid var(--qb-border-subtle)",
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
  listItemTitle: { fontSize: 12, fontWeight: 600 },
  listItemMeta: { fontSize: 10, color: "var(--qb-text-muted)", marginTop: 2 },
  detailHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },
  detailTitle: { fontSize: 14, fontWeight: 600 },
  detailMeta: { fontSize: 11, color: "var(--qb-text-muted)", marginTop: 4 },
  statusActions: { display: "flex", gap: 4 },
  exprBox: {
    background: "var(--qb-bg-elevated)",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "8px 10px",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    fontSize: 11,
    whiteSpace: "pre-wrap",
    overflow: "auto",
  },
  opPanel: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  opRow: { display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" },
  opBtnRow: { display: "flex", gap: 6, marginLeft: "auto" },
  evalPanel: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  evalGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(6, minmax(80px, 1fr))",
    gap: 6,
  },
  metric: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    padding: "6px 8px",
  },
  metricLabel: { fontSize: 10, color: "var(--qb-text-muted)" },
  metricValue: { fontSize: 12, fontWeight: 600, marginTop: 2 },
  evalSub: { display: "flex", flexDirection: "column", gap: 4 },
  subTitle: { fontSize: 10, color: "var(--qb-text-muted)" },
  subBody: { display: "flex", flexWrap: "wrap", gap: 6 },
  numCell: {
    fontSize: 11,
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    padding: "1px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 3,
  },
  statsBar: { fontSize: 11, color: "var(--qb-text-muted)" },
  tableWrap: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    overflow: "auto",
    maxHeight: 360,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11 },
  th: {
    textAlign: "left",
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
  },
  td: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
  },
  evalList: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 10px" },
  evalRow: {
    padding: "6px 8px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontSize: 11,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  evalRowTop: { display: "flex", justifyContent: "space-between" },
  evalRowMid: { display: "flex", justifyContent: "space-between", gap: 6 },
  evalErr: { color: "#c54040", fontSize: 10 },
  muted: { color: "var(--qb-text-muted)" },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
  },
  formRow: { display: "flex", gap: 8 },
  formLabel: {
    display: "flex",
    flexDirection: "column",
    fontSize: 11,
    color: "var(--qb-text-muted)",
    gap: 2,
    minWidth: 0,
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
  btnGhostActive: { color: "inherit", background: "var(--qb-bg-elevated)" },
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
