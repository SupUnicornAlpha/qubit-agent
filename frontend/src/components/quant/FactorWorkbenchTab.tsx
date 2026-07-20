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
  runFactorBacktestPromotionNow,
  setFactorStatus,
  type FactorCategory,
  type FactorEvalResultDto,
  type FactorEvaluationLogRow,
  type FactorLang,
  type FactorRecord,
  type FactorStatus,
  type FactorValueRow,
  type FactorValueStats,
  type LineageCreatedBy,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";
import { pickColor, SvgLineChart, type ChartSeries } from "./charts/SvgLineChart";
import { LineageBadge, LineageTrail } from "./LineageBadge";
import { useAppStore } from "../../store";

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
  /**
   * 来源过滤：用户 / Agent / Promoted / 全部 — migration 0080 引入。
   * 仅前端筛 factors[] 即可（量级 << 1000），不走后端 query string。
   */
  const [filterSource, setFilterSource] = useState<LineageCreatedBy | "all">("all");
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

  /**
   * 多选集 —— 同时承担「IC 对比」与「批量动作」两类用途，
   * 避免再开一组 state 让 checkbox 行为发散。
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [compareEvalsByFactor, setCompareEvalsByFactor] = useState<
    Record<string, FactorEvaluationLogRow[]>
  >({});

  /** 批量动作进度提示（"3/5 compute MOMENTUM_5D"） */
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; label: string } | null>(null);

  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const handoff = useAppStore((s) => s.quantHandoff);

  /** 研究产物→因子工坊：清空可能隐藏目标的过滤器，并精确选中因子。 */
  useEffect(() => {
    if (!handoff || handoff.kind !== "factor-to-workbench") return;
    setFilterCategory("all");
    setFilterStatus("all");
    setFilterSource("all");
    setSelected(null);
    setEvaluations([]);
    setValueStats(null);
    setSelectedId(handoff.factorId);
    setInfo(handoff.note ?? `已打开因子 ${handoff.factorId.slice(0, 8)}…`);
    setError(null);
    setQuantHandoff(null);
  }, [handoff, setQuantHandoff]);

  const reloadList = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await listFactors({
        projectId: projectId ?? undefined,
        category: filterCategory === "all" ? undefined : filterCategory,
        status: filterStatus === "all" ? undefined : filterStatus,
      });
      setFactors(rows);
      setSelectedId((current) => current ?? rows[0]?.id ?? null);
    } catch (e) {
      setError(`因子列表加载失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [projectId, filterCategory, filterStatus]);

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
      setSelected(null);
      setError(
        `无法打开因子 ${selectedId.slice(0, 8)}…：${(e as Error).message}。` +
          "该产物可能已删除，或不属于当前研究项目。"
      );
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadSelected();
  }, [reloadSelected]);

  const filtered = useMemo(() => {
    if (filterSource === "all") return factors;
    return factors.filter((f) => (f.createdBy ?? "user") === filterSource);
  }, [factors, filterSource]);

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

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * 串行批量执行，避免同时打多个 compute / auto-evaluate 把 DuckDB 压瘫。
   * 每步更新 bulkProgress，让用户能看到 N/M 进度。
   */
  const runBulk = useCallback(
    async <T,>(
      action: string,
      ids: string[],
      fn: (id: string, factor: FactorRecord) => Promise<T>
    ) => {
      if (ids.length === 0) return;
      setBulkProgress({ done: 0, total: ids.length, label: action });
      setError(null);
      setInfo(null);
      let success = 0;
      let failed = 0;
      const factorById = new Map(factors.map((f) => [f.id, f] as const));
      for (let i = 0; i < ids.length; i++) {
        const fid = ids[i]!;
        const f = factorById.get(fid);
        if (!f) {
          failed += 1;
          setBulkProgress({ done: i + 1, total: ids.length, label: `${action} · 跳过` });
          continue;
        }
        setBulkProgress({ done: i, total: ids.length, label: `${action} · ${f.name}` });
        try {
          await fn(fid, f);
          success += 1;
        } catch (e) {
          failed += 1;
          // 累积错误信息，但不中断；最后统一展示
          setError((prev) =>
            prev
              ? `${prev}\n[${f.name}] ${(e as Error).message}`
              : `[${f.name}] ${(e as Error).message}`
          );
        }
      }
      setBulkProgress(null);
      setInfo(`批量${action}完成：成功 ${success} · 失败 ${failed}`);
    },
    [factors]
  );

  /**
   * 批量状态切换：复用单条 setFactorStatus，串行即可（写极快）。
   *
   * 选中集保留策略：
   * - filterStatus = "all" → 切完仍在 filtered 里 → 保留，方便连续批量动作
   * - filterStatus = next → 用户已在目标状态视图 → 保留
   * - 其他 → 切完被过滤藏起来，保留会出现「计数 5 但列表为空」的鬼影 → 清空
   */
  const onBulkStatus = useCallback(
    async (next: FactorStatus) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      await runBulk(`设为${STATUS_LABELS[next]}`, ids, async (id) => {
        await setFactorStatus(id, next);
      });
      await reloadList();
      await reloadSelected();
      if (filterStatus !== "all" && filterStatus !== next) {
        setSelectedIds(new Set());
      }
    },
    [selectedIds, runBulk, reloadList, reloadSelected, filterStatus]
  );

  const onBulkCompute = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await runBulk("compute", ids, async (id) => {
      await computeFactor(id, {
        startDate: opStart,
        endDate: opEnd,
        symbols: symbolsList.length > 0 ? symbolsList : undefined,
      });
    });
    // 跑完刷新选中因子的统计
    const stats = selectedId ? await factorValuesStats(selectedId).catch(() => null) : null;
    setValueStats(stats);
  }, [selectedIds, runBulk, opStart, opEnd, symbolsList, selectedId]);

  const onBulkAutoEvaluate = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await runBulk("auto-evaluate", ids, async (id) => {
      await autoEvaluateFactor(id, {
        startDate: opStart,
        endDate: opEnd,
        symbols: symbolsList.length > 0 ? symbolsList : undefined,
        horizonDays: opHorizon,
        groupCount: opGroups,
        decayHorizons: [1, 3, 5, 10, 20],
      });
    });
    // 重新拉对比组的评估历史
    const idsArr = Array.from(selectedIds);
    const results = await Promise.all(
      idsArr.map((id) =>
        listFactorEvaluations(id, 60)
          .then((rows) => ({ id, rows }))
          .catch(() => ({ id, rows: [] as FactorEvaluationLogRow[] }))
      )
    );
    const next: Record<string, FactorEvaluationLogRow[]> = {};
    for (const r of results) next[r.id] = r.rows;
    setCompareEvalsByFactor(next);
  }, [selectedIds, runBulk, opStart, opEnd, symbolsList, opHorizon, opGroups]);

  /** 批量送入组合工坊（写 handoff + 切 tab） */
  const onBulkToComposer = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setQuantHandoff({
      kind: "factor-ids-to-composer",
      factorIds: ids,
      note: `来自因子工坊批量选中 (${ids.length})`,
    });
    setQuantTab("composer");
  }, [selectedIds, setQuantHandoff, setQuantTab]);

  const onBulkPromoteBacktest = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    setBulkProgress({ done: 0, total: 1, label: "创建组合并运行回测" });
    try {
      const result = await runFactorBacktestPromotionNow({
        projectId: projectId ?? undefined,
        factorIds: ids,
        symbols: symbolsList,
        startDate: opStart,
        endDate: opEnd,
        rebalance: "daily",
        capital: 100_000,
        createdBy: "user",
      });
      setBulkProgress({ done: 1, total: 1, label: "回测完成" });
      setInfo(
        `已创建策略 ${result.strategyVersion.id.slice(0, 8)} / 组合 ${result.composition.id.slice(0, 8)} / 回测 ${result.backtest.id.slice(0, 8)}`
      );
      setQuantHandoff({
        kind: "backtest-job",
        jobId: result.backtest.id,
        note: `因子闭环 · ${ids.length} factor(s)`,
      });
      setQuantTab("backtest");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setBulkProgress(null);
    }
  }, [opEnd, opStart, projectId, selectedIds, setQuantHandoff, setQuantTab, symbolsList]);

  // 拉取对比组的评估历史
  useEffect(() => {
    if (selectedIds.size === 0) {
      setCompareEvalsByFactor({});
      return;
    }
    let cancelled = false;
    (async () => {
      const idsArr = Array.from(selectedIds);
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
  }, [selectedIds]);

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
      if (!selectedIds.has(f.id)) continue;
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
  }, [factors, selectedIds, compareEvalsByFactor]);

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
          <select
            value={filterSource}
            onChange={(e) => setFilterSource(e.target.value as LineageCreatedBy | "all")}
            style={styles.select}
            title="按因子的产出来源筛选（用户 / Agent / Discovery promote）"
          >
            <option value="all">来源: 全部</option>
            <option value="user">用户</option>
            <option value="agent">Agent</option>
            <option value="discovery_promote">Promoted</option>
            <option value="system">System</option>
          </select>
        </div>
        <FactorBulkBar
          filteredCount={filtered.length}
          selectedIds={selectedIds}
          busy={busy || bulkProgress !== null}
          onSelectAll={() => {
            setSelectedIds(new Set(filtered.map((f) => f.id)));
          }}
          onInvert={() => {
            setSelectedIds((prev) => {
              const next = new Set<string>();
              for (const f of filtered) if (!prev.has(f.id)) next.add(f.id);
              return next;
            });
          }}
          onClear={() => setSelectedIds(new Set())}
          onStatus={onBulkStatus}
          onCompute={onBulkCompute}
          onAutoEval={onBulkAutoEvaluate}
          onToComposer={onBulkToComposer}
          onPromoteBacktest={onBulkPromoteBacktest}
        />
        {bulkProgress ? (
          <div
            className="qb-quant-bulk-progress"
            style={styles.bulkProgress}
            data-qb-quant-bulk-progress
          >
            <div style={styles.bulkProgressLabel}>
              <span>批量 · {bulkProgress.label}</span>
              <span style={{ color: "var(--qb-text-muted)" }}>
                {bulkProgress.done}/{bulkProgress.total}
              </span>
            </div>
            <div style={styles.bulkProgressTrack}>
              <span
                style={{
                  ...styles.bulkProgressFill,
                  width: `${(bulkProgress.done / Math.max(1, bulkProgress.total)) * 100}%`,
                }}
              />
            </div>
          </div>
        ) : null}
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
                checked={selectedIds.has(f.id)}
                onChange={() => toggleSelect(f.id)}
                onClick={(e) => e.stopPropagation()}
                title="勾选：加入批量动作 + IC 对比图"
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
                <div
                  className="qb-quant-list-item-title"
                  style={{ ...styles.listItemTitle, display: "flex", alignItems: "center", gap: 6 }}
                >
                  <span
                    className="qb-quant-status-dot"
                    data-status={f.status === "active" ? "succeeded" : f.status === "archived" ? "failed" : "pending"}
                    aria-hidden
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {f.name}
                  </span>
                  <LineageBadge createdBy={f.createdBy ?? "user"} size="small" />
                </div>
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
            <div
              className="qb-quant-hero-card"
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
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
            <LineageTrail kind="factor" id={selected.id} />
            <pre className="qb-quant-expr-box" style={styles.exprBox}>{selected.expr}</pre>
            </div>

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
                  <MetricCell label="IC" value={lastEval.ic} signed />
                  <MetricCell label="RankIC" value={lastEval.rankIc} signed />
                  <MetricCell label="IR" value={lastEval.ir} signed />
                  <MetricCell label="Turnover" value={lastEval.turnover} tone="cyan" />
                  <MetricCell label="N" value={lastEval.sampleSize} digits={0} tone="indigo" />
                  <MetricCell label="延迟ms" value={lastEval.latencyMs} digits={0} tone="amber" />
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

/**
 * 批量状态按钮的色彩 token —— 与列表里 status dot 同源（绿/琥珀/灰红），
 * 让"点这个 = 状态变成这个颜色"成为肌肉记忆。
 */
const BULK_STATUS_TONE: Record<FactorStatus, {
  dot: string;
  text: string;
  border: string;
  bg: string;
}> = {
  active: {
    dot: "var(--qb-quant-accent-3)",
    text: "var(--qb-quant-accent-3)",
    border: "color-mix(in srgb, var(--qb-quant-accent-3) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-3) 10%, var(--qb-bg-elevated))",
  },
  draft: {
    dot: "var(--qb-quant-accent-2)",
    text: "var(--qb-quant-accent-2)",
    border: "color-mix(in srgb, var(--qb-quant-accent-2) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-2) 10%, var(--qb-bg-elevated))",
  },
  archived: {
    dot: "var(--qb-text-muted)",
    text: "var(--qb-text-muted)",
    border: "var(--qb-border-subtle)",
    bg: "var(--qb-bg-surface)",
  },
};

/**
 * 因子批量动作条 —— 仅在有选中或可批量时浮现。
 *
 * 操作矩阵：
 *   - 选择控制：全选（当前过滤）/ 反选 / 清空
 *   - 状态批量：启用 / 草稿 / 归档（复用单条 PATCH，串行调用）
 *   - 计算批量：compute / auto-evaluate（用当前操作面板的日期+symbols+horizon+groups）
 *   - 工坊联动：送入组合工坊（写 quantHandoff 切 tab）
 *
 * 设计权衡：
 *   - 「送入组合」「批量计算」走的是「同一参数应用到 N 因子」的语义；
 *     如果有需要每条不同参数，应该在 Composer 里逐条调；这里追求快。
 *   - 所有动作都依赖左侧勾选；当 selectedIds.size === 0 时整条条目变灰禁用，
 *     以避免用户误操作清掉过滤后的全部数据。
 */
const FactorBulkBar: FC<{
  filteredCount: number;
  selectedIds: Set<string>;
  busy: boolean;
  onSelectAll: () => void;
  onInvert: () => void;
  onClear: () => void;
  onStatus: (next: FactorStatus) => void;
  onCompute: () => void;
  onAutoEval: () => void;
  onToComposer: () => void;
  onPromoteBacktest: () => void;
}> = ({
  filteredCount,
  selectedIds,
  busy,
  onSelectAll,
  onInvert,
  onClear,
  onStatus,
  onCompute,
  onAutoEval,
  onToComposer,
  onPromoteBacktest,
}) => {
  const hasSelection = selectedIds.size > 0;
  const allSelected = filteredCount > 0 && selectedIds.size === filteredCount;
  return (
    <div className="qb-quant-bulk-bar" data-qb-has-selection={hasSelection} style={styles.bulkBar}>
      <div style={styles.bulkBarLeft}>
        <button
          type="button"
          onClick={allSelected ? onClear : onSelectAll}
          disabled={busy || filteredCount === 0}
          className="qb-quant-btn qb-quant-btn--ghost"
          style={styles.btnGhost}
          title={allSelected ? "清空选择" : "全选当前过滤结果"}
        >
          {allSelected ? "✓ 取消全选" : `全选 ${filteredCount}`}
        </button>
        <button
          type="button"
          onClick={onInvert}
          disabled={busy || filteredCount === 0}
          className="qb-quant-btn qb-quant-btn--ghost"
          style={styles.btnGhost}
          title="反选当前过滤结果"
        >
          反选
        </button>
        {hasSelection ? (
          <span className="qb-quant-bulk-count" style={styles.bulkCount}>
            已选 <strong style={{ color: "var(--qb-text-strong)" }}>{selectedIds.size}</strong> 个
          </span>
        ) : null}
      </div>
      {hasSelection ? (
        <div style={styles.bulkBarRight}>
          <div className="qb-quant-bulk-group" data-group="status" style={styles.bulkGroup}>
            <span style={styles.bulkGroupLabel}>状态</span>
            {(["active", "draft", "archived"] as FactorStatus[]).map((s) => {
              const tone = BULK_STATUS_TONE[s];
              return (
                <button
                  key={s}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // 批量归档是降级动作 —— 先 confirm 避免误伤大量数据。
                    if (s === "archived") {
                      const ok = window.confirm(
                        `确认将所选 ${selectedIds.size} 个因子全部归档？\n（归档后默认列表里需切到「状态: 归档」才能看到）`
                      );
                      if (!ok) return;
                    }
                    onStatus(s);
                  }}
                  className="qb-quant-btn qb-quant-bulk-status-btn"
                  data-qb-quant-status={s}
                  style={{
                    ...styles.bulkStatusBtn,
                    color: tone.text,
                    borderColor: tone.border,
                    background: tone.bg,
                  }}
                  title={`将所选 ${selectedIds.size} 个因子设为「${STATUS_LABELS[s]}」`}
                >
                  <span
                    style={{
                      ...styles.bulkStatusDot,
                      background: tone.dot,
                      boxShadow: `0 0 0 2px color-mix(in srgb, ${tone.dot} 35%, transparent)`,
                    }}
                  />
                  {STATUS_LABELS[s]}
                </button>
              );
            })}
          </div>
          <div className="qb-quant-bulk-group" data-group="compute" style={styles.bulkGroup}>
            <span style={styles.bulkGroupLabel}>计算</span>
            <button
              type="button"
              disabled={busy}
              onClick={onCompute}
              className="qb-quant-btn qb-quant-btn--primary"
              style={styles.btnPrimary}
              title="对所选因子用「操作」面板的日期+symbols 批量 compute"
            >
              Compute
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onAutoEval}
              className="qb-quant-btn qb-quant-btn--primary"
              style={styles.btnPrimary}
              title="对所选因子按「操作」面板 horizon/groups 跑 auto-evaluate"
            >
              Auto-Eval
            </button>
          </div>
          <div className="qb-quant-bulk-group" data-group="route" style={styles.bulkGroup}>
            <button
              type="button"
              disabled={busy}
              onClick={onToComposer}
              className="qb-quant-btn qb-quant-btn--primary qb-quant-btn--submit"
              style={styles.btnPrimary}
              title="把所选因子勾入组合工坊候选池并跳过去"
            >
              送入组合 →
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onPromoteBacktest}
              className="qb-quant-btn qb-quant-btn--primary qb-quant-btn--submit"
              style={styles.btnPrimary}
              title="直接创建 strategy_version / composition 并运行事件驱动回测"
            >
              闭环回测 →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const FACTOR_TONE_COLOR: Record<string, string> = {
  emerald: "var(--qb-quant-accent-5)",
  cyan: "var(--qb-quant-accent-2)",
  indigo: "var(--qb-quant-accent-1)",
  amber: "var(--qb-quant-accent-3)",
  pink: "var(--qb-quant-accent-4)",
};

const MetricCell: FC<{
  label: string;
  value: number;
  digits?: number;
  /** signed=true 时正负值用 success/error 着色（IC/IR/RankIC 专用） */
  signed?: boolean;
  tone?: keyof typeof FACTOR_TONE_COLOR;
}> = ({ label, value, digits = 4, signed = false, tone }) => {
  const dotColor = signed
    ? value >= 0
      ? "var(--qb-success)"
      : "var(--qb-error)"
    : tone
    ? FACTOR_TONE_COLOR[tone]
    : "var(--qb-quant-accent-1)";
  const valueColor = signed
    ? value > 0
      ? "var(--qb-success)"
      : value < 0
      ? "var(--qb-error)"
      : "var(--qb-text-strong)"
    : "var(--qb-text-strong)";
  return (
    <div className="qb-quant-metric" style={{ ...styles.metric, position: "relative" }}>
      <span
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 5,
          height: 5,
          borderRadius: 999,
          background: dotColor,
          boxShadow: `0 0 0 3px color-mix(in srgb, ${dotColor} 22%, transparent)`,
        }}
      />
      <div className="qb-quant-metric-label" style={styles.metricLabel}>{label}</div>
      <div
        className="qb-quant-metric-value"
        style={{ ...styles.metricValue, color: valueColor }}
      >
        {Number.isFinite(value) ? value.toFixed(digits) : "—"}
      </div>
    </div>
  );
};

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
  bulkBar: {
    flex: "0 0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background:
      "linear-gradient(180deg, color-mix(in srgb, var(--qb-quant-accent-1) 5%, transparent), transparent)",
  },
  bulkBarLeft: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "var(--qb-text-muted)",
  },
  bulkBarRight: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
  bulkGroup: {
    display: "flex",
    gap: 4,
    alignItems: "center",
    padding: "2px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    background: "var(--qb-bg-elevated)",
  },
  bulkGroupLabel: {
    fontSize: 10,
    color: "var(--qb-text-muted)",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    paddingRight: 2,
  },
  bulkStatusBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 8px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 4,
    border: "1px solid",
    cursor: "pointer",
    transition: "transform 120ms ease, filter 120ms ease",
  },
  bulkStatusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  bulkCount: {
    fontSize: 11,
    color: "var(--qb-text-muted)",
    marginLeft: 4,
  },
  bulkProgress: {
    flex: "0 0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
  },
  bulkProgressLabel: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
    fontVariantNumeric: "tabular-nums",
    color: "var(--qb-text-strong)",
  },
  bulkProgressTrack: {
    height: 4,
    borderRadius: 2,
    background: "var(--qb-bg-surface)",
    overflow: "hidden",
  },
  bulkProgressFill: {
    display: "block",
    height: "100%",
    background:
      "linear-gradient(90deg, var(--qb-quant-accent-1), var(--qb-quant-accent-4))",
    transition: "width 220ms ease",
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
