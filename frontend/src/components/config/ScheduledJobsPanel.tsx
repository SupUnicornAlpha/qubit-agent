import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  createScheduledJob,
  deleteScheduledJob,
  listScheduledJobRuns,
  listScheduledJobs,
  patchScheduledJob,
  runScheduledJobNow,
} from "../../api/backend";
import type { ScheduledJobRecord, ScheduledJobRunRecord } from "../../api/types";

const DEFAULT_CRON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "*/1 * * * *", label: "每分钟（调试用）" },
  { value: "*/5 * * * *", label: "每 5 分钟" },
  { value: "*/15 * * * *", label: "每 15 分钟" },
  { value: "*/30 * * * *", label: "每 30 分钟" },
  { value: "0 * * * *", label: "每小时整点（暂不支持，仅占位提示）" },
  { value: "custom", label: "自定义 …" },
];

const EXEC_MODE_LABEL: Record<ScheduledJobRecord["executionMode"], string> = {
  paper: "纸面回放",
  live_with_confirm: "实盘需确认",
  live_direct: "实盘直发",
};

const RUN_STATUS_COLOR: Record<ScheduledJobRunRecord["status"], string> = {
  pending: "#a1a1aa",
  running: "#60a5fa",
  success: "#10b981",
  failed: "#ef4444",
  skipped: "#f59e0b",
};

const DEFAULT_PAYLOAD = {
  goal: "交易时段内，基于新闻 / 重大事件 / K 线异动触发分析并决定是否挂单",
  mode: "research" as const,
  triggerDriven: true,
  triggerSources: ["news", "event", "kline"],
  newsLookbackMinutes: 30,
  eventLookbackMinutes: 60,
  klineLookbackMinutes: 15,
  klineKeywords: ["kline", "price_break", "volatility_spike"],
  timezone: "Asia/Shanghai",
  tradingDays: [1, 2, 3, 4, 5],
  tradingStart: "09:30",
  tradingEnd: "16:00",
  ticker: "AAPL",
  direction: "long" as const,
  quantity: 1,
  targetPrice: 100,
  brokerProvider: "futu" as const,
};

const RECONCILIATION_PAYLOAD = {
  kind: "position_reconciliation" as const,
  provider: "futu" as const,
  accountRef: "",
};

function scheduledJobKind(payload: Record<string, unknown>): "workflow" | "position_reconciliation" {
  return payload.kind === "position_reconciliation" ? "position_reconciliation" : "workflow";
}

interface ScheduledJobsPanelProps {
  workspaceId?: string;
  projectId?: string | null;
}

export const ScheduledJobsPanel: FC<ScheduledJobsPanelProps> = ({ workspaceId, projectId }) => {
  const [jobs, setJobs] = useState<ScheduledJobRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [runs, setRuns] = useState<ScheduledJobRunRecord[]>([]);
  const [name, setName] = useState("定时分析任务");
  const [cron, setCron] = useState("*/5 * * * *");
  const [cronChoice, setCronChoice] = useState("*/5 * * * *");
  const [execMode, setExecMode] = useState<ScheduledJobRecord["executionMode"]>("paper");
  const [payload, setPayload] = useState(() => JSON.stringify(DEFAULT_PAYLOAD, null, 2));
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const reload = async () => {
    if (!workspaceId || !projectId) {
      setJobs([]);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fresh = await listScheduledJobs({ workspaceId, projectId });
      setJobs(fresh);
      if (!selectedId && fresh[0]) {
        setSelectedId(fresh[0].id);
        setRuns(await listScheduledJobRuns(fresh[0].id));
      } else if (selectedId) {
        const matched = fresh.find((j) => j.id === selectedId);
        if (matched) setRuns(await listScheduledJobRuns(matched.id));
      }
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, projectId]);

  const selectedJob = useMemo(() => jobs.find((j) => j.id === selectedId) ?? null, [jobs, selectedId]);

  const onCreate = async () => {
    if (!workspaceId || !projectId) {
      setError("当前 workspace/project 未就绪");
      return;
    }
    let parsed: Record<string, unknown> = {};
    setPayloadError(null);
    try {
      parsed = payload.trim() ? (JSON.parse(payload) as Record<string, unknown>) : {};
    } catch (err) {
      setPayloadError("payload JSON 无法解析：" + (err as Error).message);
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const created = await createScheduledJob({
        workspaceId,
        projectId,
        name: name.trim() || "scheduled-job",
        cronExpr: cron.trim(),
        executionMode: execMode,
        payloadJson: parsed,
        enabled: true,
      });
      setSelectedId(created.id);
      setOkMsg(`已创建：${created.name}`);
      await reload();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRunNow = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await runScheduledJobNow(selectedId);
      setRuns(await listScheduledJobRuns(selectedId));
      setOkMsg("已触发执行 ✓");
      await reload();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (enabled: boolean) => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await patchScheduledJob(selectedId, { enabled });
      await reload();
      setOkMsg(enabled ? "已启用" : "已停用");
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onPatchPayload = async () => {
    if (!selectedId) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = payload.trim() ? (JSON.parse(payload) as Record<string, unknown>) : {};
    } catch (err) {
      setPayloadError("payload JSON 无法解析：" + (err as Error).message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchScheduledJob(selectedId, {
        name: name.trim() || undefined,
        cronExpr: cron.trim() || undefined,
        executionMode: execMode,
        payloadJson: parsed,
      });
      setOkMsg("配置已更新");
      await reload();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!selectedId) return;
    if (!window.confirm("删除该定时任务及其执行历史？此操作不可恢复。")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteScheduledJob(selectedId);
      setOkMsg("已删除");
      setSelectedId("");
      setRuns([]);
      await reload();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onPickJob = async (id: string) => {
    setSelectedId(id);
    if (!id) {
      setRuns([]);
      return;
    }
    const job = jobs.find((j) => j.id === id);
    if (job) {
      setName(job.name);
      setCron(job.cronExpr);
      setCronChoice(DEFAULT_CRON_OPTIONS.some((opt) => opt.value === job.cronExpr) ? job.cronExpr : "custom");
      setExecMode(job.executionMode);
      try {
        setPayload(JSON.stringify(job.payloadJson ?? {}, null, 2));
      } catch {
        setPayload("{}");
      }
    }
    try {
      setRuns(await listScheduledJobRuns(id));
    } catch (err) {
      setError((err as Error).message || String(err));
    }
  };

  return (
    <div data-qb-scheduled-panel>
      <h3 style={styles.subTitle}>定时任务</h3>
      <p className="qb-config-hint">
        基于 cron 的定时编排：在交易时段内按触发源（新闻 / 事件 / K 线异动）判断是否拉起 workflow，
        可选纸面回放 / 实盘需确认 / 实盘直发。后台调度器每分钟扫描一次，逾期任务会立即补跑。
      </p>

      {!workspaceId || !projectId ? (
        <div style={styles.errorBox}>
          当前 workspace / project 未就绪，请先在「LLM / 数据源」标签初始化或在主菜单触发引导流程。
        </div>
      ) : null}

      <div style={styles.twoCol}>
        {/* 左：任务列表 */}
        <div style={styles.leftCol}>
          <div style={styles.colHeader}>
            <span style={styles.colTitle}>任务列表（{jobs.length}）</span>
            <button
              type="button"
              className="qb-btn-secondary"
              onClick={() => {
                setSelectedId("");
                setRuns([]);
                setName("新建定时任务");
                setCron("*/5 * * * *");
                setCronChoice("*/5 * * * *");
                setExecMode("paper");
                setPayload(JSON.stringify(DEFAULT_PAYLOAD, null, 2));
              }}
            >
              + 新建
            </button>
          </div>
          {jobs.length === 0 ? (
            <p className="qb-config-hint">还没有定时任务。在右侧填写参数后点击「创建定时任务」。</p>
          ) : (
            <ul style={styles.jobList}>
              {jobs.map((job) => {
                const active = job.id === selectedId;
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => void onPickJob(job.id)}
                      style={{
                        ...styles.jobItem,
                        borderColor: active ? "#60a5fa" : "var(--qb-stream-box-border, #27272a)",
                        background: active ? "rgba(96,165,250,0.06)" : "transparent",
                      }}
                    >
                      <div style={styles.jobTitleRow}>
                        <span style={{ fontWeight: 600 }}>{job.name}</span>
                        <span
                          style={{
                            ...styles.statusBadge,
                            color: job.enabled ? "#10b981" : "#71717a",
                            borderColor: job.enabled ? "#10b98166" : "#71717a55",
                          }}
                        >
                          {job.enabled ? "ENABLED" : "DISABLED"}
                        </span>
                      </div>
                      <div style={styles.jobMeta}>
                        <code style={styles.code}>{job.cronExpr}</code>
                        <span style={styles.metaPill}>{EXEC_MODE_LABEL[job.executionMode]}</span>
                      </div>
                      <div style={styles.jobMetaSmall}>
                        下次：{job.nextRunAt ?? "—"} · 上次：{job.lastRunAt ?? "—"}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 右：编辑表单 */}
        <div style={styles.rightCol}>
          <div style={styles.colHeader}>
            <span style={styles.colTitle}>{selectedJob ? "编辑任务" : "新建任务"}</span>
            {selectedJob ? (
              <span style={{ fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)" }}>id={selectedJob.id.slice(0, 8)}…</span>
            ) : null}
          </div>

          <div style={styles.row}>
            <label style={{ ...styles.fieldLabel, flex: 1 }}>
              任务模板
              <select
                style={styles.input}
                value={(() => {
                  try {
                    return scheduledJobKind(JSON.parse(payload) as Record<string, unknown>);
                  } catch {
                    return "workflow";
                  }
                })()}
                onChange={(event) => {
                  if (event.target.value === "position_reconciliation") {
                    setName("券商持仓自动对账");
                    setExecMode("paper");
                    setPayload(JSON.stringify(RECONCILIATION_PAYLOAD, null, 2));
                  } else {
                    setName("定时分析任务");
                    setPayload(JSON.stringify(DEFAULT_PAYLOAD, null, 2));
                  }
                  setPayloadError(null);
                }}
              >
                <option value="workflow">研究 / 交易 workflow</option>
                <option value="position_reconciliation">券商持仓自动对账</option>
              </select>
            </label>
            <label style={{ ...styles.fieldLabel, flex: 2 }}>
              任务名称
              <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label style={{ ...styles.fieldLabel, flex: 1 }}>
              Cron 表达式
              <select
                style={styles.input}
                value={cronChoice}
                onChange={(e) => {
                  const v = e.target.value;
                  setCronChoice(v);
                  if (v !== "custom") setCron(v);
                }}
              >
                {DEFAULT_CRON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {cronChoice === "custom" ? (
                <input
                  style={{ ...styles.input, marginTop: 4 }}
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="支持 * * * * * 或 */N * * * *"
                />
              ) : null}
            </label>
            <label style={{ ...styles.fieldLabel, flex: 1 }}>
              执行模式
              <select
                style={styles.input}
                value={execMode}
                onChange={(e) => setExecMode(e.target.value as ScheduledJobRecord["executionMode"])}
              >
                <option value="paper">{EXEC_MODE_LABEL.paper}</option>
                <option value="live_with_confirm">{EXEC_MODE_LABEL.live_with_confirm}</option>
                <option value="live_direct">{EXEC_MODE_LABEL.live_direct}</option>
              </select>
            </label>
          </div>

          <label style={styles.fieldLabel}>
            Payload（JSON）
            <textarea
              style={{ ...styles.input, minHeight: 220, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
              value={payload}
              onChange={(e) => {
                setPayload(e.target.value);
                setPayloadError(null);
              }}
              spellCheck={false}
            />
            <span style={styles.fieldHint}>
              研究任务支持 goal / mode / ticker / triggerSources / trading window；持仓对账支持
              kind=position_reconciliation / provider / accountRef。模板已生成可直接运行的 JSON。
            </span>
            {payloadError ? <span style={{ color: "#fca5a5", fontSize: 12 }}>{payloadError}</span> : null}
          </label>

          <div style={styles.actionsRow}>
            {selectedJob ? (
              <>
                <button type="button" className="qb-btn-primary-brand" onClick={() => void onPatchPayload()} disabled={busy}>
                  保存修改
                </button>
                <button type="button" className="qb-btn-secondary" onClick={() => void onRunNow()} disabled={busy}>
                  立即执行
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  onClick={() => void onToggle(!selectedJob.enabled)}
                  disabled={busy}
                >
                  {selectedJob.enabled ? "停用" : "启用"}
                </button>
                <button type="button" className="qb-btn-secondary" onClick={() => void onDelete()} disabled={busy}>
                  删除
                </button>
              </>
            ) : (
              <button type="button" className="qb-btn-primary-brand" onClick={() => void onCreate()} disabled={busy}>
                创建定时任务
              </button>
            )}
          </div>

          {error ? <div style={styles.errorBox}>错误：{error}</div> : null}
          {okMsg ? <div style={styles.okBox}>{okMsg}</div> : null}
        </div>
      </div>

      {/* 运行历史 */}
      <div style={{ marginTop: 16 }}>
        <div style={styles.colHeader}>
          <span style={styles.colTitle}>
            执行历史{selectedJob ? `（${selectedJob.name}）` : ""}
          </span>
          <button type="button" className="qb-btn-secondary" onClick={() => void reload()} disabled={busy}>
            刷新
          </button>
        </div>
        {!selectedJob ? (
          <p className="qb-config-hint">选择左侧任务查看历史。</p>
        ) : runs.length === 0 ? (
          <p className="qb-config-hint">暂无执行记录。</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="qb-config-table" style={styles.runsTable}>
              <thead>
                <tr>
                  <th style={styles.th}>触发时间</th>
                  <th style={styles.th}>状态</th>
                  <th style={styles.th}>开始 / 结束</th>
                  <th style={styles.th}>workflow_run</th>
                  <th style={styles.th}>意图单 / 执行单</th>
                  <th style={styles.th}>说明</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td style={styles.td}>{run.triggerAt}</td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.statusBadge,
                          color: RUN_STATUS_COLOR[run.status],
                          borderColor: `${RUN_STATUS_COLOR[run.status]}55`,
                        }}
                      >
                        {run.status.toUpperCase()}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <div>{run.startedAt ?? "—"}</div>
                      <div style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>{run.endedAt ?? "—"}</div>
                    </td>
                    <td style={styles.td}>
                      {run.workflowRunId ? <code style={styles.code}>{run.workflowRunId.slice(0, 8)}…</code> : "—"}
                    </td>
                    <td style={styles.td}>
                      <div>意图：{run.intentOrderId ? run.intentOrderId.slice(0, 8) + "…" : "—"}</div>
                      <div style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>
                        执行：{run.executionReportId ? run.executionReportId.slice(0, 8) + "…" : "—"}
                      </div>
                    </td>
                    <td style={{ ...styles.td, maxWidth: 280 }} title={run.errorMessage ?? ""}>
                      {run.errorMessage ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  subTitle: { fontSize: 16, margin: "16px 0 8px", color: "var(--qb-body-fg)" },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, 340px) 1fr",
    gap: 12,
    alignItems: "stretch",
    marginTop: 8,
  },
  leftCol: {
    background: "var(--qb-stream-box-bg, rgba(255,255,255,0.02))",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 320,
  },
  rightCol: {
    background: "var(--qb-stream-box-bg, rgba(255,255,255,0.02))",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 8,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  colHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  colTitle: { fontSize: 13, fontWeight: 700, color: "var(--qb-body-fg)" },
  jobList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflowY: "auto",
    maxHeight: 480,
  },
  jobItem: {
    width: "100%",
    textAlign: "left",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 10px",
    background: "transparent",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 6,
    color: "var(--qb-body-fg)",
    cursor: "pointer",
    fontSize: 12,
  },
  jobTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
  jobMeta: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  jobMetaSmall: { fontSize: 10, color: "var(--qb-main-meta, #a1a1aa)" },
  metaPill: {
    fontSize: 10,
    padding: "1px 6px",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 4,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 6px",
    border: "1px solid",
    borderRadius: 4,
    letterSpacing: "0.04em",
  },
  row: { display: "flex", gap: 8, alignItems: "flex-start" },
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  fieldHint: { fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)" },
  input: {
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12,
    width: "100%",
    boxSizing: "border-box",
  },
  actionsRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 11,
    background: "rgba(255,255,255,0.06)",
    padding: "1px 6px",
    borderRadius: 4,
  },
  errorBox: {
    padding: 8,
    background: "rgba(239, 68, 68, 0.12)",
    border: "1px solid rgba(239, 68, 68, 0.35)",
    borderRadius: 6,
    fontSize: 12,
    color: "#fca5a5",
  },
  okBox: {
    padding: 8,
    background: "rgba(16, 185, 129, 0.10)",
    border: "1px solid rgba(16, 185, 129, 0.35)",
    borderRadius: 6,
    fontSize: 12,
    color: "#34d399",
  },
  runsTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
  },
  th: { textAlign: "left", padding: "6px 8px", fontWeight: 600 },
  td: { padding: "6px 8px", verticalAlign: "top" },
};
