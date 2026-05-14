import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  AgentLoopKind,
  AgentRuntimeMetricRecord,
  AlertEventRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
  WorkflowMode,
  WorkflowQualitySnapshotRecord,
} from "../../api/types";
import {
  ackAlert,
  aggregateAgentQuality,
  createEvalDataset,
  createProject,
  createWorkflow,
  createWorkspace,
  createWorkflowQuality,
  getDefaultProjectSession,
  getEvalRunDetail,
  getWorkflowDetail,
  listAgents,
  listAgentQuality,
  listAlerts,
  listEvalDatasets,
  listEvalRuns,
  listMonitorWorkflows,
  listProjects,
  listWorkflowQuality,
  listWorkspaces,
  runEval,
  subscribeWorkflowStream,
  triggerWorkflowAlerts,
} from "../../api/backend";
import { groupStreamEventsByRun } from "../../lib/groupStreamEventsByRun";
import { useAppStore } from "../../store";
import { StreamTimelineGroupCard } from "../chat/StreamTimelineGroupCard";

type WorkflowRow = {
  id: string;
  status: string;
  mode: string;
  loopKind?: string;
  sessionId?: string | null;
  startedAt?: string | null;
  goal?: string | null;
};

function asWorkflowRows(rows: unknown[]): WorkflowRow[] {
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      status: String(o.status ?? ""),
      mode: String(o.mode ?? ""),
      loopKind: o.loopKind != null ? String(o.loopKind) : "native",
      sessionId: o.sessionId != null ? String(o.sessionId) : null,
      startedAt: o.startedAt != null ? String(o.startedAt) : null,
      goal: o.goal != null ? String(o.goal) : null,
    };
  });
}

const CHART_COLORS = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#a78bfa", "#ec4899"];

const monitorTooltipStyle: CSSProperties = {
  background: "var(--qb-main-card-bg, #18181b)",
  border: "1px solid var(--qb-main-input-border, #3f3f46)",
  color: "var(--qb-main-input-fg, #e4e4e7)",
};

const monitorGridStroke = "var(--qb-main-input-border, #27272a)";
const monitorAxisTick = { fill: "var(--qb-main-meta, #a1a1aa)", fontSize: 11 };

/** 监控视图维度：与数据粒度对应，便于扩展更多面板 */
type MonitorScope = "overview" | "workflow" | "agent" | "stream" | "alerts_eval";

const SCOPE_TABS: { id: MonitorScope; label: string; hint: string }[] = [
  { id: "overview", label: "整体", hint: "全局 KPI、工作流分布、指标聚合" },
  { id: "workflow", label: "工作流", hint: "列表、详情、质量快照、按工作流过滤 SSE" },
  { id: "agent", label: "Agent", hint: "注册实例、延迟与健康度（持久化指标）" },
  { id: "stream", label: "实时流", hint: "全局 SSE 折叠时间线" },
  { id: "alerts_eval", label: "告警与评测", hint: "告警确认、评测数据集与 run" },
];

export const MonitorDashboard: FC = () => {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const streamEvents = useAppStore((s) => s.streamEvents);
  const pushStreamEvent = useAppStore((s) => s.pushStreamEvent);
  const clearStreamEvents = useAppStore((s) => s.clearStreamEvents);

  const [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [goal, setGoal] = useState("Run orchestrator workflow");
  const [mode, setMode] = useState<WorkflowMode>("research");
  const [createLoopKind, setCreateLoopKind] = useState<AgentLoopKind>("native");
  const [sessionFilter, setSessionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [workflowList, setWorkflowList] = useState<WorkflowRow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [drawerDetail, setDrawerDetail] = useState("");
  const [qualitySnapshots, setQualitySnapshots] = useState<WorkflowQualitySnapshotRecord[]>([]);
  const [agentQuality, setAgentQuality] = useState<AgentRuntimeMetricRecord[]>([]);
  const [alerts, setAlerts] = useState<AlertEventRecord[]>([]);
  const [evalDatasets, setEvalDatasets] = useState<EvalDatasetRecord[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [evalRuns, setEvalRuns] = useState<EvalRunRecord[]>([]);
  const [evalRunCases, setEvalRunCases] = useState<EvalCaseResultRecord[]>([]);
  const [datasetName, setDatasetName] = useState("Default Eval Dataset");
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [metricsHint, setMetricsHint] = useState<string | null>(null);
  const [scope, setScope] = useState<MonitorScope>("overview");

  const monitorStreamGroups = useMemo(() => groupStreamEventsByRun(streamEvents, null), [streamEvents]);

  /** 当前选中工作流下的 SSE（未选中时为空，避免与「全局实时流」混淆） */
  const workflowScopedStreamGroups = useMemo(() => {
    if (!selectedWorkflowId) return [];
    return groupStreamEventsByRun(streamEvents, new Set([selectedWorkflowId]));
  }, [streamEvents, selectedWorkflowId]);

  const latestMetricsByDef = useMemo(() => {
    const m = new Map<string, AgentRuntimeMetricRecord & { role?: string; name?: string }>();
    for (const r of agentQuality) {
      const row = r as AgentRuntimeMetricRecord & { role?: string; name?: string };
      const prev = m.get(r.definitionId);
      if (!prev || new Date(r.createdAt).getTime() >= new Date(prev.createdAt).getTime()) {
        m.set(r.definitionId, row);
      }
    }
    return [...m.values()];
  }, [agentQuality]);

  const latencyBarData = useMemo(
    () =>
      latestMetricsByDef.slice(0, 12).map((r) => ({
        name: (r.role ?? r.definitionId).slice(0, 14),
        p50: Math.round(r.p50LatencyMs ?? 0),
        p95: Math.round(r.p95LatencyMs ?? 0),
      })),
    [latestMetricsByDef]
  );

  const healthPieData = useMemo(() => {
    let ok = 0;
    let err = 0;
    for (const r of latestMetricsByDef) {
      ok += r.successCount ?? 0;
      err += r.errorCount ?? 0;
    }
    if (ok === 0 && err === 0) {
      return [
        { name: "无聚合数据", value: 1 },
      ];
    }
    return [
      { name: "成功/停止", value: ok },
      { name: "错误/超时", value: err },
    ];
  }, [latestMetricsByDef]);

  const qualityLineData = useMemo(() => {
    const sorted = [...qualitySnapshots].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    return sorted.slice(-24).map((s, i) => ({
      idx: i + 1,
      score: Number(s.qualityScore.toFixed(4)),
      tools: s.totalToolCalls,
      errors: s.errorCount,
    }));
  }, [qualitySnapshots]);

  const kpis = useMemo(() => {
    const running = workflowList.filter((w) => w.status === "running").length;
    const failed = workflowList.filter((w) => w.status === "failed").length;
    return {
      total: workflowList.length,
      running,
      failed,
      openAlerts: alerts.filter((a) => a.status === "open").length,
      agents: agents.length,
    };
  }, [workflowList, alerts, agents]);

  const workflowStatusPie = useMemo(() => {
    const c = new Map<string, number>();
    for (const w of workflowList) {
      const k = w.status || "unknown";
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    const rows = [...c.entries()].map(([name, value]) => ({ name, value }));
    return rows.length ? rows : [{ name: "暂无工作流", value: 1 }];
  }, [workflowList]);

  const workflowModeBar = useMemo(() => {
    const c = new Map<string, number>();
    for (const w of workflowList) {
      const k = w.mode || "unknown";
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return [...c.entries()].map(([name, count]) => ({ name, count }));
  }, [workflowList]);

  const refreshMetrics = useCallback(async () => {
    try {
      const rows = await listAgentQuality();
      setAgentQuality(rows);
      if (rows.length === 0) {
        setMetricsHint("当前窗口无持久化指标，可点击下方「聚合过去24h」写入后再查看图表。");
      } else {
        setMetricsHint(null);
      }
    } catch {
      setMetricsHint("加载指标失败");
    }
  }, []);

  const onAggregateMetrics = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await aggregateAgentQuality({});
      setAgentQuality(rows);
      setMetricsHint(rows.length ? `已聚合并写入 ${rows.length} 条指标` : "聚合完成（本窗口无实例数据）");
    } catch (e) {
      setMetricsHint(e instanceof Error ? e.message : "聚合失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const onSearch = useCallback(async () => {
    const rows = await listMonitorWorkflows({
      sessionId: sessionFilter || undefined,
      status: statusFilter || undefined,
    });
    setWorkflowList(asWorkflowRows(rows as unknown[]));
  }, [sessionFilter, statusFilter]);

  useEffect(() => {
    void listAgents().then(setAgents).catch(console.error);
  }, [setAgents]);

  useEffect(() => {
    const boot = async () => {
      const workspaces = await listWorkspaces();
      let workspaceId = workspaces[0]?.id;
      if (!workspaceId) {
        const created = await createWorkspace({ name: "QUBIT Default Workspace", owner: "local-user" });
        workspaceId = created.data.id;
      }
      const projects = await listProjects(workspaceId);
      let pid = projects[0]?.id;
      if (!pid) {
        const created = await createProject({
          workspaceId,
          name: "QUBIT Default Project",
          marketScope: "CN-A",
        });
        pid = created.data.id;
      }
      setProjectId(pid);
      const defaultSession = await getDefaultProjectSession(pid);
      setSessionId(defaultSession.id);
      setSessionFilter(defaultSession.id);
    };
    void boot().catch(console.error);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      await onSearch();
      await refreshMetrics();
      setAlerts(await listAlerts({ status: "open" }));
      const datasets = await listEvalDatasets();
      setEvalDatasets(datasets);
      if (datasets[0]) {
        setSelectedDatasetId(datasets[0].id);
        setEvalRuns(await listEvalRuns(datasets[0].id));
      }
    })().catch(console.error);
  }, [projectId, onSearch, refreshMetrics]);

  useEffect(() => {
    if (!autoRefresh || !projectId) return;
    const t = window.setInterval(() => {
      void onSearch().catch(console.error);
    }, 12_000);
    return () => window.clearInterval(t);
  }, [autoRefresh, projectId, onSearch]);

  const onCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    clearStreamEvents();
    const created = await createWorkflow({
      projectId,
      goal,
      mode,
      sessionId: sessionId || undefined,
      source: "manual",
      loopKind: createLoopKind,
    });
    if (created.runId) {
      subscribeWorkflowStream({
        workflowId: created.data.id,
        runId: created.runId,
        onEvent: pushStreamEvent,
        onError: () => {},
      });
    }
    const detail = await getWorkflowDetail(created.data.id);
    setDrawerDetail(JSON.stringify(detail, null, 2));
    setSelectedWorkflowId(created.data.id);
    await onSearch();
  };

  const onSelectWorkflow = async (workflowId: string) => {
    setSelectedWorkflowId(workflowId);
    try {
      const detail = await getWorkflowDetail(workflowId);
      setDrawerDetail(JSON.stringify(detail, null, 2));
      const snaps = await listWorkflowQuality(workflowId);
      setQualitySnapshots(snaps);
    } catch (e) {
      setDrawerDetail(e instanceof Error ? e.message : "加载失败");
    }
  };

  const refreshAlerts = async () => {
    setAlerts(await listAlerts({ status: "open" }));
  };

  const onAckAlert = async (id: string) => {
    await ackAlert(id);
    await refreshAlerts();
  };

  const loadEvalBoard = async (datasetId?: string) => {
    const datasets = await listEvalDatasets();
    setEvalDatasets(datasets);
    const useDatasetId = datasetId ?? selectedDatasetId ?? datasets[0]?.id ?? "";
    if (!useDatasetId) return;
    setSelectedDatasetId(useDatasetId);
    setEvalRuns(await listEvalRuns(useDatasetId));
  };

  const onCreateDataset = async () => {
    const created = await createEvalDataset({ name: datasetName || "Eval Dataset" });
    setSelectedDatasetId(created.id);
    await loadEvalBoard(created.id);
  };

  const onRunEval = async () => {
    if (!selectedDatasetId) return;
    await runEval({
      datasetId: selectedDatasetId,
      caseCount: 20,
      toggle: { msa: true, sdp: true, rfv: true },
      baselineToggle: { msa: false, sdp: false, rfv: true },
    });
    await loadEvalBoard(selectedDatasetId);
  };

  const onOpenEvalRun = async (runId: string) => {
    const detail = await getEvalRunDetail(runId);
    setEvalRunCases(detail.cases);
  };

  const onCreateQuality = async (workflowId: string) => {
    await createWorkflowQuality(workflowId);
    const snaps = await listWorkflowQuality(workflowId);
    setQualitySnapshots(snaps);
    await triggerWorkflowAlerts(workflowId);
    await refreshAlerts();
    if (selectedWorkflowId === workflowId) {
      setQualitySnapshots(snaps);
    }
  };

  return (
    <div style={wrap}>
      <h2 style={styles.title}>运行监控</h2>
      <p style={styles.lead}>
        图表由开源库{" "}
        <a href="https://github.com/recharts/recharts" target="_blank" rel="noreferrer" style={{ color: "var(--qb-blue, #93c5fd)" }}>
          Recharts
        </a>{" "}
        （MIT）渲染；未嵌入 Grafana，避免 Tauri/前端再运维一套时序库。持久化指标来自 SQLite{" "}
        <code style={codeInline}>agent_runtime_metric</code> 等后端接口。
      </p>

      <div style={styles.tabBar} role="tablist" aria-label="监控维度">
        {SCOPE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={scope === t.id}
            title={t.hint}
            className={`qb-pill-tab${scope === t.id ? " qb-pill-tab--active" : ""}`}
            onClick={() => setScope(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={styles.scopeHint}>{SCOPE_TABS.find((x) => x.id === scope)?.hint}</div>

      {scope === "overview" ? (
        <>
          <h3 style={styles.subTitle}>整体 · 运行态势</h3>
          <div style={styles.kpiRow}>
            <Kpi label="工作流总数" value={String(kpis.total)} />
            <Kpi label="运行中" value={String(kpis.running)} accent="#22c55e" />
            <Kpi label="失败" value={String(kpis.failed)} accent="#ef4444" />
            <Kpi label="未关闭告警" value={String(kpis.openAlerts)} accent="#eab308" />
            <Kpi label="已注册 Agent" value={String(kpis.agents)} />
          </div>

          <div style={styles.chartGrid}>
            <div style={styles.chartBox}>
              <div style={styles.chartTitle}>工作流列表 · 按状态分布（当前筛选结果）</div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={workflowStatusPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={72} label>
                    {workflowStatusPie.map((_, i) => (
                      <Cell key={String(i)} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={monitorTooltipStyle} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={styles.chartBox}>
              <div style={styles.chartTitle}>工作流列表 · 按模式数量</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={workflowModeBar}>
                  <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
                  <XAxis dataKey="name" tick={monitorAxisTick} />
                  <YAxis allowDecimals={false} tick={monitorAxisTick} />
                  <Tooltip contentStyle={monitorTooltipStyle} />
                  <Bar dataKey="count" name="数量" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <h3 style={styles.subTitle}>整体 · 指标聚合（写入 Agent 维度指标）</h3>
          <div style={styles.form}>
            <button className="qb-btn-secondary" type="button" onClick={() => void onSearch()}>
              刷新工作流列表
            </button>
            <button className="qb-btn-secondary" type="button" onClick={() => void refreshMetrics()}>
              刷新指标
            </button>
            <button className="qb-btn-primary-brand" type="button" disabled={loading} onClick={() => void onAggregateMetrics()}>
              {loading ? "聚合中…" : "聚合过去24h并刷新"}
            </button>
          </div>
          {metricsHint ? <div style={styles.hint}>{metricsHint}</div> : null}

          <h3 style={styles.subTitle}>整体 · 新建工作流并订阅 SSE</h3>
          <form style={styles.form} onSubmit={(e) => void onCreate(e)}>
            <input style={styles.input} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="工作流目标" />
            <select style={styles.select} value={mode} onChange={(e) => setMode(e.target.value as WorkflowMode)}>
              <option value="research">research</option>
              <option value="backtest">backtest</option>
              <option value="simulation">simulation</option>
              <option value="live">live</option>
            </select>
            <select
              style={styles.select}
              value={createLoopKind}
              onChange={(e) => setCreateLoopKind(e.target.value as AgentLoopKind)}
              title="Agent 执行循环"
            >
              <option value="native">loop: native</option>
              <option value="claude_cli">loop: claude_cli</option>
              <option value="codex_cli">loop: codex_cli</option>
            </select>
            <button className="qb-btn-primary-brand" type="submit" disabled={!projectId}>
              创建并订阅 SSE
            </button>
            <label style={styles.check}>
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              每 12s 自动刷新列表
            </label>
          </form>
        </>
      ) : null}

      {scope === "workflow" ? (
        <>
          <h3 style={styles.subTitle}>工作流 · 筛选与列表</h3>
          <div style={styles.form}>
            <input
              style={styles.input}
              placeholder="sessionId"
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="status (running/failed/...)"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            />
            <button className="qb-btn-secondary" type="button" onClick={() => void onSearch()}>
              查询
            </button>
          </div>

          <div style={styles.split}>
            <section style={styles.col}>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>状态</th>
                      <th style={styles.th}>模式</th>
                      <th style={styles.th}>Loop</th>
                      <th style={styles.th}>开始时间</th>
                      <th style={styles.th}>ID</th>
                      <th style={styles.th}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflowList.map((row) => (
                      <tr
                        key={row.id}
                        style={{
                          ...styles.tr,
                          ...(selectedWorkflowId === row.id ? styles.trSelected : {}),
                        }}
                        onClick={() => void onSelectWorkflow(row.id)}
                      >
                        <td style={styles.td}>{row.status}</td>
                        <td style={styles.td}>{row.mode}</td>
                        <td style={styles.td}>{row.loopKind ?? "native"}</td>
                        <td style={styles.td}>{row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}</td>
                        <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }} title={row.id}>
                          {row.id.slice(0, 10)}…
                        </td>
                        <td style={styles.td}>
                          <button
                            type="button"
                            className="qb-btn-mini"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onCreateQuality(row.id);
                            }}
                          >
                            快照+告警
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {workflowList.length === 0 ? <div style={styles.empty}>暂无数据，请调整筛选或在「整体」中新建</div> : null}
              </div>
            </section>

            <section style={styles.col}>
              <h3 style={{ ...styles.subTitle, marginTop: 0 }}>工作流 · 质量快照趋势</h3>
              {qualityLineData.length > 0 ? (
                <div style={styles.chartBox}>
                  <div style={styles.chartTitle}>
                    {selectedWorkflowId ? `已选 ${selectedWorkflowId.slice(0, 8)}…` : "未选中"} · qualityScore
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={qualityLineData}>
                      <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
                      <XAxis dataKey="idx" tick={monitorAxisTick} />
                      <YAxis domain={[0, 1]} tick={monitorAxisTick} />
                      <Tooltip contentStyle={monitorTooltipStyle} />
                      <Legend />
                      <Line type="monotone" dataKey="score" name="质量分" stroke="#22c55e" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="tools" name="工具调用数" stroke="#3b82f6" strokeWidth={1} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div style={styles.hint}>选中一行并生成快照后显示趋势</div>
              )}
              <h3 style={styles.subTitle}>工作流 · 详情（JSON）</h3>
              <pre style={styles.streamBox}>{drawerDetail || "点击表格一行加载详情…"}</pre>
            </section>
          </div>

          <h3 style={styles.subTitle}>工作流 · SSE（仅当前选中 workflow）</h3>
          <div style={styles.streamList}>
            {!selectedWorkflowId ? (
              <div style={styles.empty}>请先在表格中选择一条工作流</div>
            ) : workflowScopedStreamGroups.length === 0 ? (
              <div style={styles.empty}>该工作流暂无本地缓存的流事件（可在「整体」新建并订阅或从对话触发）</div>
            ) : (
              workflowScopedStreamGroups
                .slice()
                .sort((a, b) => b.at - a.at)
                .slice(0, 20)
                .map((g) => <StreamTimelineGroupCard key={`${g.workflowRunId}-${g.runId}`} item={g} />)
            )}
          </div>
        </>
      ) : null}

      {scope === "agent" ? (
        <>
          <h3 style={styles.subTitle}>Agent · 持久化指标</h3>
          <div style={styles.form}>
            <button className="qb-btn-secondary" type="button" onClick={() => void refreshMetrics()}>
              刷新指标
            </button>
            <button className="qb-btn-primary-brand" type="button" disabled={loading} onClick={() => void onAggregateMetrics()}>
              {loading ? "聚合中…" : "聚合过去24h并刷新"}
            </button>
          </div>
          {metricsHint ? <div style={styles.hint}>{metricsHint}</div> : null}

          <div style={styles.chartGrid}>
            <div style={styles.chartBox}>
              <div style={styles.chartTitle}>P50 / P95 工具延迟（按 definition / 角色）</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={latencyBarData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
                  <XAxis
                    dataKey="name"
                    tick={{ ...monitorAxisTick, fontSize: 10 }}
                    interval={0}
                    angle={-18}
                    dy={8}
                    height={60}
                  />
                  <YAxis tick={monitorAxisTick} />
                  <Tooltip contentStyle={monitorTooltipStyle} />
                  <Legend />
                  <Bar dataKey="p50" name="p50 ms" fill="#3b82f6" />
                  <Bar dataKey="p95" name="p95 ms" fill="#a78bfa" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={styles.chartBox}>
              <div style={styles.chartTitle}>成功 vs 错误（聚合窗口汇总）</div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={healthPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={72} label>
                    {healthPieData.map((_, i) => (
                      <Cell key={String(i)} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={monitorTooltipStyle} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          <h3 style={styles.subTitle}>Agent · 注册实例（运行时列表）</h3>
          <div style={styles.grid}>
            {agents.map((a) => (
              <div key={a.id} style={styles.card}>
                <div style={styles.cardName}>{a.role}</div>
                <div style={styles.cardDesc}>
                  {a.running ? "running" : "stopped"} · {a.version}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {scope === "stream" ? (
        <>
          <h3 style={styles.subTitle}>实时流 · 全局 SSE（按 run 折叠）</h3>
          <div style={styles.form}>
            <button className="qb-btn-secondary" type="button" onClick={() => clearStreamEvents()}>
              清空本地流
            </button>
          </div>
          <div style={styles.streamList}>
            {monitorStreamGroups.length === 0 ? (
              <div style={styles.empty}>暂无事件，在「整体」创建并订阅工作流后将在此显示</div>
            ) : (
              monitorStreamGroups
                .slice()
                .sort((a, b) => b.at - a.at)
                .slice(0, 20)
                .map((g) => <StreamTimelineGroupCard key={`${g.workflowRunId}-${g.runId}`} item={g} />)
            )}
          </div>
        </>
      ) : null}

      {scope === "alerts_eval" ? (
        <>
          <h3 style={styles.subTitle}>告警中心</h3>
          <div style={styles.form}>
            <button className="qb-btn-secondary" type="button" onClick={() => void refreshAlerts()}>
              刷新告警
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
                  <button className="qb-btn-secondary" type="button" onClick={() => void onAckAlert(alert.id)}>
                    确认 (ack)
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h3 style={styles.subTitle}>评测报告</h3>
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
            <button className="qb-btn-primary-brand" type="button" onClick={() => void onRunEval()} disabled={!selectedDatasetId}>
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
      ) : null}
    </div>
  );
};

const Kpi: FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div style={{ ...styles.kpi, borderColor: accent ?? "var(--qb-main-input-border, #3f3f46)" }}>
    <div style={styles.kpiLabel}>{label}</div>
    <div style={{ ...styles.kpiValue, color: accent ?? "var(--qb-body-fg, #f4f4f5)" }}>{value}</div>
  </div>
);

const wrap: CSSProperties = { maxWidth: 1200, margin: "0 auto" };

const styles: Record<string, CSSProperties> = {
  title: { fontSize: 26, fontWeight: 700, margin: "0 0 8px", color: "var(--qb-monitor-title-fg, inherit)" },
  lead: { fontSize: 13, color: "var(--qb-monitor-lead-fg, #a1a1aa)", lineHeight: 1.5, marginBottom: 16 },
  kpiRow: { display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  kpi: {
    flex: "1 1 120px",
    minWidth: 100,
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-card-bg, #111114)",
  },
  kpiLabel: { fontSize: 11, color: "var(--qb-main-meta, #71717a)", marginBottom: 4 },
  kpiValue: { fontSize: 22, fontWeight: 700 },
  form: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" },
  input: {
    flex: 1,
    minWidth: 160,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  select: {
    minWidth: 140,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  subTitle: { fontSize: 16, margin: "18px 0 8px", fontWeight: 600, color: "var(--qb-monitor-title-fg, inherit)" },
  split: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)", gap: 20 },
  col: { minWidth: 0 },
  tableWrap: {
    maxHeight: 320,
    overflow: "auto",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    background: "var(--qb-stream-box-bg, #1f1f23)",
    color: "var(--qb-main-meta, #a1a1aa)",
    position: "sticky",
    top: 0,
  },
  td: { padding: "8px 10px", borderTop: "1px solid var(--qb-main-input-border, #27272a)", color: "var(--qb-main-input-fg, #e4e4e7)" },
  tr: { cursor: "pointer" },
  trSelected: { background: "var(--qb-tint-strong, rgba(99, 102, 241, 0.12))" },
  empty: { padding: 16, color: "var(--qb-main-meta, #71717a)", fontSize: 13 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 },
  card: {
    background: "var(--qb-main-card-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    padding: 10,
  },
  cardName: { fontWeight: 600, fontSize: 13, marginBottom: 4, color: "var(--qb-body-fg, inherit)" },
  cardDesc: { fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  chartGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 8 },
  chartBox: {
    background: "var(--qb-main-card-bg, #111114)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 10,
    padding: "10px 12px 4px",
    minHeight: 260,
  },
  chartTitle: { fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)", marginBottom: 6 },
  hint: { fontSize: 12, color: "#eab308", marginBottom: 8 },
  streamList: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflow: "auto" },
  streamBox: {
    background: "var(--qb-stream-box-bg, #0c0c0e)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    padding: 12,
    maxHeight: 280,
    overflow: "auto",
    fontSize: 11,
    color: "var(--qb-stream-box-fg, #d4d4d8)",
    whiteSpace: "pre-wrap",
  },
  tabBar: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  scopeHint: { fontSize: 12, color: "var(--qb-main-meta, #71717a)", marginBottom: 14 },
};

const codeInline: CSSProperties = {
  margin: "0 4px",
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--qb-monitor-code-bg, #27272a)",
  fontSize: 12,
};
