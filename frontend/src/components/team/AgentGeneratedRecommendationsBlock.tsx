import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { listRecommendations } from "../../api/backend";
import type { RecommendationRecord } from "../../api/types";

export interface AgentGeneratedRecommendationsBlockProps {
  workflowRunId: string;
  chrome?: "details" | "bare";
  onCountChange?: (count: number) => void;
}

/**
 * Core / Bridge 路径的主交付物：recommendation.record → recommendation_snapshot。
 * 下栏「研究产出」原先只挂因子/策略/脚本，导致 Rust Core 跑完后计数全是 0。
 */
export const AgentGeneratedRecommendationsBlock: FC<
  AgentGeneratedRecommendationsBlockProps
> = ({ workflowRunId, chrome = "details", onCountChange }) => {
  const [rows, setRows] = useState<RecommendationRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!workflowRunId) {
      setRows([]);
      onCountChange?.(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listRecommendations({ workflowRunId, limit: 200 });
      setRows(next);
      onCountChange?.(next.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
      onCountChange?.(0);
    } finally {
      setLoading(false);
    }
  }, [workflowRunId, onCountChange]);

  useEffect(() => {
    void reload();
    if (!workflowRunId) return;
    const timer = setInterval(() => void reload(), 6000);
    return () => clearInterval(timer);
  }, [reload, workflowRunId]);

  const body = (
    <div style={styles.body}>
      <div style={styles.toolbar}>
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
      {!error && rows.length === 0 ? (
        <div style={styles.empty}>
          {!workflowRunId
            ? "请先选择工作流"
            : "本工作流尚无推荐记录。Core 调用 recommendation.record 成功后会出现在这里。"}
        </div>
      ) : null}
      <div style={styles.list}>
        {rows.map((row) => (
          <div key={row.id} style={styles.card}>
            <div style={styles.cardHead}>
              <span style={styles.symbol}>{row.symbol}</span>
              <span style={styles.side}>{row.side}</span>
              <span style={styles.status}>{row.status}</span>
              <span style={styles.meta}>
                conf {(row.confidence * 100).toFixed(0)}% · {row.horizonDays}d
              </span>
            </div>
            {row.rationale ? (
              <div style={styles.rationale}>
                {row.rationale.length > 220
                  ? `${row.rationale.slice(0, 220)}…`
                  : row.rationale}
              </div>
            ) : null}
            <div style={styles.levels}>
              {row.entryLow != null || row.entryHigh != null
                ? `入场 ${row.entryLow ?? "—"}–${row.entryHigh ?? "—"}`
                : null}
              {row.stopLoss != null ? ` · 止损 ${row.stopLoss}` : ""}
              {row.takeProfit != null ? ` · 目标 ${row.takeProfit}` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  if (chrome === "bare") return body;

  return (
    <details open style={styles.details}>
      <summary style={styles.summary}>推荐 · DecisionSignal ({rows.length})</summary>
      {body}
    </details>
  );
};

const styles: Record<string, CSSProperties> = {
  details: { marginTop: 4 },
  summary: {
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    color: "#fbbf24",
    marginBottom: 8,
  },
  body: { display: "flex", flexDirection: "column", gap: 8 },
  toolbar: { display: "flex", justifyContent: "flex-end" },
  refreshBtn: { fontSize: 11, padding: "2px 8px" },
  error: { fontSize: 11, color: "#fca5a5" },
  empty: {
    fontSize: 11,
    color: "#71717a",
    lineHeight: 1.5,
    padding: "10px 0",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxHeight: 320,
    overflow: "auto",
  },
  card: {
    border: "1px solid #2a2a30",
    borderRadius: 8,
    background: "rgba(8,8,10,0.65)",
    padding: "8px 10px",
    flexShrink: 0,
  },
  cardHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    fontSize: 12,
  },
  symbol: {
    fontWeight: 700,
    color: "#e4e4e7",
    fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
  },
  side: { fontSize: 10, color: "#93c5fd", textTransform: "uppercase" },
  status: { fontSize: 10, color: "#a3e635" },
  meta: { marginLeft: "auto", fontSize: 10, color: "#71717a" },
  rationale: {
    marginTop: 6,
    fontSize: 11,
    color: "#a1a1aa",
    lineHeight: 1.45,
  },
  levels: { marginTop: 4, fontSize: 10, color: "#71717a" },
};
