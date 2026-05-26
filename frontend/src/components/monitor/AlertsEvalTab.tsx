/**
 * 监控 · 告警与评测 tab：从 MonitorDashboard.tsx 拆出（scope === "alerts_eval" 块）。
 * 纯机械拆分。
 */
import type { FC } from "react";
import type {
  AlertEventRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
} from "../../api/types";
import { styles } from "./monitor-shared";

export type AlertStatusFilter = "open" | "ack" | "resolved" | "";

export type AlertsEvalTabProps = {
  alerts: AlertEventRecord[];
  alertStatusFilter: AlertStatusFilter;
  setAlertStatusFilter: (v: AlertStatusFilter) => void;
  evalDatasets: EvalDatasetRecord[];
  selectedDatasetId: string;
  setSelectedDatasetId: (v: string) => void;
  evalRuns: EvalRunRecord[];
  evalRunCases: EvalCaseResultRecord[];
  datasetName: string;
  setDatasetName: (v: string) => void;
  loading: boolean;
  onRefreshAlerts: () => void | Promise<void>;
  onScanStuck: () => void | Promise<void>;
  onAckAlert: (id: string) => void | Promise<void>;
  onResolveAlert: (id: string) => void | Promise<void>;
  onCreateDataset: () => void | Promise<void>;
  loadEvalBoard: (datasetId?: string) => void | Promise<void>;
  onRunEval: () => void | Promise<void>;
  onOpenEvalRun: (runId: string) => void | Promise<void>;
  /** 在 select 变化时一并刷新 alerts（保持原行为：调用 listAlerts 后 setAlerts） */
  onAlertFilterChange: (v: AlertStatusFilter) => void;
};

export const AlertsEvalTab: FC<AlertsEvalTabProps> = ({
  alerts,
  alertStatusFilter,
  setAlertStatusFilter,
  evalDatasets,
  selectedDatasetId,
  setSelectedDatasetId,
  evalRuns,
  evalRunCases,
  datasetName,
  setDatasetName,
  loading,
  onRefreshAlerts,
  onScanStuck,
  onAckAlert,
  onResolveAlert,
  onCreateDataset,
  loadEvalBoard,
  onRunEval,
  onOpenEvalRun,
  onAlertFilterChange,
}) => {
  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        告警中心
      </h3>
      <div style={styles.form}>
        <select
          style={styles.select}
          value={alertStatusFilter}
          onChange={(e) => {
            const v = e.target.value as AlertStatusFilter;
            setAlertStatusFilter(v);
            onAlertFilterChange(v);
          }}
        >
          <option value="open">open</option>
          <option value="ack">ack</option>
          <option value="resolved">resolved</option>
          <option value="">全部</option>
        </select>
        <button className="qb-btn-secondary" type="button" onClick={() => void onRefreshAlerts()}>
          刷新告警
        </button>
        <button className="qb-btn-secondary" type="button" disabled={loading} onClick={() => void onScanStuck()}>
          扫描卡住工作流
        </button>
      </div>
      <div style={styles.grid}>
        {alerts.slice(0, 30).map((alert) => (
          <div key={alert.id} style={styles.card}>
            <div style={styles.cardName}>
              [{alert.severity}] {alert.title}
            </div>
            <div style={styles.cardDesc}>
              {alert.scopeType}:{alert.scopeId} · {alert.status}
            </div>
            <div style={styles.form}>
              {alert.status === "open" ? (
                <button className="qb-btn-secondary" type="button" onClick={() => void onAckAlert(alert.id)}>
                  确认 (ack)
                </button>
              ) : null}
              {alert.status !== "resolved" ? (
                <button className="qb-btn-secondary" type="button" onClick={() => void onResolveAlert(alert.id)}>
                  关闭 (resolve)
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        评测报告
      </h3>
      <div style={styles.form}>
        <input style={styles.input} value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
        <button className="qb-btn-secondary" type="button" onClick={() => void onCreateDataset()}>
          新建数据集
        </button>
        <select
          style={styles.select}
          value={selectedDatasetId}
          onChange={(e) => {
            setSelectedDatasetId(e.target.value);
            void loadEvalBoard(e.target.value);
          }}
        >
          <option value="">选择评测数据集</option>
          {evalDatasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}@{d.version}
            </option>
          ))}
        </select>
        <button
          className="qb-btn-primary-brand"
          type="button"
          onClick={() => void onRunEval()}
          disabled={!selectedDatasetId}
        >
          发起对照评测
        </button>
      </div>
      <div style={styles.grid}>
        {evalRuns.slice(0, 20).map((run) => (
          <button key={run.id} type="button" className="qb-btn-card" onClick={() => void onOpenEvalRun(run.id)}>
            <div style={styles.cardName}>{run.id.slice(0, 12)}…</div>
            <div style={styles.cardDesc}>
              {run.status} · {JSON.stringify(run.summaryMetricsJson)}
            </div>
          </button>
        ))}
      </div>
      <pre style={styles.streamBox}>
        {evalRunCases.length === 0
          ? "点击评测 run 查看样本…"
          : evalRunCases
              .slice(0, 20)
              .map((c) => `${c.caseKey} score=${c.score.toFixed(3)} pass=${String(c.pass)}`)
              .join("\n")}
      </pre>
    </>
  );
};
