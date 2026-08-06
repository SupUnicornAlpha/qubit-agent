import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listBacktestJobs, type BacktestJobRecord } from "../../api/backend";
import { useTranslation } from "../../i18n";

export interface AgentGeneratedBacktestsBlockProps {
  projectId: string;
  workflowRunId: string;
  onOpenInStudio?: (job: BacktestJobRecord) => void;
  defaultOpen?: boolean;
  chrome?: "details" | "bare";
  onCountChange?: (count: number) => void;
}

/**
 * 研究产出 — Agent 通过 backtest.run / factor.promote_backtest 写入的 backtest_run。
 * 严格按 workflow_run_id 过滤，与因子/策略块同一协议。
 */
export const AgentGeneratedBacktestsBlock: FC<AgentGeneratedBacktestsBlockProps> = ({
  projectId: _projectId,
  workflowRunId,
  onOpenInStudio,
  defaultOpen = true,
  chrome = "details",
  onCountChange,
}) => {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<BacktestJobRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");

  const reload = useCallback(async () => {
    if (!workflowRunId) {
      setJobs([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await listBacktestJobs({ workflowRunId });
      setJobs(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workflowRunId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    onCountChange?.(jobs.length);
  }, [jobs.length, onCountChange]);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => {
      const hay = [
        j.id,
        j.strategyVersionId,
        j.compositionId ?? "",
        j.status,
        j.engineKey,
        j.createdBy,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [jobs, keyword]);

  const selected = useMemo(
    () => filtered.filter((j) => selectedIds.has(j.id)),
    [filtered, selectedIds]
  );

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const summaryLabel =
    selected.length > 0
      ? t("team.backtestsBlock.summaryWithSelection", {
          n: jobs.length,
          selected: selected.length,
        })
      : t("team.backtestsBlock.summary", { n: jobs.length });

  const body = (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <span style={styles.scopeBadge}>{t("team.backtestsBlock.scopeBadge")}</span>
        <input
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("team.backtestsBlock.searchPlaceholder")}
          style={styles.search}
        />
        <button
          type="button"
          className="qb-btn-secondary"
          style={styles.refreshBtn}
          onClick={() => void reload()}
          disabled={loading}
        >
          {loading ? t("team.backtestsBlock.refreshing") : t("team.backtestsBlock.refresh")}
        </button>
      </div>

      {!workflowRunId ? (
        <div style={styles.empty}>{t("team.backtestsBlock.emptyNoWorkflow")}</div>
      ) : error ? (
        <div style={styles.error}>{error}</div>
      ) : filtered.length === 0 && !loading ? (
        <div style={styles.empty}>{t("team.backtestsBlock.emptyNoOutput")}</div>
      ) : (
        <>
          <ul style={styles.list}>
            {filtered.map((j) => {
              const metrics = j.result?.metrics as Record<string, number> | undefined;
              const sharpe =
                typeof metrics?.sharpe === "number"
                  ? metrics.sharpe
                  : typeof metrics?.Sharpe === "number"
                    ? metrics.Sharpe
                    : null;
              const mdd =
                typeof metrics?.maxDrawdown === "number"
                  ? metrics.maxDrawdown
                  : typeof metrics?.max_drawdown === "number"
                    ? metrics.max_drawdown
                    : null;
              return (
                <li key={j.id} style={styles.row}>
                  <label style={styles.rowMain}>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(j.id)}
                      onChange={() => toggle(j.id)}
                    />
                    <span style={styles.rowTitle}>{j.id.slice(0, 8)}…</span>
                    <span style={{ ...styles.badge, ...statusTone(j.status) }}>{j.status}</span>
                    <span style={styles.badge}>{j.createdBy}</span>
                    {sharpe != null ? (
                      <span style={styles.metric}>Sharpe {sharpe.toFixed(2)}</span>
                    ) : null}
                    {mdd != null ? (
                      <span style={styles.metric}>MDD {(mdd * 100).toFixed(1)}%</span>
                    ) : null}
                  </label>
                  {onOpenInStudio ? (
                    <button
                      type="button"
                      className="qb-btn-secondary"
                      style={styles.rowBtn}
                      onClick={() => onOpenInStudio(j)}
                    >
                      {t("team.backtestsBlock.openInStudio")}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {selected.length > 0 ? (
            <div style={styles.cards}>
              {selected.map((j) => (
                <article key={j.id} style={styles.card}>
                  <header style={styles.cardHead}>
                    <div style={styles.cardTitle}>Backtest {j.id.slice(0, 8)}</div>
                    <span style={{ ...styles.badge, ...statusTone(j.status) }}>{j.status}</span>
                  </header>
                  <div style={styles.cardMeta}>
                    version={j.strategyVersionId.slice(0, 8)}…
                    {j.compositionId
                      ? ` · composition=${j.compositionId.slice(0, 8)}…`
                      : " · raw signals"}
                  </div>
                  <div style={styles.cardMeta}>
                    {t("team.backtestsBlock.createdAt", {
                      at: new Date(j.startedAt).toLocaleString(),
                    })}
                  </div>
                  {onOpenInStudio ? (
                    <div style={styles.cardFooter}>
                      <button
                        type="button"
                        className="qb-btn-secondary"
                        style={styles.cardBtn}
                        onClick={() => onOpenInStudio(j)}
                      >
                        {t("team.backtestsBlock.openInStudio")}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  if (chrome === "bare") return body;

  return (
    <details className="qb-mcp-details" style={styles.details} open={defaultOpen}>
      <summary style={styles.summary}>{summaryLabel}</summary>
      {body}
    </details>
  );
};

function statusTone(status: BacktestJobRecord["status"]): CSSProperties {
  switch (status) {
    case "completed":
      return { background: "#14532d", color: "#bbf7d0" };
    case "failed":
      return { background: "#7f1d1d", color: "#fecaca" };
    case "running":
      return { background: "#1e3a8a", color: "#bfdbfe" };
    default:
      return { background: "#3f3f46", color: "#d4d4d8" };
  }
}

const styles: Record<string, CSSProperties> = {
  details: {
    marginBottom: 10,
    border: "1px solid var(--qb-mcp-details-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-mcp-details-bg, #111114)",
  },
  summary: {
    cursor: "pointer",
    padding: "8px 12px",
    fontSize: 12,
    fontWeight: 600,
    color: "#e4e4e7",
  },
  body: { padding: "0 4px 4px" },
  toolbar: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 8,
    flexWrap: "wrap",
  },
  scopeBadge: {
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 4,
    background: "rgba(16,185,129,0.15)",
    color: "#6ee7b7",
  },
  search: {
    flex: 1,
    minWidth: 120,
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
  },
  refreshBtn: { fontSize: 11, padding: "4px 8px" },
  empty: { fontSize: 12, color: "#71717a", padding: "12px 4px" },
  error: { fontSize: 12, color: "#fca5a5", padding: "8px 4px" },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.03)",
  },
  rowMain: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
    color: "#d4d4d8",
    cursor: "pointer",
  },
  rowTitle: { fontFamily: "ui-monospace, monospace", color: "#e4e4e7" },
  rowBtn: { fontSize: 11, padding: "2px 8px", flexShrink: 0 },
  badge: {
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 4,
    background: "#3f3f46",
    color: "#d4d4d8",
  },
  metric: { fontSize: 10, color: "#a1a1aa", fontVariantNumeric: "tabular-nums" },
  cards: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
  card: {
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 10,
    background: "#0c0c0e",
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  cardTitle: { fontSize: 13, fontWeight: 600, color: "#f4f4f5" },
  cardMeta: { fontSize: 11, color: "#71717a", marginTop: 6 },
  cardFooter: { marginTop: 8, display: "flex", justifyContent: "flex-end" },
  cardBtn: { fontSize: 11, padding: "4px 10px" },
};
