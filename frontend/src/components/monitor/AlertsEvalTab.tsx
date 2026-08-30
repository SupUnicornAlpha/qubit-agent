/**
 * 监控 · 告警与评测 tab。
 * 拆成子视图：告警 / Agent Eval 评测 / Legacy，避免告警卡片把评测入口挤出视口。
 */
import { useState, type FC } from "react";
import type {
  AlertEventRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
} from "../../api/types";
import { styles } from "./monitor-shared";
import { AgentEvalPlatformPanel } from "./AgentEvalPlatformPanel";

export type AlertStatusFilter = "open" | "ack" | "resolved" | "";

type AlertsEvalSubView = "alerts" | "eval" | "legacy";

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
  projectId: string;
};

const SUB_VIEWS: Array<{ id: AlertsEvalSubView; label: string; hint: string }> = [
  { id: "eval", label: "评测平台", hint: "Score 分析 · Experiment · 环比回归" },
  { id: "alerts", label: "告警中心", hint: "卡住 / 失败 / 质量下降" },
  { id: "legacy", label: "Legacy 评测", hint: "MSA / SDP / RFV 对照跑批" },
];

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
  projectId,
}) => {
  const [subView, setSubView] = useState<AlertsEvalSubView>("eval");
  const openCount = alerts.filter((a) => a.status === "open").length;

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {SUB_VIEWS.map((item) => {
          const active = subView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={active ? "qb-btn-primary-brand" : "qb-btn-secondary"}
              onClick={() => setSubView(item.id)}
              title={item.hint}
            >
              {item.label}
              {item.id === "alerts" && openCount > 0 ? ` (${openCount})` : ""}
            </button>
          );
        })}
      </div>
      <div style={{ ...styles.hint, marginBottom: 16 }}>
        {SUB_VIEWS.find((x) => x.id === subView)?.hint}
      </div>

      {subView === "eval" ? (
        <AgentEvalPlatformPanel
          projectId={projectId}
          evalDatasets={evalDatasets}
          evalRuns={evalRuns}
          onRefreshRuns={(id) => void loadEvalBoard(id)}
        />
      ) : null}

      {subView === "alerts" ? (
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
            <button
              className="qb-btn-secondary"
              type="button"
              disabled={loading}
              onClick={() => void onScanStuck()}
            >
              扫描卡住工作流
            </button>
          </div>
          {alerts.length === 0 ? (
            <div style={styles.empty}>当前筛选下暂无告警</div>
          ) : (
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
                      <button
                        className="qb-btn-secondary"
                        type="button"
                        onClick={() => void onAckAlert(alert.id)}
                      >
                        确认 (ack)
                      </button>
                    ) : null}
                    {alert.status !== "resolved" ? (
                      <button
                        className="qb-btn-secondary"
                        type="button"
                        onClick={() => void onResolveAlert(alert.id)}
                      >
                        关闭 (resolve)
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}

      {subView === "legacy" ? (
        <>
          <h3 className="qb-monitor__section" style={styles.subTitle}>
            评测报告（Legacy MSA/SDP/RFV）
          </h3>
          <div style={styles.form}>
            <input
              style={styles.input}
              value={datasetName}
              onChange={(e) => setDatasetName(e.target.value)}
            />
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
              <button
                key={run.id}
                type="button"
                className="qb-btn-card"
                onClick={() => void onOpenEvalRun(run.id)}
              >
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
      ) : null}
    </>
  );
};
