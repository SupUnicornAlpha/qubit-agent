/**
 * DiscoveryStudioTab — 因子挖掘工坊
 *
 * 三栏：
 *   左：发起表单（kind / symbols / 日期 / topK / seed）+ 任务列表
 *   中：选中 job 详情 + 候选 IC 排行榜 + 一键 promote 为正式 factor
 *   右：promote 表单 / 状态
 *
 * 与后端 /api/v1/discovery-jobs 对接。
 */

import type { CSSProperties, FC } from "react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  getDiscoveryJob,
  listDiscoveryJobs,
  promoteDiscoveryCandidate,
  runDiscoveryNow,
  type DiscoveryCandidateDto,
  type DiscoveryJobRecord,
  type DiscoveryKind,
  type FactorCategory,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";
import { LineageBadge, LineageTrail } from "./LineageBadge";
import { useAppStore } from "../../store";

const KIND_LABELS: Record<DiscoveryKind, string> = {
  factor_alpha101: "Alpha101 模板",
  factor_gp: "符号回归 (GP)",
  factor_llm: "LLM 生成",
  rule_llm: "规则 LLM",
  genome_evolve: "基因进化",
};

const KIND_SUPPORTED: DiscoveryKind[] = ["factor_alpha101", "factor_gp"];

const CATEGORY_LABELS: Record<FactorCategory, string> = {
  value: "Value",
  momentum: "Momentum",
  volatility: "Volatility",
  news: "News",
  quality: "Quality",
  macro: "Macro",
};

const STATUS_TONES: Record<DiscoveryJobRecord["status"], string> = {
  pending: "var(--qb-text-muted)",
  running: "#3b82f6",
  succeeded: "var(--qb-success, #36ad6a)",
  failed: "#c54040",
  cancelled: "#a4654c",
  stopped_early: "#a4654c",
};

export const DiscoveryStudioTab: FC = () => {
  const { projectId, loading: projectLoading, error: projectError } = useDefaultProject();

  const [jobs, setJobs] = useState<DiscoveryJobRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<DiscoveryJobRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [kind, setKind] = useState<DiscoveryKind>("factor_alpha101");
  const [symbols, setSymbols] = useState("AAPL,MSFT,GOOG");
  const [startDate, setStartDate] = useState("2026-01-01");
  const [endDate, setEndDate] = useState("2026-04-30");
  const [horizonDays, setHorizonDays] = useState(5);
  const [topK, setTopK] = useState(10);
  const [candidateCount, setCandidateCount] = useState(30);
  const [seed, setSeed] = useState<number | "">(42);

  const [promoteCandidate, setPromoteCandidate] = useState<DiscoveryCandidateDto | null>(null);
  const [promoteName, setPromoteName] = useState("");
  const [promoteCategory, setPromoteCategory] = useState<FactorCategory>("momentum");
  /** 候选详情展开（点表达式行 → 显示完整 description / 全表达式） */
  const [expandedCandidateId, setExpandedCandidateId] = useState<string | null>(null);

  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  const setQuantTab = useAppStore((s) => s.setQuantTab);

  const reloadList = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await listDiscoveryJobs({ projectId });
      setJobs(rows);
      if (!selectedId && rows.length > 0) setSelectedId(rows[0]!.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectId, selectedId]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  const reloadSelected = useCallback(async () => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    try {
      const job = await getDiscoveryJob(selectedId);
      setSelected(job);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selectedId]);

  useEffect(() => {
    void reloadSelected();
  }, [reloadSelected]);

  const symbolsList = useMemo(
    () =>
      symbols
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [symbols]
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!projectId) return;
      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const job = await runDiscoveryNow({
          projectId,
          kind,
          symbols: symbolsList,
          startDate,
          endDate,
          horizonDays,
          topK,
          candidateCount,
          ...(typeof seed === "number" ? { seed } : {}),
        });
        setInfo(`挖掘任务 ${job.kind} 完成：${job.status} · ${job.candidates.length} 候选`);
        await reloadList();
        setSelectedId(job.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [projectId, kind, symbolsList, startDate, endDate, horizonDays, topK, candidateCount, seed, reloadList]
  );

  const onPromote = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selected || !promoteCandidate) return;
      setBusy(true);
      setError(null);
      try {
        const f = await promoteDiscoveryCandidate(selected.id, promoteCandidate.id, {
          name: promoteName.trim(),
          category: promoteCategory,
          status: "draft",
        });
        setInfo(`已 promote 为因子 ${f.name}（${f.id.slice(0, 8)}…）`);
        setPromoteCandidate(null);
        setPromoteName("");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [selected, promoteCandidate, promoteName, promoteCategory]
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
    <div className="qb-quant-tab-root qb-quant-tab-root--discovery" data-qb-quant-tab="discovery" style={styles.root}>
      <aside className="qb-quant-col qb-quant-col--left" style={styles.colLeft}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>发起挖掘</strong>
        </div>
        <form onSubmit={onSubmit} className="qb-quant-form" style={styles.form}>
          <label style={styles.formLabel}>
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as DiscoveryKind)}
              style={styles.select}
            >
              {KIND_SUPPORTED.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
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
              Horizon
              <input
                type="number"
                min={1}
                max={60}
                value={horizonDays}
                onChange={(e) => setHorizonDays(Number.parseInt(e.target.value, 10) || 5)}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              TopK
              <input
                type="number"
                min={1}
                max={50}
                value={topK}
                onChange={(e) => setTopK(Number.parseInt(e.target.value, 10) || 10)}
                style={styles.input}
              />
            </label>
          </div>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              候选数
              <input
                type="number"
                min={kind === "factor_gp" ? 5 : 1}
                max={200}
                value={candidateCount}
                onChange={(e) => setCandidateCount(Number.parseInt(e.target.value, 10) || 30)}
                style={styles.input}
              />
            </label>
            {kind === "factor_gp" ? (
              <label style={styles.formLabel}>
                Seed
                <input
                  type="number"
                  value={seed}
                  onChange={(e) =>
                    setSeed(e.target.value === "" ? "" : Number.parseInt(e.target.value, 10))
                  }
                  style={styles.input}
                />
              </label>
            ) : null}
          </div>
          <button type="submit" disabled={busy || symbolsList.length === 0} className="qb-quant-btn qb-quant-btn--primary qb-quant-btn--run" style={styles.btnPrimary}>
            {busy ? "运行中…" : "Run Now"}
          </button>
        </form>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>历史任务</strong>
          <span className="qb-quant-muted" style={styles.muted}>{jobs.length}</span>
        </div>
        <div className="qb-quant-list" style={styles.list}>
          {jobs.map((j) => (
            <button
              key={j.id}
              type="button"
              onClick={() => setSelectedId(j.id)}
              className={`qb-quant-list-item${j.id === selectedId ? " qb-quant-list-item--active" : ""}`}
              data-qb-quant-status={j.status}
              style={{
                ...styles.listItem,
                ...(j.id === selectedId ? styles.listItemActive : null),
              }}
            >
              <div className="qb-quant-list-item-top" style={styles.listItemTop}>
                <span className="qb-quant-status-tag" data-qb-quant-status={j.status} style={{ color: STATUS_TONES[j.status], fontWeight: 600 }}>{j.status}</span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <LineageBadge createdBy={j.createdBy ?? "user"} size="small" />
                  <span className="qb-quant-muted" style={styles.muted}>{j.kind}</span>
                </span>
              </div>
              <div className="qb-quant-list-item-meta" style={styles.listItemMeta}>
                {j.candidates.length} 候选 · {new Date(j.startedAt).toLocaleString()}
              </div>
            </button>
          ))}
          {jobs.length === 0 ? <div className="qb-quant-empty" style={styles.empty}>暂无任务</div> : null}
        </div>
      </aside>

      <section className="qb-quant-col qb-quant-col--mid" style={styles.colMid}>
        {selected ? (
          <>
            <div className="qb-quant-detail-header" style={styles.detailHeader}>
              <div>
                <div className="qb-quant-detail-title" style={styles.detailTitle}>
                  {KIND_LABELS[selected.kind]} ·{" "}
                  <span className="qb-quant-status-tag" data-qb-quant-status={selected.status} style={{ color: STATUS_TONES[selected.status] }}>{selected.status}</span>
                </div>
                <div className="qb-quant-detail-meta" style={styles.detailMeta}>
                  {selected.input.startDate} ~ {selected.input.endDate} · symbols=
                  {selected.input.symbols.length} · horizon={selected.input.horizonDays ?? 5}
                </div>
              </div>
              <button
                type="button"
                onClick={reloadSelected}
                disabled={busy}
                className="qb-quant-btn qb-quant-btn--ghost"
                style={styles.btnGhost}
              >
                刷新
              </button>
            </div>
            <LineageTrail kind="discovery_job" id={selected.id} compact />
            {selected.error ? <div className="qb-quant-error-panel" style={styles.errorPanel}>错误：{selected.error}</div> : null}
            <div className="qb-quant-table-wrap" style={styles.tableWrap}>
              <table className="qb-quant-table qb-quant-table--candidates" style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>#</th>
                    <th style={styles.th}>表达式</th>
                    <th style={styles.thNum}>IC</th>
                    <th style={styles.thNum}>RankIC</th>
                    <th style={styles.thNum}>N</th>
                    <th style={styles.thNum}>分</th>
                    <th style={styles.th}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.candidates.map((c, idx) => {
                    const isExpanded = expandedCandidateId === c.id;
                    return (
                      <Fragment key={c.id}>
                        <tr
                          style={{
                            ...(c.error ? styles.rowErr : null),
                            ...(isExpanded ? { background: "var(--qb-bg-elevated)" } : null),
                            cursor: "pointer",
                          }}
                          onClick={() => setExpandedCandidateId(isExpanded ? null : c.id)}
                        >
                          <td style={styles.td}>{idx + 1}</td>
                          <td style={styles.tdMono} title={c.description ?? c.expr}>
                            {c.expr}
                          </td>
                          <td style={styles.tdNum}>{c.metrics.ic.toFixed(4)}</td>
                          <td style={styles.tdNum}>{c.metrics.rankIc.toFixed(4)}</td>
                          <td style={styles.tdNum}>{c.metrics.sampleSize}</td>
                          <td style={styles.tdNum}>{c.metrics.score.toFixed(4)}</td>
                          <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                            {c.error ? (
                              <span style={styles.muted}>error</span>
                            ) : (
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPromoteCandidate(c);
                                    setPromoteName(`disc_${idx + 1}_${selected.id.slice(0, 6)}`);
                                    setPromoteCategory(
                                      (c.category as FactorCategory | undefined) ?? "momentum"
                                    );
                                  }}
                                  className="qb-quant-btn qb-quant-btn--primary"
                                  style={styles.btnPrimary}
                                  title="将候选 promote 为正式因子（draft 状态）"
                                >
                                  Promote
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setQuantHandoff({
                                      kind: "raw",
                                      expr: c.expr,
                                      lang: "qlib_expr",
                                      reverse: c.metrics.ic < 0,
                                      note: `Discovery 候选 #${idx + 1} (job ${selected.id.slice(0, 8)})`,
                                    });
                                    setQuantTab("backtest");
                                  }}
                                  className="qb-quant-btn qb-quant-btn--ghost"
                                  style={styles.btnGhost}
                                  title="跳转到回测工坊，预填该候选表达式为 raw signal"
                                >
                                  试跑回测
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr style={{ background: "var(--qb-bg-elevated)" }}>
                            <td colSpan={7} style={{ ...styles.td, padding: "8px 12px" }}>
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 6,
                                  fontSize: 11,
                                }}
                              >
                                {c.description ? (
                                  <div>
                                    <span style={styles.muted}>说明：</span> {c.description}
                                  </div>
                                ) : null}
                                <div>
                                  <span style={styles.muted}>表达式：</span>
                                  <pre
                                    style={{
                                      ...styles.exprBox,
                                      marginTop: 4,
                                      maxHeight: 180,
                                      overflow: "auto",
                                    }}
                                  >
                                    {c.expr}
                                  </pre>
                                </div>
                                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                                  <span>
                                    <span style={styles.muted}>IC </span>
                                    {c.metrics.ic.toFixed(4)}
                                  </span>
                                  <span>
                                    <span style={styles.muted}>RankIC </span>
                                    {c.metrics.rankIc.toFixed(4)}
                                  </span>
                                  <span>
                                    <span style={styles.muted}>Score </span>
                                    {c.metrics.score.toFixed(4)}
                                  </span>
                                  <span>
                                    <span style={styles.muted}>N </span>
                                    {c.metrics.sampleSize}
                                  </span>
                                  {c.category ? (
                                    <span>
                                      <span style={styles.muted}>Category </span>
                                      {c.category}
                                    </span>
                                  ) : null}
                                </div>
                                {c.error ? (
                                  <div style={{ color: "#c54040" }}>错误：{c.error}</div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {selected.candidates.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="qb-quant-empty" style={styles.empty}>
                        没有候选
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="qb-quant-empty" style={styles.empty}>左侧选择任务，或先发起一个挖掘任务。</div>
        )}
      </section>

      <aside className="qb-quant-col qb-quant-col--right" style={styles.colRight}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>Promote</strong>
        </div>
        {promoteCandidate ? (
          <form onSubmit={onPromote} className="qb-quant-form qb-quant-form--promote" style={styles.formPad}>
            <div className="qb-quant-candidate-block" style={styles.candidateBlock}>
              <div className="qb-quant-muted" style={styles.muted}>候选表达式</div>
              <pre className="qb-quant-expr-box" style={styles.exprBox}>{promoteCandidate.expr}</pre>
              <div className="qb-quant-candidate-metrics" style={styles.candidateMetrics}>
                IC {promoteCandidate.metrics.ic.toFixed(4)} · RankIC{" "}
                {promoteCandidate.metrics.rankIc.toFixed(4)} · n={promoteCandidate.metrics.sampleSize}
              </div>
            </div>
            <label style={styles.formLabel}>
              因子名
              <input
                required
                type="text"
                value={promoteName}
                onChange={(e) => setPromoteName(e.target.value)}
                style={styles.input}
              />
            </label>
            <label style={styles.formLabel}>
              分类
              <select
                value={promoteCategory}
                onChange={(e) => setPromoteCategory(e.target.value as FactorCategory)}
                style={styles.select}
              >
                {(Object.keys(CATEGORY_LABELS) as FactorCategory[]).map((k) => (
                  <option key={k} value={k}>
                    {CATEGORY_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy} className="qb-quant-btn qb-quant-btn--primary" style={styles.btnPrimary}>
              提交为草稿因子
            </button>
            <button
              type="button"
              onClick={() => setPromoteCandidate(null)}
              className="qb-quant-btn qb-quant-btn--ghost"
              style={styles.btnGhost}
            >
              取消
            </button>
          </form>
        ) : (
          <div className="qb-quant-empty" style={styles.empty}>从中间表格点击 “Promote” 选择候选。</div>
        )}
      </aside>

      {error ? <div className="qb-quant-toast qb-quant-toast--err" style={styles.toastErr}>{error}</div> : null}
      {info ? <div className="qb-quant-toast qb-quant-toast--info" style={styles.toastInfo}>{info}</div> : null}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, 320px) 1fr minmax(240px, 300px)",
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
    overflow: "auto",
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
  formPad: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "10px 12px",
  },
  formRow: { display: "flex", gap: 8 },
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
  listItemMeta: {
    fontSize: 10,
    color: "var(--qb-text-muted)",
    marginTop: 2,
  },
  detailHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  detailTitle: { fontSize: 14, fontWeight: 600 },
  detailMeta: { fontSize: 11, color: "var(--qb-text-muted)", marginTop: 4 },
  tableWrap: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    overflow: "auto",
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 11 },
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
  td: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
  },
  tdNum: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    textAlign: "right",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
  },
  tdMono: {
    padding: "4px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    maxWidth: 320,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rowErr: { color: "#c54040" },
  candidateBlock: { display: "flex", flexDirection: "column", gap: 4 },
  candidateMetrics: { fontSize: 11, color: "var(--qb-text-muted)" },
  exprBox: {
    background: "var(--qb-bg-elevated)",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "6px 8px",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    fontSize: 11,
    whiteSpace: "pre-wrap",
    margin: 0,
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
