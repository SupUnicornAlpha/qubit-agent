import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listFactors, type FactorRecord } from "../../api/backend";

export interface AgentGeneratedFactorsBlockProps {
  /** 当前研究项目 ID（teamResearchProjectId）。空字符串则不拉取。 */
  projectId: string;
  /**
   * 当前选中的工作流 ID（workflow_run.id）。
   * - 非空：严格按 workflow_run_id 过滤，仅显示本工作流期间 Agent 产出的因子
   * - 空：组件展示「请先选择工作流」空态，不发请求
   */
  workflowRunId: string;
  /** 点击单条因子时的跳转回调，例如打开量化工坊的因子工坊 tab 并定位到该因子。 */
  onOpenInWorkbench?: (factor: FactorRecord) => void;
  /** 默认是否展开；不传则 `true`。 */
  defaultOpen?: boolean;
}

/**
 * 研究团队右侧栏 — 「Agent 生成的因子」可折叠块。
 *
 * 数据契约（migration 0047 之后）：
 *   factor_definition.workflow_run_id 在 builtin tools / discovery.promote /
 *   native-research.connector 三条 Agent 写入链路上都由 act 节点透传 ctx.workflowId
 *   写入。这里走 `listFactors({ projectId, workflowRunId })` 严格匹配，命中
 *   `idx_factor_definition_project_workflow` 索引。
 *
 * 与历史时间过滤方案的差异：
 *   - 不再用 createdAt >= workflowStartedAt 做近似过滤（并发 workflow 会串栏）
 *   - 不再暴露「全部 / 仅本工作流期间」下拉：本侧栏的语义就是「本工作流产物」，
 *     想看项目全量请去量化工坊 → 因子工坊
 *   - workflow_run_id IS NULL 的存量 / IDE 注册因子直接不展示，避免误导
 */
export const AgentGeneratedFactorsBlock: FC<AgentGeneratedFactorsBlockProps> = ({
  projectId,
  workflowRunId,
  onOpenInWorkbench,
  defaultOpen = true,
}) => {
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");

  const reload = useCallback(async () => {
    if (!projectId || !workflowRunId) {
      setFactors([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await listFactors({ projectId, workflowRunId });
      setFactors(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, workflowRunId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [workflowRunId, projectId]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return factors
      .filter((f) => {
        if (!kw) return true;
        return (
          f.name.toLowerCase().includes(kw) ||
          f.expr.toLowerCase().includes(kw) ||
          f.category.toLowerCase().includes(kw)
        );
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [factors, keyword]);

  const selected = useMemo(
    () => filtered.filter((f) => selectedIds.has(f.id)),
    [filtered, selectedIds]
  );

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const summaryLabel = `Agent 生成的因子（${filtered.length}${
    selected.length > 0 ? ` · 已选 ${selected.length}` : ""
  }）`;

  return (
    <details className="qb-mcp-details" style={styles.details} open={defaultOpen}>
      <summary style={styles.summary}>{summaryLabel}</summary>
      <div style={styles.body}>
        <div style={styles.toolbar}>
          <span style={styles.scopeHint}>仅本工作流</span>
          <input
            style={styles.searchInput}
            placeholder="按名称 / 表达式 / 类别搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            disabled={!workflowRunId}
          />
          <button
            type="button"
            className="qb-btn-secondary"
            style={styles.refreshBtn}
            onClick={() => void reload()}
            disabled={loading || !workflowRunId}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>

        {error ? <div style={styles.error}>{error}</div> : null}
        {!error && filtered.length === 0 ? (
          <div style={styles.empty}>
            {!projectId
              ? "请先在左侧选择研究项目。"
              : !workflowRunId
                ? "请先选择或启动一个工作流；研究产出仅展示当前工作流的因子。"
                : "本工作流暂未产出因子。让 Agent 调用 factor.register / discovery.promote 即可入库。"}
          </div>
        ) : null}

        <div style={styles.list}>
          {filtered.map((f) => {
            const checked = selectedIds.has(f.id);
            return (
              <label key={f.id} style={{ ...styles.row, ...(checked ? styles.rowChecked : null) }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(f.id)}
                  style={styles.checkbox}
                />
                <div style={styles.rowMain}>
                  <div style={styles.rowTitle}>
                    <span style={styles.rowName}>{f.name}</span>
                    <span style={styles.badge}>{f.category}</span>
                    <span style={{ ...styles.badge, ...badgeStatus(f.status) }}>{f.status}</span>
                  </div>
                  <div style={styles.rowSub}>
                    <code style={styles.exprMini}>{f.expr.length > 64 ? `${f.expr.slice(0, 60)}…` : f.expr}</code>
                  </div>
                  <div style={styles.rowMeta}>
                    {f.lang} · {f.horizon}d · {f.universe} ·{" "}
                    {new Date(f.createdAt).toLocaleString()}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {selected.length > 0 ? (
          <div style={styles.cards}>
            {selected.map((f) => (
              <article key={f.id} style={styles.card}>
                <header style={styles.cardHead}>
                  <div style={styles.cardTitle}>{f.name}</div>
                  <div style={styles.cardHeadMeta}>
                    <span style={styles.badge}>{f.category}</span>
                    <span style={{ ...styles.badge, ...badgeStatus(f.status) }}>{f.status}</span>
                  </div>
                </header>
                <div style={styles.cardField}>
                  <div style={styles.cardLabel}>Expression</div>
                  <pre style={styles.cardCode}>{f.expr}</pre>
                </div>
                <div style={styles.cardFieldRow}>
                  <div style={styles.cardField}>
                    <div style={styles.cardLabel}>语言</div>
                    <div style={styles.cardValue}>{f.lang}</div>
                  </div>
                  <div style={styles.cardField}>
                    <div style={styles.cardLabel}>Horizon</div>
                    <div style={styles.cardValue}>{f.horizon} d</div>
                  </div>
                  <div style={styles.cardField}>
                    <div style={styles.cardLabel}>Universe</div>
                    <div style={styles.cardValue}>{f.universe}</div>
                  </div>
                  <div style={styles.cardField}>
                    <div style={styles.cardLabel}>Provider</div>
                    <div style={styles.cardValue}>{f.providerKey || "—"}</div>
                  </div>
                </div>
                <div style={styles.cardFooter}>
                  <span style={styles.cardMeta}>创建于 {new Date(f.createdAt).toLocaleString()}</span>
                  {onOpenInWorkbench ? (
                    <button
                      type="button"
                      className="qb-btn-secondary"
                      style={styles.cardBtn}
                      onClick={() => onOpenInWorkbench(f)}
                    >
                      去因子工坊详情
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
};

const badgeStatusMap: Record<string, CSSProperties> = {
  draft: { background: "#3f3f46", color: "#d4d4d8" },
  candidate: { background: "#1e3a8a", color: "#bfdbfe" },
  approved: { background: "#14532d", color: "#bbf7d0" },
  retired: { background: "#7f1d1d", color: "#fecaca" },
};

function badgeStatus(status: string): CSSProperties {
  return badgeStatusMap[status] ?? badgeStatusMap.draft!;
}

const styles: Record<string, CSSProperties> = {
  details: {
    marginBottom: 10,
    border: "1px solid var(--qb-mcp-details-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-mcp-details-bg, #111114)",
    overflow: "hidden",
  },
  summary: {
    cursor: "pointer",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--qb-main-meta, #e4e4e7)",
    userSelect: "none",
    listStyle: "none",
  },
  body: {
    padding: "0 12px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  toolbar: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flexWrap: "wrap",
  },
  scopeHint: {
    fontSize: 10,
    color: "#a1a1aa",
    background: "rgba(59, 130, 246, 0.12)",
    border: "1px solid rgba(59, 130, 246, 0.35)",
    padding: "3px 8px",
    borderRadius: 10,
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    minWidth: 80,
    background: "#0a0a0c",
    border: "1px solid #3f3f46",
    color: "#e4e4e7",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  refreshBtn: {
    fontSize: 11,
    padding: "4px 8px",
  },
  error: {
    fontSize: 11,
    color: "#fca5a5",
    background: "#1f0c0c",
    border: "1px solid #7f1d1d",
    borderRadius: 6,
    padding: "6px 8px",
  },
  empty: {
    fontSize: 11,
    color: "#71717a",
    padding: "8px 4px",
    lineHeight: 1.45,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 200,
    overflow: "auto",
  },
  row: {
    display: "flex",
    gap: 6,
    alignItems: "flex-start",
    padding: "6px 6px",
    borderRadius: 6,
    cursor: "pointer",
    border: "1px solid transparent",
  },
  rowChecked: {
    background: "rgba(59, 130, 246, 0.08)",
    border: "1px solid rgba(59, 130, 246, 0.35)",
  },
  checkbox: {
    marginTop: 3,
    flexShrink: 0,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  rowTitle: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flexWrap: "wrap",
  },
  rowName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#e4e4e7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowSub: {
    fontSize: 10,
    color: "#a1a1aa",
    overflow: "hidden",
  },
  rowMeta: {
    fontSize: 10,
    color: "#71717a",
  },
  exprMini: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    color: "#a1a1aa",
    background: "rgba(255,255,255,0.03)",
    padding: "1px 4px",
    borderRadius: 3,
    wordBreak: "break-all",
  },
  badge: {
    fontSize: 9,
    padding: "1px 6px",
    borderRadius: 10,
    background: "#27272a",
    color: "#a1a1aa",
    flexShrink: 0,
  },
  cards: {
    marginTop: 6,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  card: {
    border: "1px solid #3f3f46",
    borderRadius: 8,
    background: "#0a0a0c",
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  cardHeadMeta: {
    display: "flex",
    gap: 4,
    alignItems: "center",
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#fafafa",
  },
  cardField: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  cardFieldRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  cardLabel: {
    fontSize: 10,
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  cardValue: {
    fontSize: 11,
    color: "#e4e4e7",
  },
  cardCode: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    color: "#cbd5e1",
    background: "rgba(255,255,255,0.04)",
    padding: 6,
    borderRadius: 4,
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    maxHeight: 120,
    overflow: "auto",
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  cardMeta: {
    fontSize: 10,
    color: "#71717a",
  },
  cardBtn: {
    fontSize: 10,
    padding: "3px 8px",
  },
};
