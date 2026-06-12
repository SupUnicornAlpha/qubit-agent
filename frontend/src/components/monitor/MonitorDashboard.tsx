/**
 * 监控总入口：状态/数据加载 + tab 路由协调器。
 *
 * 历史：本文件曾达 1481 行。2026-05 拆分为：
 *   - monitor-shared.tsx   通用类型 / 工具 / styles / Kpi / AgentRuntimeCard / AgentPoolSection
 *   - OverviewTab.tsx      整体 KPI 与新建工作流
 *   - WorkflowTab.tsx      列表 / 详情 / 质量 / observability / scoped 流
 *   - AgentTab.tsx         持久化指标 / 长驻池 / 会话工作流实例
 *   - StreamTab.tsx        全局 SSE
 *   - AlertsEvalTab.tsx    告警与评测
 *
 * 本次拆分仅做机械搬迁；逻辑与渲染输出与拆分前完全等价。
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentLoopKind,
  AgentRuntimeMetricRecord,
  AgentSummary,
  AlertEventRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
  SessionAgentBoardItem,
  WorkflowMode,
  WorkflowObservability,
  WorkflowQualitySnapshotRecord,
} from "../../api/types";
import {
  ackAlert,
  aggregateAgentQuality,
  createEvalDataset,
  getOrCreateDefaultProject,
  createWorkflow,
  createWorkflowQuality,
  getDefaultProjectSession,
  getDefaultWorkspace,
  getEvalRunDetail,
  getMonitorSummary,
  getSessionAgentsBoard,
  getWorkflowDetail,
  getWorkflowObservability,
  listAgents,
  listAgentQuality,
  listAlerts,
  listEvalDatasets,
  listEvalRuns,
  listMonitorWorkflows,
  listProjects,
  listStrategyRuntimes,
  listWorkflowQuality,
  listWorkspaces,
  resolveAlert,
  runEval,
  scanStuckWorkflowAlerts,
  subscribeWorkflowStream,
  triggerWorkflowAlerts,
  type MonitorSummary,
} from "../../api/backend";
import { groupStreamEventsByRun } from "../../lib/groupStreamEventsByRun";
import { useAppStore } from "../../store";
import {
  SCOPE_TABS,
  asWorkflowRows,
  buildAgentCardViews,
  resolvePoolExecutionPath,
  styles,
  wrap,
  type MonitorScope,
  type WorkflowRow,
} from "./monitor-shared";
import { OverviewTab, type StrategyRuntime } from "./OverviewTab";
import { WorkflowTab } from "./WorkflowTab";
import { AgentTab } from "./AgentTab";
import { SkillsTab } from "./SkillsTab";
import { MemoryTab } from "./MemoryTab";
import { DiagnosticsTab } from "./DiagnosticsTab";
import { StreamTab } from "./StreamTab";
import { AlertsEvalTab, type AlertStatusFilter } from "./AlertsEvalTab";

export const MonitorDashboard: FC = () => {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const streamEvents = useAppStore((s) => s.streamEvents);
  const pushStreamEvent = useAppStore((s) => s.pushStreamEvent);
  const clearStreamEvents = useAppStore((s) => s.clearStreamEvents);

  const [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  /**
   * 项目/工作空间切换：
   *
   * 历史 bug：boot() 把第一个 workspace × 第一个 project × **默认 session** 一把锁死塞进
   * sessionFilter，导致任何"在隔离 project（如 agent-eval-batch-3）下跑出的 workflow"
   * 全部不可见 —— 因为它们 session_id 为空 / 在不同 project，永远匹配不上 sessionFilter。
   *
   * 修复策略：把 workspace/project 选择提取成顶层 toolbar，让用户能切；列表层默认按
   * projectId 过滤而非 sessionId，session 维度仅作为可选下钻。
   */
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [goal, setGoal] = useState("Run orchestrator workflow");
  const [mode, setMode] = useState<WorkflowMode>("research");
  const [createLoopKind, setCreateLoopKind] = useState<AgentLoopKind>("native");
  const [sessionFilter, setSessionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [workflowList, setWorkflowList] = useState<WorkflowRow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [drawerDetail, setDrawerDetail] = useState("");
  const [workflowObservability, setWorkflowObservability] = useState<WorkflowObservability | null>(null);
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
  const [strategyRuntimes, setStrategyRuntimes] = useState<StrategyRuntime[]>([]);
  const [summary, setSummary] = useState<MonitorSummary | null>(null);
  const [alertStatusFilter, setAlertStatusFilter] = useState<AlertStatusFilter>("open");
  const [sessionAgentsBoard, setSessionAgentsBoard] = useState<SessionAgentBoardItem[]>([]);

  const monitorStreamGroups = useMemo(() => groupStreamEventsByRun(streamEvents, null), [streamEvents]);

  /** 当前选中工作流下的 SSE（未选中时为空，避免与「全局实时流」混淆） */
  const workflowScopedStreamGroups = useMemo(() => {
    if (!selectedWorkflowId) return [];
    return groupStreamEventsByRun(streamEvents, new Set([selectedWorkflowId]));
  }, [streamEvents, selectedWorkflowId]);

  const metricsByDefinitionId = useMemo(() => {
    const m = new Map<string, AgentRuntimeMetricRecord & { role?: string; name?: string }>();
    for (const r of agentQuality) {
      const row = r as AgentRuntimeMetricRecord & { role?: string; name?: string };
      const prev = m.get(r.definitionId);
      if (!prev || new Date(r.createdAt).getTime() >= new Date(prev.createdAt).getTime()) {
        m.set(r.definitionId, row);
      }
    }
    return m;
  }, [agentQuality]);

  const latestMetricsByDef = useMemo(() => [...metricsByDefinitionId.values()], [metricsByDefinitionId]);

  const agentCardViews = useMemo(
    () => buildAgentCardViews(agents, metricsByDefinitionId),
    [agents, metricsByDefinitionId]
  );

  const a2aAgentCards = useMemo(
    () => agentCardViews.filter((a) => resolvePoolExecutionPath(a) === "a2a"),
    [agentCardViews]
  );
  const legacyAgentCards = useMemo(
    () => agentCardViews.filter((a) => resolvePoolExecutionPath(a) === null),
    [agentCardViews]
  );

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
      return [{ name: "无聚合数据", value: 1 }];
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
    const running = summary?.running ?? workflowList.filter((w) => w.status === "running").length;
    const failed = summary?.failed ?? workflowList.filter((w) => w.status === "failed").length;
    return {
      total: summary?.workflowTotal ?? workflowList.length,
      running,
      failed,
      openAlerts: summary?.openAlerts ?? alerts.filter((a) => a.status === "open").length,
      agents: agents.length,
      strategyRunning: strategyRuntimes.filter((r) => r.status === "running").length,
      completed24h: summary?.completed24h ?? 0,
      failed24h: summary?.failed24h ?? 0,
      avgQuality: summary?.avgQualityScore ?? undefined,
      stuckCount: summary?.stuckRunning.length ?? 0,
    };
  }, [workflowList, alerts, agents, strategyRuntimes, summary]);

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

  const refreshSummary = useCallback(async () => {
    try {
      const data = await getMonitorSummary({
        sessionId: sessionFilter || undefined,
      });
      setSummary(data);
    } catch {
      setSummary(null);
    }
  }, [sessionFilter]);

  const onSearch = useCallback(async () => {
    // projectId 作为粗粒度 default 过滤：保证打开监控面板的"默认列表"是
    // 「当前 project 的全部 workflow」而不再是「当前 project default session 的 workflow」。
    // sessionFilter 仍保留作为可选下钻，用户在 WorkflowTab 输入框填入 sessionId 即生效。
    const rows = await listMonitorWorkflows({
      projectId: projectId || undefined,
      sessionId: sessionFilter || undefined,
      status: statusFilter || undefined,
    });
    setWorkflowList(asWorkflowRows(rows as unknown[]));
    await refreshSummary();
    try {
      setStrategyRuntimes(
        await listStrategyRuntimes({
          sessionId: sessionFilter || undefined,
        })
      );
    } catch {
      setStrategyRuntimes([]);
    }
  }, [projectId, sessionFilter, statusFilter, refreshSummary]);

  const refreshAgents = useCallback(async () => {
    try {
      const rows = await listAgents();
      setAgents(
        rows.map((a: AgentSummary) => {
          const path = resolvePoolExecutionPath(a);
          return path ? { ...a, executionPath: path } : a;
        })
      );
    } catch (e) {
      console.error(e);
    }
  }, [setAgents]);

  const refreshSessionAgentsBoard = useCallback(async () => {
    if (!sessionFilter) {
      setSessionAgentsBoard([]);
      return;
    }
    try {
      setSessionAgentsBoard(await getSessionAgentsBoard(sessionFilter));
    } catch {
      setSessionAgentsBoard([]);
    }
  }, [sessionFilter]);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    if (scope !== "agent") return;
    void refreshSessionAgentsBoard();
  }, [scope, refreshSessionAgentsBoard]);

  useEffect(() => {
    const boot = async () => {
      // 先 ensure default workspace（后端 ensureDefaultUserWorkspace 已在 bootstrap 期写入；
      // 这里调一次 GET /workspaces/default 起容错作用，DB 极端被外部清表也能自愈），
      // 再 listWorkspaces 让用户看到全量 workspace（系统 A2A Pool + 默认 + 任何手动新建的多租户）。
      const dft = await getDefaultWorkspace();
      const all = await listWorkspaces();
      setWorkspaces(all);
      // 默认选中 default workspace（不是 workspaces[0]，避免被 A2A Pool 抢走）。
      setWorkspaceId(dft.id);
      // project / session 由下面的 useEffect (随 workspaceId 变化) 接管，避免重复 listProjects。
    };
    void boot().catch(console.error);
  }, []);

  /** workspace 切换：刷新 projects 列表，并自动选中 projects[0]（保持与旧 boot 一致）。 */
  useEffect(() => {
    if (!workspaceId) return;
    void (async () => {
      const list = await listProjects(workspaceId);
      let pid = list[0]?.id ?? "";
      if (!pid) {
        // 只读 get-or-create：后端写死稳定 ID 幂等，不再前端 createProject 兜底。
        const dft = await getOrCreateDefaultProject();
        pid = dft.id;
        setProjects([{ id: dft.id, name: dft.name }]);
      } else {
        setProjects(list);
      }
      setProjectId(pid);
    })().catch(console.error);
  }, [workspaceId]);

  /**
   * project 切换：拉默认 session（仅供 onCreate 新建工作流用），重置 sessionFilter / 选中行。
   *
   * 关键：**不再**把 defaultSession.id 塞进 sessionFilter；让列表默认显示当前 project
   * 的全部 workflow，由用户在 WorkflowTab 输入框手动收窄。
   */
  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      try {
        const defaultSession = await getDefaultProjectSession(projectId);
        setSessionId(defaultSession.id);
      } catch {
        setSessionId("");
      }
      setSessionFilter("");
      setSelectedWorkflowId(null);
      setDrawerDetail("");
    })().catch(console.error);
  }, [projectId]);

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
      if (scope === "agent") {
        void refreshAgents();
        void refreshMetrics();
        void refreshSessionAgentsBoard();
      }
    }, 12_000);
    return () => window.clearInterval(t);
  }, [autoRefresh, projectId, onSearch, scope, refreshAgents, refreshMetrics, refreshSessionAgentsBoard]);

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
      const [detail, obs] = await Promise.all([
        getWorkflowDetail(workflowId),
        getWorkflowObservability(workflowId),
      ]);
      setDrawerDetail(JSON.stringify(detail, null, 2));
      setWorkflowObservability(obs);
      const snaps = await listWorkflowQuality(workflowId);
      setQualitySnapshots(snaps);
    } catch (e) {
      setDrawerDetail(e instanceof Error ? e.message : "加载失败");
      setWorkflowObservability(null);
    }
  };

  const refreshAlerts = async () => {
    setAlerts(
      await listAlerts({
        status: alertStatusFilter || undefined,
        limit: 50,
      })
    );
    await refreshSummary();
  };

  const onAckAlert = async (id: string) => {
    await ackAlert(id);
    await refreshAlerts();
  };

  const onResolveAlert = async (id: string) => {
    await resolveAlert(id);
    await refreshAlerts();
  };

  const onScanStuck = async () => {
    setLoading(true);
    try {
      const result = await scanStuckWorkflowAlerts(120);
      setMetricsHint(`卡住扫描：检查 ${result.scanned} 条，新建告警 ${result.created} 条`);
      await refreshAlerts();
      await onSearch();
    } catch (e) {
      setMetricsHint(e instanceof Error ? e.message : "扫描失败");
    } finally {
      setLoading(false);
    }
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

  /**
   * 保持原行为：alert filter select 变更时立即重拉一次（用旧的内联 fetch 写法）。
   * 拆出到 AlertsEvalTab 后无法访问 setAlerts，由父组件包装。
   */
  const onAlertFilterChange = (v: AlertStatusFilter) => {
    void listAlerts({ status: v || undefined, limit: 50 }).then(setAlerts);
  };

  /**
   * 失败列表点击行 → 跳到工作流 tab 并选中。
   * 用 setTimeout 让 scope 切换先生效避免 detail 加载与 tab 切换竞争。
   */
  const onJumpToWorkflow = (workflowRunId: string) => {
    setScope("workflow");
    window.setTimeout(() => {
      void onSelectWorkflow(workflowRunId);
    }, 0);
  };

  return (
    <div className="qb-monitor" data-qb-monitor-root style={wrap}>
      <h2 className="qb-monitor__title" style={styles.title}>
        运行监控
      </h2>
      <p style={styles.lead}>
        图表由开源库{" "}
        <a
          href="https://github.com/recharts/recharts"
          target="_blank"
          rel="noreferrer"
          style={{ color: "var(--qb-blue, #93c5fd)" }}
        >
          Recharts
        </a>{" "}
        （MIT）渲染；未嵌入 Grafana，避免 Tauri/前端再运维一套时序库。工作流结束时会自动写入质量快照并评估告警；Agent
        维度指标需手动「聚合过去24h」或调用聚合 API。
      </p>

      {/*
        workspace / project 切换 toolbar：
        旧版本 boot() 把第一个 workspace × 第一个 project 一把锁死，没暴露切换入口 ——
        在隔离 project（如 eval 跑批新建的 agent-eval-batch-3）下产出的 workflow 完全不可见。
        这里提供两个最小化下拉，让"打开监控就能看到当前 project 的全部 workflow"成为默认行为。
      */}
      <div style={styles.form} role="group" aria-label="workspace 与 project 切换">
        <label style={{ ...styles.check, gap: 6 }}>
          <span style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>Workspace</span>
          <select
            style={styles.select}
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            aria-label="切换 workspace"
          >
            {workspaces.length === 0 ? (
              <option value="">(loading…)</option>
            ) : (
              workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))
            )}
          </select>
        </label>
        <label style={{ ...styles.check, gap: 6 }}>
          <span style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>Project</span>
          <select
            style={styles.select}
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="切换 project"
          >
            {projects.length === 0 ? (
              <option value="">(loading…)</option>
            ) : (
              projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))
            )}
          </select>
        </label>
        <span style={{ ...styles.kpiLabel, alignSelf: "center", marginLeft: "auto" }}>
          {projectId ? `当前 project: ${projectId.slice(0, 8)}…` : "未选择 project"}
        </span>
      </div>

      <div className="qb-monitor__tabs" style={styles.tabBar} role="tablist" aria-label="监控维度">
        {SCOPE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={scope === t.id}
            title={t.hint}
            className={`qb-pill-tab qb-a3d-tilt${scope === t.id ? " qb-pill-tab--active" : ""}`}
            onClick={() => setScope(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={styles.scopeHint}>{SCOPE_TABS.find((x) => x.id === scope)?.hint}</div>

      {scope === "overview" ? (
        <OverviewTab
          kpis={kpis}
          summary={summary}
          loading={loading}
          metricsHint={metricsHint}
          strategyRuntimes={strategyRuntimes}
          workflowStatusPie={workflowStatusPie}
          workflowModeBar={workflowModeBar}
          goal={goal}
          setGoal={setGoal}
          mode={mode}
          setMode={setMode}
          createLoopKind={createLoopKind}
          setCreateLoopKind={setCreateLoopKind}
          autoRefresh={autoRefresh}
          setAutoRefresh={setAutoRefresh}
          projectId={projectId}
          sessionFilter={sessionFilter || undefined}
          onJumpToWorkflow={onJumpToWorkflow}
          onScanStuck={onScanStuck}
          onSearch={onSearch}
          onRefreshMetrics={refreshMetrics}
          onAggregateMetrics={onAggregateMetrics}
          onCreate={onCreate}
        />
      ) : null}

      {scope === "workflow" ? (
        <WorkflowTab
          workflowList={workflowList}
          selectedWorkflowId={selectedWorkflowId}
          drawerDetail={drawerDetail}
          workflowObservability={workflowObservability}
          qualitySnapshots={qualitySnapshots}
          qualityLineData={qualityLineData}
          sessionFilter={sessionFilter}
          setSessionFilter={setSessionFilter}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          workflowScopedStreamGroups={workflowScopedStreamGroups}
          onSearch={onSearch}
          onSelectWorkflow={onSelectWorkflow}
          onCreateQuality={onCreateQuality}
        />
      ) : null}

      {scope === "agent" ? (
        <AgentTab
          a2aAgentCards={a2aAgentCards}
          legacyAgentCards={legacyAgentCards}
          latencyBarData={latencyBarData}
          healthPieData={healthPieData}
          sessionFilter={sessionFilter}
          sessionAgentsBoard={sessionAgentsBoard}
          loading={loading}
          metricsHint={metricsHint}
          onJumpToWorkflow={onJumpToWorkflow}
          onRefreshMetrics={refreshMetrics}
          onAggregateMetrics={onAggregateMetrics}
        />
      ) : null}

      {scope === "skills" ? (
        <SkillsTab
          sessionFilter={sessionFilter || undefined}
          onJumpToWorkflow={onJumpToWorkflow}
        />
      ) : null}

      {scope === "memory" ? (
        <MemoryTab projectId={projectId} autoRefresh={autoRefresh} />
      ) : null}

      {scope === "diagnostics" ? (
        <DiagnosticsTab
          sessionFilter={sessionFilter || undefined}
          onJumpToWorkflow={onJumpToWorkflow}
        />
      ) : null}

      {scope === "stream" ? (
        <StreamTab monitorStreamGroups={monitorStreamGroups} clearStreamEvents={clearStreamEvents} />
      ) : null}

      {scope === "alerts_eval" ? (
        <AlertsEvalTab
          alerts={alerts}
          alertStatusFilter={alertStatusFilter}
          setAlertStatusFilter={setAlertStatusFilter}
          evalDatasets={evalDatasets}
          selectedDatasetId={selectedDatasetId}
          setSelectedDatasetId={setSelectedDatasetId}
          evalRuns={evalRuns}
          evalRunCases={evalRunCases}
          datasetName={datasetName}
          setDatasetName={setDatasetName}
          loading={loading}
          onRefreshAlerts={refreshAlerts}
          onScanStuck={onScanStuck}
          onAckAlert={onAckAlert}
          onResolveAlert={onResolveAlert}
          onCreateDataset={onCreateDataset}
          loadEvalBoard={loadEvalBoard}
          onRunEval={onRunEval}
          onOpenEvalRun={onOpenEvalRun}
          onAlertFilterChange={onAlertFilterChange}
        />
      ) : null}
    </div>
  );
};
