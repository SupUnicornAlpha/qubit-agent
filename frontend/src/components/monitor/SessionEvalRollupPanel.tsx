/**
 * Session 级 Score 聚合面板（sessionFilter 有值时展示）。
 */
import { useCallback, useEffect, useState, type FC } from "react";
import { getSessionEvalScores, type SessionEvalScoreRollup } from "../../api/backend";
import { styles } from "./monitor-shared";

export type SessionEvalRollupPanelProps = {
  sessionId: string;
  onSelectWorkflow?: (workflowRunId: string) => void;
};

export const SessionEvalRollupPanel: FC<SessionEvalRollupPanelProps> = ({
  sessionId,
  onSelectWorkflow,
}) => {
  const [rollup, setRollup] = useState<SessionEvalScoreRollup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId.trim()) {
      setRollup(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setRollup(await getSessionEvalScores(sessionId.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRollup(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!sessionId.trim()) return null;

  return (
    <div className="qb-monitor__panel qb-a3d-tilt" style={{ ...styles.chartBox, marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <div style={styles.chartTitle}>Session Eval 聚合 · {sessionId.slice(0, 12)}…</div>
        <button type="button" className="qb-btn-mini" onClick={() => void reload()} disabled={loading}>
          刷新
        </button>
      </div>
      {loading ? <div style={styles.hint}>加载 session scores…</div> : null}
      {error ? <div style={{ color: "#f87171", fontSize: 12 }}>{error}</div> : null}
      {rollup ? (
        <>
          <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
            <div style={styles.kpi}>
              <div style={styles.kpiLabel}>Workflow 数</div>
              <div style={styles.kpiValue}>{rollup.workflowCount}</div>
            </div>
            <div style={styles.kpi}>
              <div style={styles.kpiLabel}>Score 种类</div>
              <div style={styles.kpiValue}>{rollup.scores.length}</div>
            </div>
          </div>
          {rollup.scores.length > 0 ? (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Score</th>
                    <th style={styles.th}>条数</th>
                    <th style={styles.th}>均值</th>
                    <th style={styles.th}>最小</th>
                    <th style={styles.th}>最大</th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.scores.map((row) => (
                    <tr key={row.name} style={styles.tr}>
                      <td style={styles.td}>{row.name}</td>
                      <td style={styles.td}>{row.count}</td>
                      <td style={styles.td}>
                        {row.avgNumeric != null ? row.avgNumeric.toFixed(3) : "—"}
                      </td>
                      <td style={styles.td}>
                        {row.minNumeric != null ? row.minNumeric.toFixed(3) : "—"}
                      </td>
                      <td style={styles.td}>
                        {row.maxNumeric != null ? row.maxNumeric.toFixed(3) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={styles.hint}>该 session 暂无 agent_score 记录</div>
          )}
          {rollup.workflows.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Workflow 明细</div>
              <ul style={{ margin: 0, padding: "0 12px 8px 24px", fontSize: 12, lineHeight: 1.6 }}>
                {rollup.workflows.map((wf) => (
                  <li key={wf.workflowRunId}>
                    {onSelectWorkflow ? (
                      <button
                        type="button"
                        className="qb-btn-ghost qb-btn--compact"
                        onClick={() => onSelectWorkflow(wf.workflowRunId)}
                      >
                        {wf.workflowRunId.slice(0, 10)}…
                      </button>
                    ) : (
                      wf.workflowRunId.slice(0, 10)
                    )}
                    {" · "}
                    {wf.status} · {wf.scoreCount} scores · {wf.goal.slice(0, 40)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
