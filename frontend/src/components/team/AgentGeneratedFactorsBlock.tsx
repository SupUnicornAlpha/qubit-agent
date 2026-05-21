import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listFactors, type FactorRecord } from "../../api/backend";

export interface AgentGeneratedFactorsBlockProps {
  /** 当前研究项目 ID（teamResearchProjectId）。空字符串则不拉取。 */
  projectId: string;
  /** 当前 workflow 启动时间 ISO 字符串；非空时默认开启"仅本工作流期间"过滤。 */
  workflowStartedAt: string;
  /** 当前 workflowRunId，仅用于副作用 key（切换 workflow 时重置选中）。 */
  workflowRunId: string;
  /** 点击单条因子时的跳转回调，例如打开量化工坊的因子工坊 tab 并定位到该因子。 */
  onOpenInWorkbench?: (factor: FactorRecord) => void;
  /** 默认是否展开；不传则 `true`。 */
  defaultOpen?: boolean;
}

/**
 * 研究团队右侧栏 — 「Agent 生成的因子」可折叠块。
 *
 * 数据通路（M8 当前不动 schema 的最小落地方案）：
 *   listFactors({ projectId })  → 客户端按 createdAt >= workflowStartedAt 过滤
 * 后续如果给 factor / strategy 表加上 workflow_run_id 字段，可在 listFactors 加 filter，
 * 这层组件无需改动。
 */
export const AgentGeneratedFactorsBlock: FC<AgentGeneratedFactorsBlockProps> = ({
  projectId,
  workflowStartedAt,
  workflowRunId,
  onOpenInWorkbench,
  defaultOpen = true,
}) => {
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"workflow" | "all">(workflowStartedAt ? "workflow" : "all");
  const [keyword, setKeyword] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) {
      setFactors([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await listFactors({ projectId });
      setFactors(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [workflowRunId, projectId]);

  useEffect(() => {
    setScope(workflowStartedAt ? "workflow" : "all");
  }, [workflowStartedAt]);

  const filtered = useMemo(() => {
    const baselineMs =
      scope === "workflow" && workflowStartedAt ? new Date(workflowStartedAt).getTime() : 0;
    const kw = keyword.trim().toLowerCase();
    return factors
      .filter((f) => {
        if (baselineMs > 0) {
          const t = new Date(f.createdAt).getTime();
          if (!Number.isFinite(t) || t < baselineMs) return false;
        }
        if (!kw) return true;
        return (
          f.name.toLowerCase().includes(kw) ||
          f.expr.toLowerCase().includes(kw) ||
          f.category.toLowerCase().includes(kw)
        );
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [factors, scope, workflowStartedAt, keyword]);

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
          <select
            style={styles.smallSelect}
            value={scope}
            onChange={(e) => setScope(e.target.value as "workflow" | "all")}
          >
            <option value="workflow" disabled={!workflowStartedAt}>
              仅本工作流期间
            </option>
            <option value="all">全部</option>
          </select>
          <input
            style={styles.searchInput}
            placeholder="按名称 / 表达式 / 类别搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <button
            type="button"
            className="qb-btn-secondary"
            style={styles.refreshBtn}
            onClick={() => void reload()}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>

        {error ? <div style={styles.error}>{error}</div> : null}
        {!error && filtered.length === 0 ? (
          <div style={styles.empty}>
            {projectId
              ? scope === "workflow"
                ? "本工作流期间还没有 Agent 生成的因子。让 Agent 调用 factor.register 或 discovery.promote 即可入库。"
                : "该项目下还没有因子。"
              : "请先在左侧选择项目并启动工作流。"}
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
  smallSelect: {
    background: "#0a0a0c",
    border: "1px solid #3f3f46",
    color: "#e4e4e7",
    borderRadius: 6,
    padding: "4px 6px",
    fontSize: 11,
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
