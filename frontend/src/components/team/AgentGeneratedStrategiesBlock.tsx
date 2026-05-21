import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listStrategyCompositions,
  listStrategyVersions,
  type StrategyCompositionRecord,
  type StrategyVersionFlatRecord,
} from "../../api/backend";

export interface AgentGeneratedStrategiesBlockProps {
  projectId: string;
  workflowStartedAt: string;
  workflowRunId: string;
  onOpenInComposer?: (version: StrategyVersionFlatRecord) => void;
  defaultOpen?: boolean;
}

interface StrategyRow {
  version: StrategyVersionFlatRecord;
  compositions: StrategyCompositionRecord[];
  /** 是否被选中以详情卡片形式展示。 */
  loadingCompositions: boolean;
}

/**
 * 研究团队右侧栏 — 「Agent 生成的策略」可折叠块。
 *
 * 数据通路：
 *   1. listStrategyVersions(projectId)       → 拿当前项目下所有 strategy_version
 *   2. （仅对选中的 version）listStrategyCompositions(versionId) → 拿 composition 详情
 *   3. 客户端按 version.createdAt >= workflowStartedAt 过滤 "本工作流期间生成的"
 *
 * 为什么走 version 维度而不是 composition 维度：
 *   - Agent 通过 strategy.compose / discovery.promote 写入 strategy_version
 *   - 一个 version 可能对应多个 composition（不同 weight method 等），用户多选时
 *     展开看到每个 version 下的 composition 即可
 */
export const AgentGeneratedStrategiesBlock: FC<AgentGeneratedStrategiesBlockProps> = ({
  projectId,
  workflowStartedAt,
  workflowRunId,
  onOpenInComposer,
  defaultOpen = true,
}) => {
  const [rows, setRows] = useState<StrategyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"workflow" | "all">(workflowStartedAt ? "workflow" : "all");
  const [keyword, setKeyword] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const versions = await listStrategyVersions(projectId);
      setRows(
        versions.map((v) => ({
          version: v,
          compositions: [],
          loadingCompositions: false,
        }))
      );
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
    return rows
      .filter((r) => {
        if (baselineMs > 0) {
          const t = new Date(r.version.createdAt).getTime();
          if (!Number.isFinite(t) || t < baselineMs) return false;
        }
        if (!kw) return true;
        return (
          r.version.strategyName.toLowerCase().includes(kw) ||
          r.version.versionTag.toLowerCase().includes(kw) ||
          r.version.strategyStyle.toLowerCase().includes(kw)
        );
      })
      .sort(
        (a, b) =>
          new Date(b.version.createdAt).getTime() - new Date(a.version.createdAt).getTime()
      );
  }, [rows, scope, workflowStartedAt, keyword]);

  const selected = useMemo(
    () => filtered.filter((r) => selectedIds.has(r.version.id)),
    [filtered, selectedIds]
  );

  const ensureCompositionsLoaded = useCallback(
    async (versionId: string) => {
      const target = rows.find((r) => r.version.id === versionId);
      if (!target || target.compositions.length > 0 || target.loadingCompositions) return;
      setRows((prev) =>
        prev.map((r) =>
          r.version.id === versionId ? { ...r, loadingCompositions: true } : r
        )
      );
      try {
        const comps = await listStrategyCompositions(versionId);
        setRows((prev) =>
          prev.map((r) =>
            r.version.id === versionId
              ? { ...r, compositions: comps, loadingCompositions: false }
              : r
          )
        );
      } catch {
        setRows((prev) =>
          prev.map((r) =>
            r.version.id === versionId ? { ...r, loadingCompositions: false } : r
          )
        );
      }
    },
    [rows]
  );

  const toggle = useCallback(
    (versionId: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(versionId)) {
          next.delete(versionId);
        } else {
          next.add(versionId);
          void ensureCompositionsLoaded(versionId);
        }
        return next;
      });
    },
    [ensureCompositionsLoaded]
  );

  const summaryLabel = `Agent 生成的策略（${filtered.length}${
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
            placeholder="按策略名 / 版本 / 风格搜索"
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
                ? "本工作流期间还没有 Agent 生成的策略。让 Agent 调用 strategy.compose 或 discovery.promote 即可入库。"
                : "该项目下还没有策略版本。"
              : "请先在左侧选择项目并启动工作流。"}
          </div>
        ) : null}

        <div style={styles.list}>
          {filtered.map((r) => {
            const checked = selectedIds.has(r.version.id);
            return (
              <label
                key={r.version.id}
                style={{ ...styles.row, ...(checked ? styles.rowChecked : null) }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(r.version.id)}
                  style={styles.checkbox}
                />
                <div style={styles.rowMain}>
                  <div style={styles.rowTitle}>
                    <span style={styles.rowName}>{r.version.strategyName}</span>
                    <span style={styles.badge}>{r.version.versionTag}</span>
                    <span style={styles.badge}>{r.version.strategyStyle}</span>
                  </div>
                  <div style={styles.rowMeta}>
                    创建于 {new Date(r.version.createdAt).toLocaleString()}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {selected.length > 0 ? (
          <div style={styles.cards}>
            {selected.map((r) => (
              <article key={r.version.id} style={styles.card}>
                <header style={styles.cardHead}>
                  <div style={styles.cardTitle}>{r.version.strategyName}</div>
                  <div style={styles.cardHeadMeta}>
                    <span style={styles.badge}>{r.version.versionTag}</span>
                    <span style={styles.badge}>{r.version.strategyStyle}</span>
                  </div>
                </header>
                {r.loadingCompositions ? (
                  <div style={styles.cardMeta}>加载组合详情…</div>
                ) : r.compositions.length === 0 ? (
                  <div style={styles.cardMeta}>
                    该版本还没有 composition；可在量化工坊 → 组合工坊里基于此版本编排。
                  </div>
                ) : (
                  <div style={styles.compList}>
                    {r.compositions.map((c) => (
                      <div key={c.id} style={styles.comp}>
                        <div style={styles.compHead}>
                          <span style={styles.badge}>{c.kind}</span>
                          <span style={styles.badge}>weight: {c.weightMethod}</span>
                          <span style={styles.badge}>rebalance: {c.rebalanceFreq}</span>
                          <span style={styles.badge}>universe: {c.universe}</span>
                        </div>
                        <div style={styles.compFields}>
                          <div style={styles.compField}>
                            <div style={styles.cardLabel}>因子（{c.factorIds.length}）</div>
                            <div style={styles.cardValue}>
                              {c.factorIds.length > 0
                                ? c.factorIds.map((id) => id.slice(0, 8)).join(", ")
                                : "—"}
                            </div>
                          </div>
                          <div style={styles.compField}>
                            <div style={styles.cardLabel}>规则（{c.ruleIds.length}）</div>
                            <div style={styles.cardValue}>
                              {c.ruleIds.length > 0
                                ? c.ruleIds.map((id) => id.slice(0, 8)).join(", ")
                                : "—"}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={styles.cardFooter}>
                  <span style={styles.cardMeta}>
                    创建于 {new Date(r.version.createdAt).toLocaleString()}
                  </span>
                  {onOpenInComposer ? (
                    <button
                      type="button"
                      className="qb-btn-secondary"
                      style={styles.cardBtn}
                      onClick={() => onOpenInComposer(r.version)}
                    >
                      去组合工坊
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
    background: "rgba(139, 92, 246, 0.08)",
    border: "1px solid rgba(139, 92, 246, 0.35)",
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
  rowMeta: {
    fontSize: 10,
    color: "#71717a",
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
  cardLabel: {
    fontSize: 10,
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  cardValue: {
    fontSize: 11,
    color: "#e4e4e7",
    wordBreak: "break-all",
  },
  cardMeta: {
    fontSize: 10,
    color: "#71717a",
  },
  cardBtn: {
    fontSize: 10,
    padding: "3px 8px",
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  compList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  comp: {
    border: "1px dashed #3f3f46",
    borderRadius: 6,
    padding: 6,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    background: "rgba(255,255,255,0.02)",
  },
  compHead: {
    display: "flex",
    gap: 4,
    flexWrap: "wrap",
  },
  compFields: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  compField: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
    minWidth: 100,
  },
};
