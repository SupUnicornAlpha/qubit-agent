/**
 * 工作流 Eval 面板：Score / Observation / 人工标注 / Golden 导出。
 */
import { useCallback, useEffect, useState, type FC } from "react";
import {
  exportWorkflowGolden,
  getWorkflowEvalObservations,
  getWorkflowEvalScores,
  listWorkflowEvalAnnotations,
  submitWorkflowEvalAnnotation,
  submitWorkflowEvalFeedback,
} from "../../api/backend";
import { formatAgentEvalScoreValue } from "../../lib/agentEvalFormat";
import { styles } from "./monitor-shared";

type AgentScoreRow = {
  id: string;
  name: string;
  dataType: string;
  value?: {
    numeric?: number;
    categorical?: string;
    boolean?: boolean;
    text?: string;
  };
  source: string;
  comment?: string | null;
  createdAt: string;
};

type ObservationTree = {
  workflowRunId: string;
  workflowStatus: string;
  root: {
    id: string;
    type: string;
    name: string;
    children?: Array<{ id: string; type: string; name: string; status?: string }>;
  };
};

export type WorkflowEvalPanelProps = {
  workflowRunId: string | null;
};

export const WorkflowEvalPanel: FC<WorkflowEvalPanelProps> = ({ workflowRunId }) => {
  const [scores, setScores] = useState<AgentScoreRow[]>([]);
  const [observations, setObservations] = useState<ObservationTree | null>(null);
  const [annotations, setAnnotations] = useState<AgentScoreRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [annoValue, setAnnoValue] = useState("0.8");
  const [annoComment, setAnnoComment] = useState("");
  const [goldenDatasetId, setGoldenDatasetId] = useState("");
  const [goldenCaseKey, setGoldenCaseKey] = useState("");
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!workflowRunId) {
      setScores([]);
      setObservations(null);
      setAnnotations([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [scoreRows, obs, annos] = await Promise.all([
        getWorkflowEvalScores(workflowRunId),
        getWorkflowEvalObservations(workflowRunId),
        listWorkflowEvalAnnotations(workflowRunId),
      ]);
      setScores(scoreRows);
      setObservations(obs);
      setAnnotations(annos);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workflowRunId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onSubmitAnnotation = async () => {
    if (!workflowRunId) return;
    const value = Number(annoValue);
    if (!Number.isFinite(value)) {
      setActionMsg("请输入有效数值");
      return;
    }
    try {
      await submitWorkflowEvalAnnotation(workflowRunId, {
        dataType: "NUMERIC",
        value,
        ...(annoComment.trim() ? { comment: annoComment.trim() } : {}),
      });
      setActionMsg("标注已保存");
      setAnnoComment("");
      await reload();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const onExportGolden = async () => {
    if (!workflowRunId || !goldenDatasetId.trim()) {
      setActionMsg("请填写 datasetId");
      return;
    }
    try {
      const item = await exportWorkflowGolden(workflowRunId, {
        datasetId: goldenDatasetId.trim(),
        ...(goldenCaseKey.trim() ? { caseKey: goldenCaseKey.trim() } : {}),
      });
      setActionMsg(`已导出 Golden：${item.caseKey}`);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const onWorkflowFeedback = async (helpful: boolean) => {
    if (!workflowRunId) return;
    try {
      await submitWorkflowEvalFeedback(workflowRunId, { helpful });
      setActionMsg(helpful ? "已标记有帮助" : "已标记无帮助");
      await reload();
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
  };

  if (!workflowRunId) {
    return <div style={styles.hint}>选中工作流后查看 Eval Score 与 Observation…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong>Eval 平台</strong>
        <button type="button" className="qb-btn-mini" onClick={() => void reload()} disabled={loading}>
          刷新
        </button>
        <button type="button" className="qb-btn-mini" onClick={() => void onWorkflowFeedback(true)}>
          👍 有帮助
        </button>
        <button type="button" className="qb-btn-mini" onClick={() => void onWorkflowFeedback(false)}>
          👎 无帮助
        </button>
      </div>
      {loading ? <div style={styles.hint}>加载中…</div> : null}
      {error ? <div style={{ color: "#f87171", fontSize: 12 }}>{error}</div> : null}
      {actionMsg ? <div style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>{actionMsg}</div> : null}

      <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
        <div style={styles.chartTitle}>Scores ({scores.length})</div>
        {scores.length === 0 ? (
          <div style={styles.hint}>暂无 Score（workflow 终态后会自动写入 sync scores）</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>名称</th>
                  <th style={styles.th}>值</th>
                  <th style={styles.th}>来源</th>
                  <th style={styles.th}>时间</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((row) => (
                  <tr key={row.id} style={styles.tr}>
                    <td style={styles.td}>{row.name}</td>
                    <td style={styles.td}>{formatAgentEvalScoreValue(row)}</td>
                    <td style={styles.td}>{row.source}</td>
                    <td style={styles.td}>{new Date(row.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {observations ? (
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>
            Observation · {observations.workflowStatus} · root {observations.root.type}
          </div>
          <ul style={{ margin: 0, padding: "8px 12px 8px 24px", fontSize: 12, lineHeight: 1.6 }}>
            {(observations.root.children ?? []).slice(0, 40).map((node) => (
              <li key={node.id}>
                {node.type} · {node.name}
                {node.status ? ` · ${node.status}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
        <div style={styles.chartTitle}>人工标注</div>
        <div style={{ ...styles.form, marginBottom: 8 }}>
          <input
            style={styles.input}
            placeholder="数值 0–1"
            value={annoValue}
            onChange={(e) => setAnnoValue(e.target.value)}
          />
          <input
            style={{ ...styles.input, flex: 2 }}
            placeholder="备注（可选）"
            value={annoComment}
            onChange={(e) => setAnnoComment(e.target.value)}
          />
          <button type="button" className="qb-btn-secondary" onClick={() => void onSubmitAnnotation()}>
            提交标注
          </button>
        </div>
        {annotations.length > 0 ? (
          <ul style={{ margin: 0, padding: "0 12px 8px 24px", fontSize: 12 }}>
            {annotations.map((row) => (
              <li key={row.id}>
                {row.name} = {formatAgentEvalScoreValue(row)}
                {row.comment ? ` · ${row.comment}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <div style={styles.hint}>尚无人工标注</div>
        )}
      </div>

      <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
        <div style={styles.chartTitle}>导出 Golden Dataset</div>
        <div style={styles.form}>
          <input
            style={styles.input}
            placeholder="datasetId"
            value={goldenDatasetId}
            onChange={(e) => setGoldenDatasetId(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="caseKey（可选）"
            value={goldenCaseKey}
            onChange={(e) => setGoldenCaseKey(e.target.value)}
          />
          <button type="button" className="qb-btn-secondary" onClick={() => void onExportGolden()}>
            导出
          </button>
        </div>
      </div>
    </div>
  );
};
