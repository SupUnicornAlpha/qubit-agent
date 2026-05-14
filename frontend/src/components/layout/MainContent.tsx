import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { History, Loader2, Network, Rocket, Users, type LucideIcon } from "lucide-react";
import {
  chatHealth,
  checkBrokerHealth,
  createEvalDataset,
  createAgentDraft,
  createChatSession,
  createProject,
  createScheduledJob,
  createSessionMessage,
  createIntentOrder,
  createWorkflow,
  createWorkspace,
  getAgentsConfig,
  getAgentRoles,
  getDebateConfig,
  getDebateTurns,
  getDebateVerdict,
  getDefaultProjectSession,
  getExecutionSafetyConfig,
  getFusionHistory,
  getAnalystTeamGraph,
  getSignalFusion,
  initGenePool,
  getRiskConfig,
  getRiskVetoLogs,
  listGeneGenerations,
  listGeneTrends,
  listGenomes,
  listScreenerCandidates,
  listScreenerRuns,
  getModelConfig,
  getBuiltinConnectorConfig,
  getIntentExecutionView,
  getSessionAgentsBoard,
  getSessionA2AMessages,
  getEvalRunDetail,
  getWorkflowDetail,
  listBrokerAccounts,
  listBrokerEvents,
  listMcpBindings,
  listMcpMarketCatalog,
  listMcpProjectInstalls,
  listMcpSources,
  listMcpServers,
  listScheduledJobRuns,
  listScheduledJobs,
  listAgentDefinitions,
  listAgentGroups,
  listAgents,
  listAgentQuality,
  listAlerts,
  listChatSessions,
  listEvalDatasets,
  listEvalRuns,
  listWorkflowQuality,
  listMonitorWorkflows,
  listStrategyScripts,
  listIntegrationChannels,
  listIntegrationLogs,
  listIntentOrders,
  listProjects,
  listSessionMessages,
  listWorkspaces,
  patchSessionMessage,
  patchScheduledJob,
  releaseAgentDraft,
  reloadAgents,
  processWorkflowCompensations,
  evolveGenePool,
  runAnalystTeam,
  runScreener,
  executeIntentConfirmed,
  saveModelConfig,
  saveBuiltinConnectorConfig,
  saveDebateConfig,
  saveExecutionSafetyConfig,
  saveRiskConfig,
  testMcpCall,
  testMcpProjectInstall,
  upsertBrokerAccount,
  upsertIntegrationChannel,
  upsertMcpBinding,
  upsertMcpSource,
  upsertMcpServer,
  requestExecutionConfirmation,
  resolveAlert,
  runEval,
  subscribeDebateStream,
  subscribeWorkflowStream,
  triggerWorkflowAlerts,
  createWorkflowQuality,
  listWorkflowCompensations,
  enqueueWorkflowCompensation,
  installMcpMarket,
  runScheduledJobNow,
  syncMcpSource,
  uninstallMcpProjectInstall,
} from "../../api/backend";
import type {
  AgentDefinitionBundle,
  AgentGroupRecord,
  AgentRoleCatalogItem,
  AnalystTeamResult,
  DebateConfig,
  DebateStreamEvent,
  DebateTurnRecord,
  DebateVerdictRecord,
  EvalCaseResultRecord,
  EvalDatasetRecord,
  EvalRunRecord,
  RiskConfig,
  RiskVetoLogRecord,
  GeneGenerationRecord,
  GeneTrendPoint,
  IntentOrderRecord,
  IntentDeviationRecord,
  ExecutionReportRecord,
  ExecutionSafetyCheckResult,
  ExecutionSafetyConfig,
  McpServerConfigRecord,
  McpCatalogItemRecord,
  McpProjectInstallRecord,
  McpRegistrySourceRecord,
  McpToolBindingRecord,
  ScreenerCandidateRecord,
  ScreenerRunRecord,
  SessionAgentBoardItem,
  SessionA2AMessageItem,
  AlertEventRecord,
  AgentRuntimeMetricRecord,
  BrokerAccountRecord,
  BrokerOrderEventRecord,
  CommunicationChannelRecord,
  CommunicationMessageLogRecord,
  WorkflowCompensationTaskRecord,
  ScheduledJobRecord,
  ScheduledJobRunRecord,
  SignalFusionRecord,
  AnalystTeamGraphPayload,
  AnalystTeamGraphToolCall,
  AnalystTeamGraphMcpCall,
  StrategyGenomeRecord,
  StepStreamEvent,
  WorkflowQualitySnapshotRecord,
  WorkflowMode,
  BuiltinConnectorConfig,
  IndicatorStrategyScriptRecord,
} from "../../api/types";
import { useAppStore, type ChartContextPayload } from "../../store";
import { MarkdownBubble } from "../chat/MarkdownBubble";
import { StreamTimelineGroupCard } from "../chat/StreamTimelineGroupCard";
import { KlinePanel } from "../chart/KlinePanel";
import { IdeQuickTradePanel } from "../ide/IdeQuickTradePanel";
import { IdeResearchWorkbench } from "../ide/IdeResearchWorkbench";
import { TeamAgentGraph, type TeamGraphSelection } from "../ide/TeamAgentGraph";

export const MainContent: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  if (activeView === "ide") {
    return (
      <main style={styles.mainIde}>
        <IdeResearchWorkbench renderChat={() => <ChatPanel ideEmbedded />} />
      </main>
    );
  }
  if (activeView === "chart") {
    return (
      <main style={styles.mainIde}>
        <KlinePanel />
      </main>
    );
  }
  if (activeView === "trader") {
    return (
      <main style={styles.main}>
        <div style={{ maxWidth: 420, margin: "24px auto", padding: "0 16px" }}>
          <IdeQuickTradePanel />
        </div>
      </main>
    );
  }
  if (activeView === "chat") {
    return (
      <main style={styles.main}>
        <ChatPanel />
      </main>
    );
  }
  if (activeView === "team") {
    return (
      <main style={styles.mainTeam}>
        <TeamDashboardPanel />
      </main>
    );
  }
  if (activeView === "config") {
    return (
      <main style={styles.main}>
        <ConfigPanel />
      </main>
    );
  }
  return (
    <main style={styles.main}>
      <MonitorPanel />
    </main>
  );
};

const MonitorPanel: FC = () => {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const streamEvents = useAppStore((s) => s.streamEvents);
  const pushStreamEvent = useAppStore((s) => s.pushStreamEvent);
  const clearStreamEvents = useAppStore((s) => s.clearStreamEvents);
  const [projectId, setProjectId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [goal, setGoal] = useState("Run orchestrator workflow");
  const [mode, setMode] = useState<WorkflowMode>("research");
  const [sessionFilter, setSessionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [workflowList, setWorkflowList] = useState<Array<Record<string, unknown>>>([]);
  const [drawerDetail, setDrawerDetail] = useState("");
  const [qualitySnapshots, setQualitySnapshots] = useState<WorkflowQualitySnapshotRecord[]>([]);
  const [agentQuality, setAgentQuality] = useState<AgentRuntimeMetricRecord[]>([]);
  const [alerts, setAlerts] = useState<AlertEventRecord[]>([]);
  const [evalDatasets, setEvalDatasets] = useState<EvalDatasetRecord[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [evalRuns, setEvalRuns] = useState<EvalRunRecord[]>([]);
  const [evalRunCases, setEvalRunCases] = useState<EvalCaseResultRecord[]>([]);
  const [datasetName, setDatasetName] = useState("Default Eval Dataset");

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

  const eventsPreview = useMemo(() => streamEvents.slice(-120), [streamEvents]);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    clearStreamEvents();
    const created = await createWorkflow({
      projectId,
      goal,
      mode,
      sessionId: sessionId || undefined,
      source: "manual",
    });
    const unsubscribe = subscribeWorkflowStream({
      workflowId: created.data.id,
      runId: created.runId,
      onEvent: pushStreamEvent,
      onError: () => unsubscribe(),
    });
    const detail = await getWorkflowDetail(created.data.id);
    setDrawerDetail(JSON.stringify(detail, null, 2));
  };

  const onSearch = async () => {
    const rows = await listMonitorWorkflows({
      sessionId: sessionFilter || undefined,
      status: statusFilter || undefined,
    });
    setWorkflowList(rows as Array<Record<string, unknown>>);
  };

  const onOpenDrawer = async (workflowId: string) => {
    const detail = await getWorkflowDetail(workflowId);
    setDrawerDetail(JSON.stringify(detail, null, 2));
  };

  const refreshAlerts = async () => {
    setAlerts(await listAlerts({ status: "open" }));
  };

  const onCreateQuality = async (workflowId: string) => {
    await createWorkflowQuality(workflowId);
    setQualitySnapshots(await listWorkflowQuality(workflowId));
    await triggerWorkflowAlerts(workflowId);
    await refreshAlerts();
  };

  const onAckAlert = async (id: string) => {
    await resolveAlert(id);
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

  useEffect(() => {
    void (async () => {
      setAgentQuality(await listAgentQuality());
      await refreshAlerts();
      await loadEvalBoard();
    })().catch(console.error);
  }, []);

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

  return (
    <>
      <h2 style={styles.title}>运行监控</h2>
      <form style={styles.form} onSubmit={onCreate}>
        <input style={styles.input} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <select style={styles.select} value={mode} onChange={(e) => setMode(e.target.value as WorkflowMode)}>
          <option value="research">research</option>
          <option value="backtest">backtest</option>
          <option value="simulation">simulation</option>
          <option value="live">live</option>
        </select>
        <button style={styles.button} type="submit" disabled={!projectId}>
          创建并订阅
        </button>
      </form>

      <h3 style={styles.subTitle}>筛选</h3>
      <div style={styles.form}>
        <input
          style={styles.input}
          placeholder="sessionId"
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        />
        <button style={styles.buttonSecondary} type="button" onClick={() => void onSearch()}>
          查询
        </button>
      </div>

      <div style={styles.grid}>
        {workflowList.map((row) => (
          <button
            key={String(row.id)}
            type="button"
            style={styles.cardButton}
            onClick={() => void onOpenDrawer(String(row.id))}
          >
            <div style={styles.cardName}>{String(row.id)}</div>
            <div style={styles.cardDesc}>
              {String(row.status)} · {String(row.mode)}
            </div>
          </button>
        ))}
      </div>

      <h3 style={styles.subTitle}>Agent 列表</h3>
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

      <h3 style={styles.subTitle}>SSE 事件流</h3>
      <pre style={styles.streamBox}>
        {eventsPreview.length === 0 ? "暂无事件..." : eventsPreview.map((e) => JSON.stringify(e)).join("\n")}
      </pre>

      <h3 style={styles.subTitle}>详情抽屉</h3>
      <pre style={styles.streamBox}>{drawerDetail || "请选择 workflow 查看详情..."}</pre>

      <h3 style={styles.subTitle}>运行质量</h3>
      <div style={styles.grid}>
        {agentQuality.slice(0, 12).map((row) => (
          <div key={row.id} style={styles.card}>
            <div style={styles.cardName}>{row.definitionId}</div>
            <div style={styles.cardDesc}>
              p50={Math.round(row.p50LatencyMs ?? 0)}ms · p95={Math.round(row.p95LatencyMs ?? 0)}ms · err=
              {row.errorCount}/{row.runCount}
            </div>
          </div>
        ))}
      </div>

      <h3 style={styles.subTitle}>告警中心</h3>
      <div style={styles.form}>
        <button style={styles.buttonSecondary} type="button" onClick={() => void refreshAlerts()}>
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
              <button style={styles.buttonSecondary} type="button" onClick={() => void onAckAlert(alert.id)}>
                关闭
              </button>
            </div>
          </div>
        ))}
      </div>

      <h3 style={styles.subTitle}>评测报告</h3>
      <div style={styles.form}>
        <input style={styles.input} value={datasetName} onChange={(e) => setDatasetName(e.target.value)} />
        <button style={styles.buttonSecondary} type="button" onClick={() => void onCreateDataset()}>
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
        <button style={styles.button} type="button" onClick={() => void onRunEval()} disabled={!selectedDatasetId}>
          发起对照评测
        </button>
      </div>
      <div style={styles.grid}>
        {workflowList.slice(0, 8).map((row) => (
          <button
            key={`q-${String(row.id)}`}
            type="button"
            style={styles.cardButton}
            onClick={() => void onCreateQuality(String(row.id))}
          >
            <div style={styles.cardName}>质量快照+告警: {String(row.id)}</div>
            <div style={styles.cardDesc}>点击生成 quality snapshot 并触发告警</div>
          </button>
        ))}
      </div>
      <div style={styles.grid}>
        {evalRuns.slice(0, 20).map((run) => (
          <button key={run.id} type="button" style={styles.cardButton} onClick={() => void onOpenEvalRun(run.id)}>
            <div style={styles.cardName}>{run.id}</div>
            <div style={styles.cardDesc}>
              {run.status} · {JSON.stringify(run.summaryMetricsJson)}
            </div>
          </button>
        ))}
      </div>
      <pre style={styles.streamBox}>
        {evalRunCases.length === 0
          ? "请选择 eval run 查看失败样本..."
          : evalRunCases
              .slice(0, 20)
              .map((c) => `${c.caseKey} score=${c.score.toFixed(3)} pass=${String(c.pass)}`)
              .join("\n")}
      </pre>
      <pre style={styles.streamBox}>
        {qualitySnapshots.length === 0
          ? "暂无质量快照..."
          : qualitySnapshots
              .slice(0, 20)
              .map((s) => `${s.workflowRunId} score=${s.qualityScore.toFixed(3)} err=${s.errorCount}`)
              .join("\n")}
      </pre>
    </>
  );
};

function formatChartContextBlock(ctx: ChartContextPayload): string {
  const lines = [
    "[行情上下文]",
    `品种: ${ctx.symbol}${ctx.exchange ? ` · 交易所: ${ctx.exchange}` : ""}`,
    `周期: ${ctx.timeframe} · 请求条数: ${ctx.limit}`,
  ];
  if (ctx.summary) lines.push(`摘要: ${ctx.summary}`);
  lines.push(`采集时间(UTC): ${ctx.fetchedAt}`);
  return lines.join("\n");
}

const ChatPanel: FC<{ ideEmbedded?: boolean }> = ({ ideEmbedded }) => {
  const chartContext = useAppStore((s) => s.chartContext);
  const setChartContext = useAppStore((s) => s.setChartContext);
  const chatSessions = useAppStore((s) => s.chatSessions);
  const setChatSessions = useAppStore((s) => s.setChatSessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const streamEvents = useAppStore((s) => s.streamEvents);
  const pushStreamEvent = useAppStore((s) => s.pushStreamEvent);

  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [input, setInput] = useState("");
  const chatDraftPrefill = useAppStore((s) => s.chatDraftPrefill);
  const setChatDraftPrefill = useAppStore((s) => s.setChatDraftPrefill);
  const [errorText, setErrorText] = useState("");
  useEffect(() => {
    if (chatDraftPrefill === null) return;
    setInput(chatDraftPrefill);
    setChatDraftPrefill(null);
  }, [chatDraftPrefill, setChatDraftPrefill]);

  const [agentsBoard, setAgentsBoard] = useState<SessionAgentBoardItem[]>([]);
  const [a2aMessages, setA2aMessages] = useState<SessionA2AMessageItem[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const sessionWorkflowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const msg of chatMessages) {
      for (const wid of msg.workflowRunIds ?? []) ids.add(wid);
    }
    return ids;
  }, [chatMessages]);

  const timelineItems = useMemo(() => {
    type StreamGroupItem = {
      kind: "stream_group";
      id: string;
      at: number;
      workflowRunId: string;
      runId: string;
      firstTs: number;
      roleSummary: string;
      steps: Array<{ ts: number; label: string; detail: string }>;
    };
    type A2aTimelineItem = {
      kind: "a2a";
      id: string;
      at: number;
      workflowRunId: string;
      text: string;
      detail: string;
    };
    type TimelineItem = StreamGroupItem | A2aTimelineItem;

    const filtered = streamEvents.filter(
      (e) => sessionWorkflowIds.size === 0 || sessionWorkflowIds.has(e.workflowId)
    );
    const byTs = [...filtered].sort((a, b) => a.ts - b.ts);

    type GroupAcc = {
      workflowRunId: string;
      runId: string;
      firstTs: number;
      lastTs: number;
      roles: Set<string>;
      steps: Array<{ ts: number; label: string; detail: string }>;
    };

    const groupOrder: string[] = [];
    const groupMap = new Map<string, GroupAcc>();

    const groupKey = (workflowId: string, runId: string) => `${workflowId}::${runId}`;

    const pushStep = (g: GroupAcc, step: { ts: number; label: string; detail: string }) => {
      g.lastTs = step.ts;
      const role = step.label.split(/\s/)[0];
      if (role) g.roles.add(role);
      g.steps.push(step);
    };

    for (const e of byTs) {
      const workflowRunId = e.workflowId;
      const key = groupKey(workflowRunId, e.runId);
      let g = groupMap.get(key);
      if (!g) {
        g = {
          workflowRunId,
          runId: e.runId,
          firstTs: e.ts,
          lastTs: e.ts,
          roles: new Set<string>(),
          steps: [],
        };
        groupMap.set(key, g);
        groupOrder.push(key);
      }

      if (e.type === "token") {
        const piece = String(e.payload.token ?? "");
        const lastStep = g.steps[g.steps.length - 1];
        if (lastStep?.label === `${e.role} 流式输出（已合并）`) {
          lastStep.detail += piece;
          lastStep.ts = e.ts;
          g.lastTs = e.ts;
        } else {
          pushStep(g, {
            ts: e.ts,
            label: `${e.role} 流式输出（已合并）`,
            detail: piece,
          });
        }
        continue;
      }

      let label = `${e.role} ${e.type}`;
      if (e.type === "tool_call_start") {
        label = `${e.role} 调用工具 ${String(e.payload.targetName ?? e.payload.toolName ?? "")}`;
      }
      if (e.type === "tool_call_end") {
        label = `${e.role} 工具结束 ${String(e.payload.status ?? "")}`;
      }
      if (e.type === "observe") label = `${e.role} observe #${e.stepIndex}`;
      if (e.type === "step_persisted") label = `${e.role} step_persisted #${e.stepIndex}`;
      if (e.type === "final") label = `${e.role} 完成`;
      if (e.type === "error") label = `${e.role} 失败: ${String(e.payload.error ?? "unknown")}`;

      let detail: string;
      try {
        detail = JSON.stringify(e.payload, null, 2);
      } catch {
        detail = String(e.payload);
      }
      pushStep(g, { ts: e.ts, label, detail });
    }

    const streamGroups: StreamGroupItem[] = groupOrder.map((key) => {
      const g = groupMap.get(key)!;
      const roles = [...g.roles];
      return {
        kind: "stream_group" as const,
        id: `stream-group-${key}`,
        at: g.lastTs,
        workflowRunId: g.workflowRunId,
        runId: g.runId,
        firstTs: g.firstTs,
        roleSummary: roles.length ? roles.join(" · ") : "—",
        steps: g.steps,
      };
    });

    const a2aPart: A2aTimelineItem[] = a2aMessages.map((m) => ({
      id: `a2a-${m.id}`,
      at: new Date(m.createdAt).getTime(),
      kind: "a2a" as const,
      workflowRunId: m.workflowRunId,
      text: `${m.senderRole} → ${m.receiverRole ?? "broadcast"} · ${m.messageType}`,
      detail: JSON.stringify(m.payloadJson).slice(0, 200),
    }));

    return [...streamGroups, ...a2aPart].sort((a, b) => b.at - a.at).slice(0, 60) as TimelineItem[];
  }, [streamEvents, a2aMessages, sessionWorkflowIds]);

  useEffect(() => {
    const boot = async () => {
      await chatHealth();
      const workspaces = await listWorkspaces();
      let wsId = workspaces[0]?.id;
      if (!wsId) {
        const created = await createWorkspace({ name: "QUBIT Default Workspace", owner: "local-user" });
        wsId = created.data.id;
      }
      const projects = await listProjects(wsId);
      let pid = projects[0]?.id;
      if (!pid) {
        const created = await createProject({
          workspaceId: wsId,
          name: "QUBIT Default Project",
          marketScope: "CN-A",
        });
        pid = created.data.id;
      }
      setWorkspaceId(wsId);
      setProjectId(pid);
      const sessions = await listChatSessions({ workspaceId: wsId, projectId: pid });
      if (sessions[0]) {
        setChatSessions(sessions);
        setSelectedSessionId(sessions[0].id);
        setChatMessages(await listSessionMessages(sessions[0].id));
      } else {
        const created = await createChatSession({ workspaceId: wsId, projectId: pid, title: "默认会话" });
        setChatSessions([created]);
        setSelectedSessionId(created.id);
      }
      setErrorText("");
    };
    void boot().catch((err) => setErrorText(err instanceof Error ? err.message : "初始化失败"));
  }, [setChatMessages, setChatSessions, setSelectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void getSessionAgentsBoard(selectedSessionId)
      .then(setAgentsBoard)
      .catch(() => setAgentsBoard([]));
    void getSessionA2AMessages(selectedSessionId, 120)
      .then(setA2aMessages)
      .catch(() => setA2aMessages([]));
  }, [selectedSessionId, refreshKey]);

  const onSelectSession = async (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setChatMessages(await listSessionMessages(sessionId));
  };

  const onCreateSession = async () => {
    if (!workspaceId) return;
    try {
      const created = await createChatSession({
        workspaceId,
        projectId,
        title: `会话 ${chatSessions.length + 1}`,
      });
      setChatSessions([created, ...chatSessions]);
      await onSelectSession(created.id);
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "新建会话失败");
    }
  };

  const bindStream = (workflowId: string, runId: string, assistantMessageId: string) => {
    let buffer = "";
    let streamDone = false;
    let failTimer: ReturnType<typeof setTimeout> | null = null;
    let esClose: () => void = () => {};

    const clearFailTimer = () => {
      if (failTimer !== null) {
        clearTimeout(failTimer);
        failTimer = null;
      }
    };

    const stopStream = () => {
      clearFailTimer();
      esClose();
    };

    esClose = subscribeWorkflowStream({
      workflowId,
      runId,
      onEvent: (event: StepStreamEvent) => {
        pushStreamEvent(event);
        if (event.type === "token") {
          const piece = String(event.payload.token ?? event.payload.text ?? "");
          if (piece) {
            buffer += piece;
            setChatMessages((prev) =>
              prev.map((m) => (m.id === assistantMessageId ? { ...m, content: buffer, status: "running" } : m))
            );
          }
        }
        if (event.type === "observe" || event.type === "tool_call_start" || event.type === "tool_call_end") {
          // Show tool/observe steps as interim content if no token buffer yet
          if (!buffer) {
            const stepLabel =
              event.type === "tool_call_start"
                ? `🔧 调用工具: ${String(event.payload.toolName ?? "")}`
                : event.type === "tool_call_end"
                  ? `✅ 工具完成: ${String(event.payload.toolName ?? event.payload.targetName ?? "")}`
                  : `👁 观测第 ${event.stepIndex} 步`;
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: stepLabel, status: "running" }
                  : m
              )
            );
          }
        }
        if (event.type === "final") {
          clearFailTimer();
          streamDone = true;
          // event.payload IS the finalResponse object; payload.finalResponse does not exist
          const role = String(event.payload.role ?? "agent");
          const obs = event.payload.observation as Record<string, unknown> | undefined;
          let obsText = "";
          if (obs && Object.keys(obs).length > 0) {
            const obsStr = JSON.stringify(obs, null, 2);
            obsText = `\n\n📎 观测结果:\n\`\`\`json\n${obsStr}\n\`\`\``;
          }
          const finalText = buffer || `✅ ${role} 已完成（第 ${event.stepIndex} 轮）${obsText}`;
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: finalText,
            status: "completed",
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId ? { ...m, content: finalText, status: "completed" } : m
            )
          );
          setRefreshKey((v) => v + 1);
          stopStream();
        }
        if (event.type === "error") {
          clearFailTimer();
          streamDone = true;
          const errMsg = String(event.payload.error ?? "unknown error");
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: buffer || `❌ 执行出错: ${errMsg}`,
            status: "failed",
            errorMessage: errMsg,
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: buffer || `❌ 执行出错: ${errMsg}`,
                    status: "failed",
                    errorMessage: errMsg,
                  }
                : m
            )
          );
          setRefreshKey((v) => v + 1);
          stopStream();
        }
      },
      onError: () => {
        if (streamDone) {
          stopStream();
          return;
        }
        // If we already have some buffer content, the stream likely ended cleanly
        // just without a proper final event — treat as completed rather than failed.
        if (buffer.trim()) {
          clearFailTimer();
          streamDone = true;
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: buffer,
            status: "completed",
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId ? { ...m, content: buffer, status: "completed" } : m
            )
          );
          setRefreshKey((v) => v + 1);
          stopStream();
          return;
        }
        clearFailTimer();
        // Give the stream a generous grace period — it might have already sent a
        // final/error event that we're still processing, or the backend just closed
        // the TCP connection slightly early after sending all data.
        failTimer = setTimeout(() => {
          failTimer = null;
          if (streamDone) return;
          streamDone = true;
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: buffer || "⚠️ 流式连接中断，请重试",
            status: "failed",
            errorMessage: "workflow stream disconnected",
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: buffer || "⚠️ 流式连接中断，请重试",
                    status: "failed",
                    errorMessage: "workflow stream disconnected",
                  }
                : m
            )
          );
          setRefreshKey((v) => v + 1);
          stopStream();
        }, 3000); // 3s grace period (was 450ms — too aggressive)
      },
    });
  };

  const onSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSessionId || !projectId || !input.trim()) return;
    try {
      const trimmed = input.trim();
      const block = chartContext ? formatChartContextBlock(chartContext) : "";
      const combinedGoal = block ? `${block}\n\n${trimmed}` : trimmed;
      const userMsg = await createSessionMessage({
        sessionId: selectedSessionId,
        role: "user",
        sender: "user",
        content: combinedGoal,
        status: "running",
      });
      const assistantMsg = await createSessionMessage({
        sessionId: selectedSessionId,
        role: "assistant",
        sender: "orchestrator",
        content: "",
        status: "running",
      });
      const created = await createWorkflow({
        projectId,
        goal: combinedGoal,
        mode: "research",
        sessionId: selectedSessionId,
        source: "chat",
        messageId: userMsg.id,
        reuseSessionWorkflow: true,
      });
      await patchSessionMessage({
        messageId: assistantMsg.id,
        workflowRunIds: [created.data.id],
      });
      await patchSessionMessage({ messageId: userMsg.id, status: "completed" });
      bindStream(created.data.id, created.runId, assistantMsg.id);
      setChatMessages(await listSessionMessages(selectedSessionId));
      setInput("");
      setChartContext(null);
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "发送失败");
    }
  };

  return (
    <div style={ideEmbedded ? styles.chatIdeRoot : { minHeight: 520 }}>
      {ideEmbedded ? (
        <div style={styles.chatIdeHeader}>
          对话 · 与右侧 K 线联动；「带入对话分析」会附加行情上下文。
        </div>
      ) : null}
      {chartContext ? (
        <div style={styles.chartCtxBanner}>
          已附带行情上下文（{chartContext.symbol} / {chartContext.timeframe}）。发送一条消息后会自动清除。
        </div>
      ) : null}
      {errorText ? <div style={styles.errorBox}>{errorText}</div> : null}
      <div style={{ ...styles.chatLayout, ...(ideEmbedded ? styles.chatLayoutIde : {}) }}>
        <div style={styles.chatSidebar}>
          <button style={styles.button} onClick={() => void onCreateSession()}>
            新建会话
          </button>
          <div style={styles.chatSessionList}>
            {chatSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                style={{
                  ...styles.chatSessionItem,
                  ...(selectedSessionId === session.id ? styles.chatSessionItemActive : {}),
                }}
                onClick={() => void onSelectSession(session.id)}
              >
                <div>{session.title}</div>
                <div style={styles.chatMeta}>{new Date(session.updatedAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={styles.chatMain}>
          <div style={styles.chatMessages}>
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  ...styles.chatBubble,
                  ...(msg.role === "user" ? styles.chatBubbleUser : styles.chatBubbleAgent),
                }}
              >
                <div style={styles.chatMeta}>
                  {msg.role} · {msg.status}
                </div>
                <div style={{ marginTop: 6 }}>
                  {msg.content ? <MarkdownBubble text={msg.content} /> : <span style={{ color: "#71717a" }}>(流式生成中…)</span>}
                </div>
                {msg.workflowRunIds?.length ? (
                  <div style={styles.chatMeta}>workflow: {msg.workflowRunIds.join(", ")}</div>
                ) : null}
              </div>
            ))}
          </div>
          <form style={styles.form} onSubmit={onSend}>
            <input
              style={styles.input}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入任务目标，发送给主 Agent"
            />
            <button style={styles.button} type="submit">
              发送
            </button>
          </form>
        </div>

        <div style={styles.boardCol}>
          <h3 style={styles.subTitle}>会话 Agent 看板</h3>
          <div style={styles.boardList}>
            {agentsBoard.map((item) => (
              <div key={item.instanceId} style={styles.boardCard}>
                <div style={styles.cardName}>{item.role}</div>
                <div style={styles.cardDesc}>status: {item.status}</div>
                <div style={styles.cardDesc}>iteration: {item.currentIteration}</div>
                <div style={styles.cardDesc}>
                  latest: {item.latestStep?.phase ?? "-"} #{item.latestStep?.stepIndex ?? "-"}
                </div>
                {item.lastError ? <div style={styles.errorText}>{item.lastError}</div> : null}
              </div>
            ))}
          </div>
          <h3 style={{ ...styles.subTitle, marginTop: 14 }}>Agent 间对话（A2A）</h3>
          <div style={styles.boardList}>
            {a2aMessages.slice(0, 30).map((msg) => (
              <div key={msg.id} style={styles.boardCard}>
                <div style={styles.cardName}>
                  {msg.senderRole} → {msg.receiverRole ?? "broadcast"}
                </div>
                <div style={styles.cardDesc}>type: {msg.messageType}</div>
                <div style={styles.cardDesc}>workflow: {msg.workflowRunId}</div>
                <div style={styles.cardDesc}>
                  {new Date(msg.createdAt).toLocaleString()}
                </div>
                <div style={{ ...styles.chatMeta, marginTop: 6, whiteSpace: "pre-wrap" }}>
                  {JSON.stringify(msg.payloadJson).slice(0, 220)}
                </div>
              </div>
            ))}
            {a2aMessages.length === 0 ? (
              <div style={styles.chatMeta}>暂无 A2A 消息（当前路径主要是 GraphRunner 直连执行）</div>
            ) : null}
          </div>
          <h3 style={{ ...styles.subTitle, marginTop: 14 }}>统一执行时间线</h3>
          <div style={styles.boardList}>
            {timelineItems.map((item) => {
              if (item.kind === "stream_group") {
                return (
                  <StreamTimelineGroupCard
                    key={item.id}
                    item={{
                      workflowRunId: item.workflowRunId,
                      runId: item.runId,
                      at: item.at,
                      firstTs: item.firstTs,
                      roleSummary: item.roleSummary,
                      steps: item.steps,
                    }}
                  />
                );
              }
              return (
                <div key={item.id} style={styles.boardCard}>
                  <div style={styles.cardName}>A2A · {new Date(item.at).toLocaleTimeString()}</div>
                  <div style={styles.cardDesc}>{item.text}</div>
                  <div style={styles.cardDesc}>workflow: {item.workflowRunId}</div>
                  <div style={{ ...styles.chatMeta, marginTop: 6, whiteSpace: "pre-wrap" }}>{item.detail}</div>
                </div>
              );
            })}
            {timelineItems.length === 0 ? (
              <div style={styles.chatMeta}>暂无时间线事件</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

const ConfigPanel: FC = () => {
  const configData = useAppStore((s) => s.configData);
  const setConfigData = useAppStore((s) => s.setConfigData);
  const reloadSummary = useAppStore((s) => s.reloadSummary);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
  const activeConfigSubPage = useAppStore((s) => s.configSubPage);
  const setConfigSubPage = useAppStore((s) => s.setConfigSubPage);
  const [definitions, setDefinitions] = useState<AgentDefinitionBundle[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftSoul, setDraftSoul] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [provider, setProvider] = useState<
    "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock"
  >("mock");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [tushareToken, setTushareToken] = useState("");
  const [klinesDataSource, setKlinesDataSource] = useState<
    "auto" | "tushare_daily" | "yahoo_chart" | "synthetic"
  >("auto");
  const [newsApiBaseUrl, setNewsApiBaseUrl] = useState("");
  const [newsApiKey, setNewsApiKey] = useState("");
  const [newsFetchPath, setNewsFetchPath] = useState("/");
  const [newsTimeoutMs, setNewsTimeoutMs] = useState(15_000);
  const [newsSyntheticWhenEmpty, setNewsSyntheticWhenEmpty] = useState(true);
  const [mcpServers, setMcpServers] = useState<McpServerConfigRecord[]>([]);
  const [mcpBindings, setMcpBindings] = useState<McpToolBindingRecord[]>([]);
  const [mcpSources, setMcpSources] = useState<McpRegistrySourceRecord[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [sourceName, setSourceName] = useState("MCP Official Registry");
  const [sourceBaseUrl, setSourceBaseUrl] = useState("https://registry.modelcontextprotocol.io/v1/catalog.json");
  const [sourceAuthType, setSourceAuthType] = useState<"none" | "bearer" | "api_key">("none");
  const [sourceAuthRef, setSourceAuthRef] = useState("");
  const [mcpMarketItems, setMcpMarketItems] = useState<McpCatalogItemRecord[]>([]);
  const [mcpMarketInstalls, setMcpMarketInstalls] = useState<McpProjectInstallRecord[]>([]);
  const [marketQuery, setMarketQuery] = useState("");
  const [currentProjectId, setCurrentProjectId] = useState("");
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [catalogServerName, setCatalogServerName] = useState("");
  const [selectedMcpServer, setSelectedMcpServer] = useState("");
  const [newMcpServerName, setNewMcpServerName] = useState("");
  const [newMcpServerTransport, setNewMcpServerTransport] = useState<"stdio" | "http" | "ws">("stdio");
  const [newMcpServerCommand, setNewMcpServerCommand] = useState("");
  const [newMcpServerUrl, setNewMcpServerUrl] = useState("");
  const [mcpToolName, setMcpToolName] = useState("");
  const [mcpTimeoutMs, setMcpTimeoutMs] = useState(20000);
  const [mcpTestOutput, setMcpTestOutput] = useState("");
  const [focusedMcpServerId, setFocusedMcpServerId] = useState<string | null>(null);
  const [mcpProbeByServer, setMcpProbeByServer] = useState<
    Record<string, { status: "idle" | "checking" | "ok" | "error"; message?: string; checkedAt?: string }>
  >({});
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledJobRecord[]>([]);
  const [selectedScheduledJobId, setSelectedScheduledJobId] = useState("");
  const [scheduledJobRuns, setScheduledJobRuns] = useState<ScheduledJobRunRecord[]>([]);
  const [scheduledJobName, setScheduledJobName] = useState("定时任务");
  const [scheduledCronExpr, setScheduledCronExpr] = useState("*/5 * * * *");
  const [scheduledExecutionMode, setScheduledExecutionMode] = useState<
    "paper" | "live_with_confirm" | "live_direct"
  >("paper");
  const [scheduledPayload, setScheduledPayload] = useState(
    JSON.stringify(
      {
        goal: "交易时段内，基于新闻/重大事件/K线异动触发分析并决定是否挂单",
        mode: "research",
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
        direction: "long",
        quantity: 1,
        targetPrice: 100,
        brokerProvider: "futu",
      },
      null,
      2
    )
  );
  const [integrationKind, setIntegrationKind] = useState<"telegram" | "webhook">("telegram");
  const [integrationName, setIntegrationName] = useState("default-telegram");
  const [integrationExternalChatId, setIntegrationExternalChatId] = useState("");
  const [integrationSecretRef, setIntegrationSecretRef] = useState("");
  const [integrationChannels, setIntegrationChannels] = useState<CommunicationChannelRecord[]>([]);
  const [integrationLogs, setIntegrationLogs] = useState<CommunicationMessageLogRecord[]>([]);

  const hydrateBuiltinConnectorForm = (cfg: BuiltinConnectorConfig) => {
    const d = cfg["qubit-data"] ?? {};
    const n = cfg["qubit-news"] ?? {};
    setTushareToken(typeof d.tushareToken === "string" ? d.tushareToken : "");
    const kds = d["klinesDataSource"];
    setKlinesDataSource(
      kds === "tushare_daily" || kds === "yahoo_chart" || kds === "synthetic" || kds === "auto"
        ? kds
        : "auto"
    );
    setNewsApiBaseUrl(typeof n.newsApiBaseUrl === "string" ? n.newsApiBaseUrl : "");
    setNewsApiKey(typeof n.newsApiKey === "string" ? n.newsApiKey : "");
    setNewsFetchPath(typeof n.newsFetchPath === "string" ? n.newsFetchPath : "/");
    const to = n["newsTimeoutMs"];
    setNewsTimeoutMs(
      typeof to === "number" && Number.isFinite(to)
        ? to
        : typeof to === "string" && Number.isFinite(Number(to))
          ? Number(to)
          : 15_000
    );
    const swe = n["syntheticWhenEmpty"];
    setNewsSyntheticWhenEmpty(typeof swe === "boolean" ? swe : String(swe) !== "false");
  };

  const loadConfig = async () => {
    const workspaces = await listWorkspaces();
    const currentWorkspace = workspaces[0];
    const projects = currentWorkspace ? await listProjects(currentWorkspace.id) : [];
    const currentProject = projects[0];
    const [data, bundles, servers, bindings, channels, logs, sources] = await Promise.all([
      getAgentsConfig(),
      listAgentDefinitions(),
      listMcpServers(currentProject?.id),
      listMcpBindings(currentProject?.id),
      listIntegrationChannels(),
      listIntegrationLogs(undefined, 50),
      listMcpSources(),
    ]);
    const [marketItems, jobs, installs] = await Promise.all([
      listMcpMarketCatalog({ sourceId: sources[0]?.id }),
      currentWorkspace && currentProject
        ? listScheduledJobs({ workspaceId: currentWorkspace.id, projectId: currentProject.id })
        : Promise.resolve([]),
      currentProject ? listMcpProjectInstalls(currentProject.id) : Promise.resolve([]),
    ]);
    setConfigData(data);
    setDefinitions(bundles);
    setMcpServers(servers);
    setMcpBindings(bindings);
    setMcpProbeByServer({});
    setFocusedMcpServerId((prev) => (prev && servers.some((s) => s.id === prev) ? prev : null));
    setMcpSources(sources);
    setMcpMarketItems(marketItems);
    setMcpMarketInstalls(installs);
    setIntegrationChannels(channels);
    setIntegrationLogs(logs);
    setScheduledJobs(jobs);
    if (currentProject) setCurrentProjectId(currentProject.id);
    if (!selectedMcpServer && servers[0]) {
      setSelectedMcpServer(servers[0].name);
    }
    if (!selectedCatalogId && marketItems[0]) {
      setSelectedCatalogId(marketItems[0].id);
      setCatalogServerName(marketItems[0].slug.replace(/[^a-z0-9_-]/gi, "-"));
    }
    if (!selectedSourceId && sources[0]) {
      setSelectedSourceId(sources[0].id);
      setSourceName(sources[0].name);
      setSourceBaseUrl(sources[0].baseUrl);
      setSourceAuthType(sources[0].authType);
      setSourceAuthRef(sources[0].authRef ?? "");
    }
    if (!selectedScheduledJobId && jobs[0]) {
      setSelectedScheduledJobId(jobs[0].id);
      setScheduledJobRuns(await listScheduledJobRuns(jobs[0].id));
    }
    if (!selectedDefinitionId && bundles[0]) {
      setSelectedDefinitionId(bundles[0].definition.id);
      setDraftPrompt(bundles[0].draft?.systemPrompt ?? bundles[0].definition.systemPrompt);
      setDraftSoul(bundles[0].profile?.soulFileRef ?? "");
    }
    try {
      const bc = await getBuiltinConnectorConfig();
      hydrateBuiltinConnectorForm(bc);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void loadConfig();
    void getModelConfig().then((cfg) => {
      setProvider(cfg.provider ?? "mock");
      setModelName(cfg.model ?? "gpt-4o-mini");
      setModelApiKey(cfg.apiKey ?? "");
      setModelBaseUrl(cfg.baseUrl ?? "");
    });
    void getBuiltinConnectorConfig()
      .then(hydrateBuiltinConnectorForm)
      .catch(() => {});
  }, []);

  const selectedBundle = useMemo(
    () => definitions.find((item) => item.definition.id === selectedDefinitionId) ?? null,
    [definitions, selectedDefinitionId]
  );

  const mcpServerBindingCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of mcpBindings) {
      map.set(row.serverName, (map.get(row.serverName) ?? 0) + 1);
    }
    return map;
  }, [mcpBindings]);

  const pickBindingForMcpServer = (serverName: string): McpToolBindingRecord | undefined => {
    const pid = currentProjectId || undefined;
    const forServer = mcpBindings.filter((b) => b.serverName === serverName);
    const enabled = forServer.filter((b) => b.enabled);
    const pool = enabled.length ? enabled : forServer;
    return (
      pool.find((b) => b.projectId === pid) ??
      pool.find((b) => b.projectId == null) ??
      pool[0]
    );
  };

  const mcpConnectionSpecOk = (row: McpServerConfigRecord): boolean => {
    if (!row.enabled) return false;
    if (row.transport === "stdio") return Boolean(row.command?.trim());
    return Boolean(row.url?.trim());
  };

  const probeMcpServer = async (row: McpServerConfigRecord, binding?: McpToolBindingRecord) => {
    const key = row.name;
    if (!mcpConnectionSpecOk(row)) {
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "error",
          message: !row.enabled ? "Server 已禁用" : row.transport === "stdio" ? "缺少 command" : "缺少 url",
          checkedAt: new Date().toISOString(),
        },
      }));
      return;
    }
    const bind = binding ?? pickBindingForMcpServer(row.name);
    if (!bind?.toolName?.trim()) {
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "error",
          message: "未绑定工具，无法探测连通性",
          checkedAt: new Date().toISOString(),
        },
      }));
      return;
    }
    setMcpProbeByServer((prev) => ({
      ...prev,
      [key]: { status: "checking", checkedAt: new Date().toISOString() },
    }));
    try {
      const out = await testMcpCall({
        projectId: currentProjectId || undefined,
        serverName: row.name,
        toolName: bind.toolName.trim(),
        arguments: { ping: true, ts: Date.now() },
      });
      setMcpTestOutput(JSON.stringify(out, null, 2));
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "ok",
          message: out.accepted ? `工具「${bind.toolName}」调用成功` : `工具「${bind.toolName}」返回未接受`,
          checkedAt: new Date().toISOString(),
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMcpTestOutput(msg);
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: { status: "error", message: msg, checkedAt: new Date().toISOString() },
      }));
    }
  };

  const applyMcpFromCard = (row: McpServerConfigRecord) => {
    setNewMcpServerName(row.name);
    setNewMcpServerTransport(row.transport);
    setNewMcpServerCommand(row.command?.trim() ? String(row.command) : "");
    setNewMcpServerUrl(row.url?.trim() ? String(row.url) : "");
    setSelectedMcpServer(row.name);
    setFocusedMcpServerId(row.id);
    const bind = pickBindingForMcpServer(row.name);
    if (bind) {
      setMcpToolName(bind.toolName);
      if (typeof bind.timeoutMs === "number" && Number.isFinite(bind.timeoutMs)) {
        setMcpTimeoutMs(bind.timeoutMs);
      }
    }
    void probeMcpServer(row, bind);
  };

  const saveMcpBindingNow = async () => {
    if (!selectedMcpServer || !mcpToolName.trim()) return;
    const row = await upsertMcpBinding({
      projectId: currentProjectId || undefined,
      serverName: selectedMcpServer,
      toolName: mcpToolName.trim(),
      enabled: true,
      timeoutMs: mcpTimeoutMs,
      retryPolicyJson: { maxAttempts: 2, backoffMs: 300 },
      rateLimitJson: {},
    });
    setMcpTestOutput(`binding saved: ${row.serverName}/${row.toolName}`);
    setMcpBindings(await listMcpBindings(currentProjectId || undefined));
    setMcpProbeByServer((prev) => {
      const next = { ...prev };
      delete next[row.serverName];
      return next;
    });
  };

  const testMcpNow = async () => {
    if (!selectedMcpServer || !mcpToolName.trim()) return;
    const key = selectedMcpServer;
    setMcpProbeByServer((prev) => ({
      ...prev,
      [key]: { status: "checking", checkedAt: new Date().toISOString() },
    }));
    try {
      const out = await testMcpCall({
        projectId: currentProjectId || undefined,
        serverName: selectedMcpServer,
        toolName: mcpToolName.trim(),
        arguments: { ping: true, ts: Date.now() },
      });
      setMcpTestOutput(JSON.stringify(out, null, 2));
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "ok",
          message: out.accepted ? `工具「${mcpToolName.trim()}」调用成功` : "返回未接受",
          checkedAt: new Date().toISOString(),
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMcpTestOutput(msg);
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: { status: "error", message: msg, checkedAt: new Date().toISOString() },
      }));
    }
  };

  const upsertMcpServerNow = async () => {
    if (!newMcpServerName.trim()) return;
    const saved = await upsertMcpServer({
      projectId: currentProjectId || undefined,
      name: newMcpServerName.trim(),
      transport: newMcpServerTransport,
      command: newMcpServerCommand.trim() || undefined,
      url: newMcpServerUrl.trim() || undefined,
      capabilitiesJson: ["tools"],
      enabled: true,
    });
    setSelectedMcpServer(saved.name);
    setMcpServers(await listMcpServers(currentProjectId || undefined));
    setMcpProbeByServer((prev) => {
      const next = { ...prev };
      delete next[saved.name];
      return next;
    });
    setMcpTestOutput(`server upserted: ${saved.name}`);
  };

  const saveSourceNow = async () => {
    const saved = await upsertMcpSource({
      id: selectedSourceId || undefined,
      name: sourceName.trim(),
      baseUrl: sourceBaseUrl.trim(),
      authType: sourceAuthType,
      authRef: sourceAuthRef.trim() || undefined,
      enabled: true,
      isDefault: true,
    });
    setSelectedSourceId(saved.id);
    setMcpSources(await listMcpSources());
  };

  const syncSourceNowAction = async () => {
    if (!selectedSourceId) return;
    const out = await syncMcpSource(selectedSourceId);
    setMcpTestOutput(`source synced: ${out.syncedCount}, fallback=${out.usedFallback}`);
    setMcpMarketItems(await listMcpMarketCatalog({ sourceId: selectedSourceId, q: marketQuery || undefined }));
  };

  const searchMarketNow = async () => {
    setMcpMarketItems(await listMcpMarketCatalog({ sourceId: selectedSourceId, q: marketQuery || undefined }));
  };

  const installMarketItemNow = async () => {
    if (!currentProjectId || !selectedCatalogId || !catalogServerName.trim()) return;
    const installed = await installMcpMarket({
      projectId: currentProjectId,
      catalogItemId: selectedCatalogId,
      serverName: catalogServerName.trim(),
      toolName: mcpToolName.trim() || undefined,
      timeoutMs: mcpTimeoutMs,
    });
    setMcpMarketInstalls((prev) => [installed, ...prev].slice(0, 30));
    setMcpServers(await listMcpServers(currentProjectId));
    setMcpBindings(await listMcpBindings(currentProjectId));
    setSelectedMcpServer(installed.serverName);
  };

  const testProjectInstallNow = async () => {
    if (!mcpMarketInstalls[0]) return;
    const out = await testMcpProjectInstall({
      installId: mcpMarketInstalls[0].id,
      toolName: mcpToolName.trim() || undefined,
    });
    setMcpTestOutput(JSON.stringify(out, null, 2));
  };

  const uninstallMarketInstallNow = async (installId: string) => {
    if (!currentProjectId) return;
    await uninstallMcpProjectInstall({ projectId: currentProjectId, installId });
    setMcpMarketInstalls(await listMcpProjectInstalls(currentProjectId));
    setMcpServers(await listMcpServers(currentProjectId));
    setMcpBindings(await listMcpBindings(currentProjectId));
    setMcpTestOutput(`已卸载安装记录 ${installId}`);
  };

  const createScheduledJobNow = async () => {
    const workspaces = await listWorkspaces();
    const ws = workspaces[0];
    if (!ws) return;
    const projects = await listProjects(ws.id);
    const project = projects[0];
    if (!project) return;
    const parsedPayload = JSON.parse(scheduledPayload || "{}") as Record<string, unknown>;
    const created = await createScheduledJob({
      workspaceId: ws.id,
      projectId: project.id,
      name: scheduledJobName,
      cronExpr: scheduledCronExpr,
      timezone: "UTC",
      payloadJson: parsedPayload,
      executionMode: scheduledExecutionMode,
      enabled: true,
    });
    const jobs = await listScheduledJobs({ workspaceId: ws.id, projectId: project.id });
    setScheduledJobs(jobs);
    setSelectedScheduledJobId(created.id);
    setScheduledJobRuns(await listScheduledJobRuns(created.id));
  };

  const runScheduledNow = async () => {
    if (!selectedScheduledJobId) return;
    await runScheduledJobNow(selectedScheduledJobId);
    setScheduledJobRuns(await listScheduledJobRuns(selectedScheduledJobId));
    const workspaces = await listWorkspaces();
    const ws = workspaces[0];
    if (!ws) return;
    const projects = await listProjects(ws.id);
    const project = projects[0];
    if (!project) return;
    setScheduledJobs(await listScheduledJobs({ workspaceId: ws.id, projectId: project.id }));
  };

  const toggleScheduledJob = async (enabled: boolean) => {
    if (!selectedScheduledJobId) return;
    await patchScheduledJob(selectedScheduledJobId, { enabled });
    const job = scheduledJobs.find((item) => item.id === selectedScheduledJobId);
    if (!job) return;
    setScheduledJobs(await listScheduledJobs({ workspaceId: job.workspaceId, projectId: job.projectId }));
  };

  const saveIntegrationNow = async () => {
    const workspaces = await listWorkspaces();
    const ws = workspaces[0];
    if (!ws) return;
    const projects = await listProjects(ws.id);
    const data = await upsertIntegrationChannel({
      workspaceId: ws.id,
      projectId: projects[0]?.id ?? null,
      kind: integrationKind,
      name: integrationName || `${integrationKind}-channel`,
      externalChatId: integrationExternalChatId || "default",
      secretRef: integrationSecretRef,
      enabled: true,
    });
    setIntegrationName(data.name);
    setIntegrationChannels(await listIntegrationChannels());
  };

  return (
    <>
      <h2 style={styles.title}>配置中心</h2>
      <div style={styles.actions}>
        <button style={styles.button} onClick={() => void loadConfig()}>
          刷新配置
        </button>
        <button
          style={styles.buttonSecondary}
          onClick={() =>
            void reloadAgents().then((res) => setReloadSummary({ before: res.before, after: res.after }))
          }
        >
          触发 reload
        </button>
      </div>
      {reloadSummary ? (
        <div style={{ ...styles.meta, marginBottom: 12 }}>
          <span>reload before: {reloadSummary.before}</span>
          <span>reload after: {reloadSummary.after}</span>
        </div>
      ) : null}
      <div style={styles.configSubNav} role="tablist" aria-label="配置分类">
        {(
          [
            ["llm", "LLM"],
            ["datasources", "数据源"],
            ["mcp", "MCP"],
            ["agent", "Agent"],
            ["integration", "集成 / IM"],
            ["schedule", "定时任务"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeConfigSubPage === id}
            style={{
              ...styles.configSubTab,
              ...(activeConfigSubPage === id ? styles.configSubTabActive : {}),
            }}
            onClick={() => setConfigSubPage(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={styles.configPageBody}>
        {activeConfigSubPage === "llm" ? (
          <>
            <h3 style={styles.subTitle}>LLM（模型提供方）</h3>
            <p style={{ fontSize: 12, color: "#a1a1aa", margin: "0 0 10px" }}>
              配置默认对话 / 编排使用的模型与鉴权；保存后由后端加载。
            </p>
            <div style={styles.form}>
              <select
                style={styles.select}
                value={provider}
                onChange={(e) =>
                  setProvider(
                    e.target.value as "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock"
                  )
                }
              >
                <option value="mock">mock</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="ollama">ollama</option>
                <option value="deepseek">deepseek</option>
                <option value="qwen">qwen</option>
                <option value="zhipu">zhipu</option>
              </select>
              <input style={styles.input} value={modelName} onChange={(e) => setModelName(e.target.value)} />
              <input style={styles.input} value={modelApiKey} onChange={(e) => setModelApiKey(e.target.value)} />
              <input style={styles.input} value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} />
              <button
                style={styles.button}
                onClick={() =>
                  void saveModelConfig({
                    provider,
                    model: modelName,
                    apiKey: modelApiKey,
                    baseUrl: modelBaseUrl || undefined,
                  })
                }
              >
                保存 LLM 配置
              </button>
            </div>
          </>
        ) : null}
        {activeConfigSubPage === "datasources" ? (
          <>
            <h3 style={styles.subTitle}>数据源（qubit-data / qubit-news）</h3>
            <p style={{ fontSize: 12, color: "#a1a1aa", margin: "0 0 8px" }}>
              在客户端填写后写入本机数据库（~/.quant-agent/db），启动时与保存后都会重新注入连接器；无需环境变量。
              <br />
              K 线数据源 <code style={{ fontSize: 11 }}>klinesDataSource</code>：默认「自动」为无 Tushare token 时使用{" "}
              <strong>Yahoo Finance</strong>（免费、日线、无需 API key）；有 token 时自动走 Tushare 日线。
            </p>
            <div style={{ ...styles.form, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#d4d4d8" }}>
                <span style={{ whiteSpace: "nowrap" }}>K 线数据源</span>
                <select
                  style={styles.select}
                  value={klinesDataSource}
                  onChange={(e) =>
                    setKlinesDataSource(e.target.value as "auto" | "tushare_daily" | "yahoo_chart" | "synthetic")
                  }
                >
                  <option value="auto">自动（有 Tushare → 日线 Tushare；否则 Yahoo）</option>
                  <option value="yahoo_chart">Yahoo Finance（免费日线）</option>
                  <option value="tushare_daily">Tushare 日线（需 token）</option>
                  <option value="synthetic">不拉外源（K 线为空，用于禁用行情）</option>
                </select>
              </label>
              <input
                style={{ ...styles.input, minWidth: 200 }}
                type="password"
                autoComplete="off"
                value={tushareToken}
                onChange={(e) => setTushareToken(e.target.value)}
                placeholder="Tushare token（仅在选择 Tushare 或自动且有 token 时使用）"
              />
            </div>
            <div style={{ ...styles.form, flexWrap: "wrap" }}>
              <input
                style={{ ...styles.input, minWidth: 200 }}
                value={newsApiBaseUrl}
                onChange={(e) => setNewsApiBaseUrl(e.target.value)}
                placeholder="新闻 API Base URL"
              />
              <input
                style={{ ...styles.input, minWidth: 160 }}
                type="password"
                autoComplete="off"
                value={newsApiKey}
                onChange={(e) => setNewsApiKey(e.target.value)}
                placeholder="API Key（可选）"
              />
              <input
                style={{ ...styles.input, width: 120 }}
                value={newsFetchPath}
                onChange={(e) => setNewsFetchPath(e.target.value)}
                placeholder="路径，默认 /"
              />
              <input
                style={{ ...styles.input, width: 100 }}
                type="number"
                value={newsTimeoutMs}
                onChange={(e) => setNewsTimeoutMs(Number(e.target.value))}
                placeholder="超时 ms"
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#d4d4d8" }}>
                <input
                  type="checkbox"
                  checked={newsSyntheticWhenEmpty}
                  onChange={(e) => setNewsSyntheticWhenEmpty(e.target.checked)}
                />
                空结果时回落 stub
              </label>
              <button
                style={styles.button}
                onClick={() =>
                  void saveBuiltinConnectorConfig({
                    "qubit-data": {
                      klinesDataSource,
                      tushareToken: tushareToken.trim() || undefined,
                    },
                    "qubit-news": {
                      newsApiBaseUrl: newsApiBaseUrl.trim() || undefined,
                      newsApiKey: newsApiKey.trim() || undefined,
                      newsFetchPath: newsFetchPath.trim() || "/",
                      newsTimeoutMs,
                      syntheticWhenEmpty: newsSyntheticWhenEmpty,
                    },
                  }).then(hydrateBuiltinConnectorForm)
                }
              >
                保存数据源配置
              </button>
            </div>
          </>
        ) : null}
        {activeConfigSubPage === "mcp" ? (
          <>
      <h3 style={styles.subTitle}>MCP 配置与连通性</h3>
      <div style={styles.form}>
        <input
          style={styles.input}
          value={newMcpServerName}
          onChange={(e) => setNewMcpServerName(e.target.value)}
          placeholder="server name"
        />
        <select
          style={styles.select}
          value={newMcpServerTransport}
          onChange={(e) => setNewMcpServerTransport(e.target.value as "stdio" | "http" | "ws")}
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
          <option value="ws">ws</option>
        </select>
        <input
          style={styles.input}
          value={newMcpServerCommand}
          onChange={(e) => setNewMcpServerCommand(e.target.value)}
          placeholder="command (stdio)"
        />
        <input
          style={styles.input}
          value={newMcpServerUrl}
          onChange={(e) => setNewMcpServerUrl(e.target.value)}
          placeholder="url (http/ws)"
        />
        <button style={styles.buttonSecondary} onClick={() => void upsertMcpServerNow()}>
          保存 Server
        </button>
      </div>
      <div style={styles.form}>
        <select
          style={styles.select}
          value={selectedMcpServer}
          onChange={(e) => setSelectedMcpServer(e.target.value)}
        >
          {mcpServers.map((s) => (
            <option key={s.id} value={s.name}>
              {s.name} · {s.transport} · {s.enabled ? "enabled" : "disabled"}
            </option>
          ))}
        </select>
        <input
          style={styles.input}
          value={mcpToolName}
          onChange={(e) => setMcpToolName(e.target.value)}
          placeholder="tool name"
        />
        <input
          style={styles.input}
          type="number"
          value={mcpTimeoutMs}
          onChange={(e) => setMcpTimeoutMs(Number(e.target.value))}
          placeholder="timeout ms"
        />
        <button style={styles.buttonSecondary} onClick={() => void saveMcpBindingNow()}>
          保存绑定
        </button>
        <button style={styles.button} onClick={() => void testMcpNow()}>
          测试 MCP
        </button>
      </div>
      <div style={styles.meta}>
        <span>已配置 MCP Server: {mcpServers.length}</span>
        <span>已配置 MCP 绑定: {mcpBindings.length}</span>
        <span>已安装市场项: {mcpMarketInstalls.length}</span>
      </div>
      <div style={styles.grid}>
        {mcpServers.map((row) => {
          const probe = mcpProbeByServer[row.name];
          const specOk = mcpConnectionSpecOk(row);
          const bindCount = mcpServerBindingCount.get(row.name) ?? 0;
          const shortMsg = (m?: string) => (!m ? "" : m.length > 72 ? `${m.slice(0, 72)}…` : m);
          const cfgPill =
            !row.enabled
              ? { bg: "#3f1f1f", color: "#fca5a5", text: "配置：已禁用" }
              : !specOk
                ? {
                    bg: "#422006",
                    color: "#fdba74",
                    text: row.transport === "stdio" ? "配置：缺少 command" : "配置：缺少 url",
                  }
                : { bg: "#14532d", color: "#86efac", text: "配置：参数齐全" };
          const reachPill =
            probe?.status === "checking"
              ? { bg: "#1e3a8a", color: "#bfdbfe", text: "连通性：检测中…" }
              : probe?.status === "ok"
                ? {
                    bg: "#14532d",
                    color: "#bbf7d0",
                    text: `连通性：可用${probe.message ? `（${shortMsg(probe.message)}）` : ""}`,
                  }
                : probe?.status === "error"
                  ? {
                      bg: "#3f1f1f",
                      color: "#fca5a5",
                      text: `连通性：不可用${probe.message ? `（${shortMsg(probe.message)}）` : ""}`,
                    }
                  : specOk && bindCount > 0
                    ? { bg: "#27272a", color: "#a1a1aa", text: "连通性：点击卡片自动检测" }
                    : {
                        bg: "#27272a",
                        color: "#a1a1aa",
                        text: bindCount === 0 ? "连通性：需先绑定工具" : "连通性：待检测",
                      };
          const selected = focusedMcpServerId === row.id;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => applyMcpFromCard(row)}
              title="点击载入到上方表单并探测连通性"
              style={{
                ...styles.card,
                ...styles.mcpCardBtn,
                ...(selected ? styles.mcpCardBtnSelected : {}),
              }}
            >
              <div style={styles.cardName}>{row.name}</div>
              <div style={styles.cardDesc}>
                {row.transport} · {row.enabled ? "enabled" : "disabled"} · 绑定 {bindCount} 个 tool
              </div>
              <div style={styles.cardDesc}>
                {row.projectId ? `project: ${row.projectId}` : "project: 全局"}
              </div>
              <div style={styles.mcpCardPillRow}>
                <span style={{ ...styles.mcpCardPill, background: cfgPill.bg, color: cfgPill.color }}>{cfgPill.text}</span>
                <span style={{ ...styles.mcpCardPill, background: reachPill.bg, color: reachPill.color }}>
                  {reachPill.text}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <h3 style={styles.subTitle}>MCP 市场</h3>
      <div style={styles.form}>
        <input style={styles.input} value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="source name" />
        <input style={styles.input} value={sourceBaseUrl} onChange={(e) => setSourceBaseUrl(e.target.value)} placeholder="source base url" />
        <select style={styles.select} value={sourceAuthType} onChange={(e) => setSourceAuthType(e.target.value as "none" | "bearer" | "api_key")}>
          <option value="none">none</option>
          <option value="bearer">bearer</option>
          <option value="api_key">api_key</option>
        </select>
        <input style={styles.input} value={sourceAuthRef} onChange={(e) => setSourceAuthRef(e.target.value)} placeholder="auth ref (optional)" />
        <button style={styles.buttonSecondary} onClick={() => void saveSourceNow()}>
          保存源
        </button>
      </div>
      <div style={styles.form}>
        <select style={styles.select} value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)}>
          {mcpSources.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.isDefault ? "default" : "custom"} · {item.enabled ? "enabled" : "disabled"}
            </option>
          ))}
        </select>
        <input style={styles.input} value={marketQuery} onChange={(e) => setMarketQuery(e.target.value)} placeholder="搜索市场工具" />
        <button style={styles.buttonSecondary} onClick={() => void syncSourceNowAction()}>
          同步目录
        </button>
        <button style={styles.button} onClick={() => void searchMarketNow()}>
          刷新市场
        </button>
      </div>
      <div style={styles.form}>
        <select style={styles.select} value={selectedCatalogId} onChange={(e) => setSelectedCatalogId(e.target.value)}>
          {mcpMarketItems.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.riskLevel} · {item.transport} · {item.version}
            </option>
          ))}
        </select>
        <input
          style={styles.input}
          value={catalogServerName}
          onChange={(e) => setCatalogServerName(e.target.value)}
          placeholder="project scoped server name"
        />
        <button style={styles.buttonSecondary} onClick={() => void installMarketItemNow()} disabled={!currentProjectId}>
          安装到当前项目
        </button>
        <button style={styles.button} onClick={() => void testProjectInstallNow()}>
          测试最近安装
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {mcpMarketInstalls.map((row) => (
          <div key={row.id} style={styles.form}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {row.serverName} · {row.installStatus}
            </span>
            <button
              type="button"
              style={styles.buttonSecondary}
              onClick={() => void uninstallMarketInstallNow(row.id)}
              disabled={!currentProjectId}
            >
              卸载
            </button>
          </div>
        ))}
      </div>
      <pre style={styles.streamBox}>{JSON.stringify(mcpSources, null, 2)}</pre>
      <pre style={styles.streamBox}>{JSON.stringify(mcpMarketItems, null, 2)}</pre>
      <pre style={styles.streamBox}>{JSON.stringify(mcpMarketInstalls, null, 2)}</pre>
      <pre style={styles.streamBox}>{mcpTestOutput || "暂无测试结果"}</pre>
      <pre style={styles.streamBox}>{JSON.stringify(mcpBindings, null, 2)}</pre>
          </>
        ) : null}
        {activeConfigSubPage === "schedule" ? (
          <>
      <h3 style={styles.subTitle}>定时任务</h3>
      <div style={styles.form}>
        <input
          style={styles.input}
          value={scheduledJobName}
          onChange={(e) => setScheduledJobName(e.target.value)}
          placeholder="job name"
        />
        <input
          style={styles.input}
          value={scheduledCronExpr}
          onChange={(e) => setScheduledCronExpr(e.target.value)}
          placeholder="cron (e.g. */5 * * * *)"
        />
        <select
          style={styles.select}
          value={scheduledExecutionMode}
          onChange={(e) =>
            setScheduledExecutionMode(e.target.value as "paper" | "live_with_confirm" | "live_direct")
          }
        >
          <option value="paper">paper</option>
          <option value="live_with_confirm">live_with_confirm</option>
          <option value="live_direct">live_direct</option>
        </select>
        <button style={styles.buttonSecondary} onClick={() => void createScheduledJobNow()}>
          创建定时任务
        </button>
        <button style={styles.button} onClick={() => void runScheduledNow()} disabled={!selectedScheduledJobId}>
          立即执行
        </button>
      </div>
      <textarea
        style={{ ...styles.input, minHeight: 120, width: "100%" }}
        value={scheduledPayload}
        onChange={(e) => setScheduledPayload(e.target.value)}
      />
      <div style={styles.form}>
        <select
          style={styles.select}
          value={selectedScheduledJobId}
          onChange={async (e) => {
            const nextId = e.target.value;
            setSelectedScheduledJobId(nextId);
            if (!nextId) return;
            setScheduledJobRuns(await listScheduledJobRuns(nextId));
          }}
        >
          <option value="">选择任务</option>
          {scheduledJobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.name} · {job.enabled ? "enabled" : "disabled"} · {job.cronExpr}
            </option>
          ))}
        </select>
        <button
          style={styles.buttonSecondary}
          onClick={() => void toggleScheduledJob(false)}
          disabled={!selectedScheduledJobId}
        >
          停用
        </button>
        <button
          style={styles.buttonSecondary}
          onClick={() => void toggleScheduledJob(true)}
          disabled={!selectedScheduledJobId}
        >
          启用
        </button>
      </div>
      <pre style={styles.streamBox}>{JSON.stringify(scheduledJobs, null, 2)}</pre>
      <pre style={styles.streamBox}>{JSON.stringify(scheduledJobRuns, null, 2)}</pre>
          </>
        ) : null}
        {activeConfigSubPage === "integration" ? (
          <>
      <h3 style={styles.subTitle}>集成与 IM 工具（Telegram / Webhook）</h3>
      <p style={{ fontSize: 12, color: "#a1a1aa", margin: "0 0 10px" }}>
        配置外部消息通道与密钥引用，供编排向 IM 推送或接收 Webhook。
      </p>
      <div style={styles.form}>
        <select
          style={styles.select}
          value={integrationKind}
          onChange={(e) => setIntegrationKind(e.target.value as "telegram" | "webhook")}
        >
          <option value="telegram">telegram</option>
          <option value="webhook">webhook</option>
        </select>
        <input
          style={styles.input}
          value={integrationName}
          onChange={(e) => setIntegrationName(e.target.value)}
          placeholder="channel name"
        />
        <input
          style={styles.input}
          value={integrationExternalChatId}
          onChange={(e) => setIntegrationExternalChatId(e.target.value)}
          placeholder="chatId / webhook target"
        />
        <input
          style={styles.input}
          value={integrationSecretRef}
          onChange={(e) => setIntegrationSecretRef(e.target.value)}
          placeholder="token / secret"
        />
        <button style={styles.buttonSecondary} onClick={() => void saveIntegrationNow()}>
          保存集成配置
        </button>
      </div>
      <pre style={styles.streamBox}>{JSON.stringify(integrationChannels, null, 2)}</pre>
      <pre style={styles.streamBox}>{JSON.stringify(integrationLogs, null, 2)}</pre>
          </>
        ) : null}
        {activeConfigSubPage === "agent" ? (
          <>
      <h3 style={styles.subTitle}>Agent 配置</h3>
      <div style={styles.form}>
        <select
          style={styles.select}
          value={selectedDefinitionId}
          onChange={(e) => setSelectedDefinitionId(e.target.value)}
        >
          {definitions.map((item) => (
            <option key={item.definition.id} value={item.definition.id}>
              {item.definition.role} · {item.definition.version}
            </option>
          ))}
        </select>
        <input style={styles.input} value={draftSoul} onChange={(e) => setDraftSoul(e.target.value)} />
      </div>
      <textarea style={styles.textarea} value={draftPrompt} onChange={(e) => setDraftPrompt(e.target.value)} />
      <input style={styles.input} value={draftNote} onChange={(e) => setDraftNote(e.target.value)} />
      <div style={styles.actions}>
        <button
          style={styles.button}
          onClick={() =>
            selectedBundle &&
            void createAgentDraft({
              definitionId: selectedBundle.definition.id,
              systemPrompt: draftPrompt,
              changeNote: draftNote,
              profile: {
                displayName: selectedBundle.profile?.displayName ?? selectedBundle.definition.name,
                soulFileRef: draftSoul,
                description: selectedBundle.profile?.description ?? "",
              },
            }).then(() => loadConfig())
          }
        >
          保存草稿
        </button>
        <button
          style={styles.buttonSecondary}
          onClick={() =>
            selectedBundle?.draft &&
            void releaseAgentDraft({
              definitionId: selectedBundle.definition.id,
              draftId: selectedBundle.draft.id,
              releasedVersion: selectedBundle.definition.version,
              releaseNote: draftNote,
            }).then(() => loadConfig())
          }
        >
          发布草稿
        </button>
      </div>
      <pre style={styles.streamBox}>{JSON.stringify(configData?.diffSummary ?? {}, null, 2)}</pre>
          </>
        ) : null}
      </div>
    </>
  );
};

const styles: Record<string, CSSProperties> = {
  main: { flex: 1, overflow: "auto", padding: 24 },
  /** 研究团队三栏工作台：与 IDE 一致占满主内容区，避免外层滚动条截断拖拽 */
  mainTeam: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
  mainIde: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
  ideWorkbenchOuter: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
  },
  ideMainRow: {
    display: "flex",
    flexDirection: "row",
    flex: 1,
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
  },
  ideLeftPane: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  ideGutter: {
    width: 6,
    flexShrink: 0,
    cursor: "col-resize",
    background: "#27272a",
    alignSelf: "stretch",
  },
  ideRightPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "row",
    alignItems: "stretch",
  },
  ideCenterStack: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  ideChartArea: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  ideQuickGutter: {
    width: 1,
    flexShrink: 0,
    background: "#27272a",
    alignSelf: "stretch",
  },
  title: { fontSize: 26, fontWeight: 700, margin: "0 0 8px" },
  subTitle: { fontSize: 16, margin: "16px 0 8px" },
  form: { display: "flex", gap: 8, marginBottom: 10 },
  input: {
    flex: 1,
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 10px",
  },
  textarea: {
    width: "100%",
    minHeight: 140,
    resize: "vertical",
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 8,
  },
  select: {
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 10px",
  },
  button: {
    background: "#7c3aed",
    border: "none",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
  },
  buttonSecondary: {
    background: "#27272a",
    border: "1px solid #3f3f46",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
  },
  actions: { display: "flex", gap: 8, marginBottom: 8 },
  meta: { display: "flex", gap: 12, fontSize: 12, color: "#a1a1aa" },
  configPageBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 0,
    width: "100%",
  },
  configSubNav: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
    padding: "10px 0",
    borderBottom: "1px solid #27272a",
  },
  configSubTab: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#a1a1aa",
    fontSize: 13,
    cursor: "pointer",
  },
  configSubTabActive: {
    borderColor: "#7c3aed",
    background: "#27272a",
    color: "#e4e4e7",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 },
  card: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 12,
  },
  cardButton: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 12,
    textAlign: "left",
    color: "#e4e4e7",
    cursor: "pointer",
  },
  cardName: { fontSize: 13, fontWeight: 600, color: "#a78bfa" },
  cardDesc: { fontSize: 12, color: "#a1a1aa" },
  mcpCardBtn: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 4,
    textAlign: "left",
    cursor: "pointer",
    font: "inherit",
    color: "inherit",
  },
  mcpCardBtnSelected: {
    borderColor: "#3b82f6",
    boxShadow: "0 0 0 1px rgba(59,130,246,0.35)",
  },
  mcpCardPillRow: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginTop: 6,
  },
  mcpCardPill: {
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 6,
    padding: "4px 8px",
    lineHeight: 1.35,
    wordBreak: "break-word",
  },
  streamBox: {
    background: "#09090b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 10,
    maxHeight: 260,
    overflow: "auto",
    color: "#d4d4d8",
    fontSize: 12,
    whiteSpace: "pre-wrap",
  },
  errorBox: {
    background: "#3f1d1d",
    border: "1px solid #7f1d1d",
    color: "#fecaca",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 10,
  },
  chatLayout: { display: "grid", gridTemplateColumns: "260px 1fr 300px", gap: 10, minHeight: 520 },
  chatLayoutIde: {
    flex: 1,
    minHeight: 0,
    gridTemplateColumns: "minmax(140px, 22%) minmax(0, 1fr) minmax(120px, 20%)",
    gap: 8,
  },
  chatIdeRoot: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  chatIdeHeader: {
    flexShrink: 0,
    fontSize: 12,
    color: "#a1a1aa",
    padding: "8px 12px",
    borderBottom: "1px solid #27272a",
    background: "#111114",
  },
  chatSidebar: {
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 10,
    background: "#111114",
  },
  chatSessionList: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
  chatSessionItem: {
    border: "1px solid #27272a",
    borderRadius: 8,
    background: "#18181b",
    color: "#e4e4e7",
    textAlign: "left",
    padding: "8px 10px",
    cursor: "pointer",
  },
  chatSessionItemActive: { borderColor: "#7c3aed" },
  chatMain: {
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 10,
    background: "#111114",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  chatMessages: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 },
  chatBubble: { padding: "8px 10px", borderRadius: 8, border: "1px solid #27272a" },
  chatBubbleUser: { background: "#27272a", alignSelf: "flex-end", maxWidth: "82%" },
  chatBubbleAgent: { background: "#18181b", alignSelf: "flex-start", maxWidth: "90%" },
  chatMeta: { fontSize: 11, color: "#a1a1aa", marginBottom: 4 },
  chartCtxBanner: {
    fontSize: 12,
    color: "#a5b4fc",
    background: "#1e1b4b",
    border: "1px solid #4338ca",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 10,
  },
  boardCol: { border: "1px solid #27272a", borderRadius: 8, padding: 10, background: "#111114" },
  boardList: { display: "flex", flexDirection: "column", gap: 8 },
  boardCard: { background: "#18181b", border: "1px solid #27272a", borderRadius: 8, padding: 10 },
  errorText: { fontSize: 12, color: "#fca5a5", marginTop: 6 },
};

// ─── TeamDashboardPanel ───────────────────────────────────────────────────────

const SIGNAL_COLOR: Record<string, string> = {
  buy: "#22c55e",
  sell: "#ef4444",
  hold: "#f59e0b",
};

const ROLE_DISPLAY: Record<string, string> = {
  analyst_fundamental: "基本面",
  analyst_technical: "技术面",
  analyst_sentiment: "情绪面",
  analyst_macro: "宏观面",
};

function formatDebateStreamLine(ev: DebateStreamEvent): string {
  const time = new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  switch (ev.type) {
    case "debate_start": {
      const p = ev.payload as { topic?: string; maxRounds?: number };
      return `[${time}] 辩论开始 · ${String(p.topic ?? "").slice(0, 160)}（最多 ${p.maxRounds ?? "?"} 轮）`;
    }
    case "debate_turn": {
      const p = ev.payload as {
        roundNumber?: number;
        speakerRole?: string;
        statement?: string;
        stance?: string;
      };
      return `[${time}] 辩论 R${p.roundNumber ?? "?"} · ${p.speakerRole ?? "?"} (${p.stance ?? ""})\n${String(p.statement ?? "").slice(0, 800)}`;
    }
    case "debate_verdict": {
      const p = ev.payload as { reasoning?: string; finalStance?: string; verdict?: string };
      return `[${time}] 辩论裁决 · ${String(p.finalStance ?? "")} / ${String(p.verdict ?? "")}\n${String(p.reasoning ?? "").slice(0, 600)}`;
    }
    case "debate_end":
      return `[${time}] 辩论结束`;
    default:
      return `[${time}] ${ev.type}`;
  }
}

const TEAM_CENTER_VIEWS = ["run", "research", "roles", "history"] as const;
type TeamCenterView = (typeof TEAM_CENTER_VIEWS)[number];
const TEAM_VIEW_TITLE: Record<TeamCenterView, string> = {
  run: "发起分析 · 工具与配置",
  research: "研究画布 · 拓扑 / 实时流 / 结论",
  roles: "成员目录",
  history: "历史信号",
};

/** 活动栏图标：Web 端用 Lucide 对齐 SF Symbols 语义（见 `appleUiSymbols.ts` 与 [SF Symbols](https://developer.apple.com/cn/sf-symbols/)）。 */
const TEAM_CENTER_GLYPH: Record<TeamCenterView, LucideIcon> = {
  run: Rocket,
  research: Network,
  roles: Users,
  history: History,
};

const TEAM_GROUPS = [
  { key: "analyst", label: "分析师团队", color: "#3b82f6" },
  { key: "researcher", label: "研究员团队", color: "#8b5cf6" },
  { key: "risk", label: "风控团队", color: "#ef4444" },
  { key: "portfolio", label: "组合管理", color: "#f59e0b" },
  { key: "execution", label: "执行团队", color: "#10b981" },
  { key: "ops", label: "运营支持", color: "#6b7280" },
];

/** 画布可多选高亮的分析师角色（与后端 MSA 四分析师一致；空集表示不过滤） */
const TEAM_RESEARCH_ANALYST_ROLES = new Set([
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
]);

const TeamDashboardPanel: FC = () => {
  const [roles, setRoles] = useState<AgentRoleCatalogItem[]>([]);
  const [ticker, setTicker] = useState("AAPL");
  /** 传给后端的分析上下文（对应 runAnalystTeam.context）；空则后端使用默认「请对 ticker 进行全面分析」 */
  const [teamAnalysisContext, setTeamAnalysisContext] = useState("");
  const [workflowRunId, setWorkflowRunId] = useState("");
  const [workflowOptions, setWorkflowOptions] = useState<Array<Record<string, unknown>>>([]);
  const [analystAgentGroupId, setAnalystAgentGroupId] = useState("");
  const [analystAgentGroupOptions, setAnalystAgentGroupOptions] = useState<AgentGroupRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalystTeamResult | null>(null);
  const [history, setHistory] = useState<SignalFusionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TeamCenterView>("run");
  const [debateConfig, setDebateConfigState] = useState<DebateConfig>({
    confidenceThreshold: 0.55,
    maxRounds: 2,
  });
  const [liveDebateEvents, setLiveDebateEvents] = useState<DebateStreamEvent[]>([]);
  const [replayTurns, setReplayTurns] = useState<DebateTurnRecord[]>([]);
  const [replayVerdict, setReplayVerdict] = useState<DebateVerdictRecord | null>(null);
  const [riskConfig, setRiskConfigState] = useState<RiskConfig>({
    vetoThreshold: 0.7,
    blockConfidenceThreshold: 0.35,
    severityMode: "balanced",
  });
  const [riskVetoLogs, setRiskVetoLogs] = useState<RiskVetoLogRecord[]>([]);
  const [screenerUniverse, setScreenerUniverse] = useState<"CN-A" | "US" | "HK">("CN-A");
  const [screenerTopN, setScreenerTopN] = useState(5);
  const [screenerRuns, setScreenerRunsState] = useState<ScreenerRunRecord[]>([]);
  const [selectedScreenerRunId, setSelectedScreenerRunId] = useState("");
  const [screenerCandidates, setScreenerCandidates] = useState<ScreenerCandidateRecord[]>([]);
  const [geneProjectId, setGeneProjectId] = useState("");
  const [genePopulationSize, setGenePopulationSize] = useState(8);
  const [geneMutationRate, setGeneMutationRate] = useState(0.12);
  const [geneGenerations, setGeneGenerations] = useState<GeneGenerationRecord[]>([]);
  const [selectedGenerationId, setSelectedGenerationId] = useState("");
  const [genomes, setGenomes] = useState<StrategyGenomeRecord[]>([]);
  const [geneTrends, setGeneTrends] = useState<GeneTrendPoint[]>([]);
  const [intentTicker, setIntentTicker] = useState("600519");
  const [intentDirection, setIntentDirection] = useState<"long" | "short" | "close">("long");
  const [intentQty, setIntentQty] = useState(100);
  const [intentTargetPrice, setIntentTargetPrice] = useState(1500);
  const [intentOrders, setIntentOrdersState] = useState<IntentOrderRecord[]>([]);
  const [selectedIntentId, setSelectedIntentId] = useState("");
  const [brokerProvider, setBrokerProvider] = useState<"futu" | "ib">("futu");
  const [brokerAccountRef, setBrokerAccountRef] = useState("default");
  const [brokerMode, setBrokerMode] = useState<"mock" | "sandbox" | "live">("mock");
  const [brokerBaseUrl, setBrokerBaseUrl] = useState("");
  const [brokerAccounts, setBrokerAccounts] = useState<BrokerAccountRecord[]>([]);
  const [brokerEvents, setBrokerEvents] = useState<BrokerOrderEventRecord[]>([]);
  const [compTasks, setCompTasks] = useState<WorkflowCompensationTaskRecord[]>([]);
  const [executionSafetyConfig, setExecutionSafetyConfigState] = useState<ExecutionSafetyConfig>({
    dryRunOnly: true,
    requireDoubleConfirm: true,
    confirmTokenTtlSec: 300,
    finalRiskScoreThreshold: 0.75,
  });
  const [lastSafetyCheck, setLastSafetyCheck] = useState<ExecutionSafetyCheckResult | null>(null);
  const [intentView, setIntentView] = useState<{
    intent: IntentOrderRecord | null;
    report: ExecutionReportRecord | null;
    deviation: IntentDeviationRecord | null;
  } | null>(null);

  const [teamGraph, setTeamGraph] = useState<AnalystTeamGraphPayload | null>(null);
  const [graphSelection, setGraphSelection] = useState<TeamGraphSelection>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [participatingAnalystRoles, setParticipatingAnalystRoles] = useState<string[]>([]);
  const [strategyScripts, setStrategyScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [strategyScriptChoice, setStrategyScriptChoice] = useState<string>("");

  const teamTriRef = useRef<HTMLDivElement | null>(null);
  const [teamLeftW, setTeamLeftW] = useState(268);
  const [teamRightW, setTeamRightW] = useState(300);
  const teamColDrag = useRef<{ which: 1 | 2; startX: number; left0: number; right0: number } | null>(null);

  const loadTeamGraph = useCallback(async (opts?: { preserveSelection?: boolean }) => {
    if (!workflowRunId.trim()) {
      setTeamGraph(null);
      return;
    }
    setGraphLoading(true);
    try {
      const g = await getAnalystTeamGraph(workflowRunId.trim());
      setTeamGraph(g);
      if (!opts?.preserveSelection) setGraphSelection(null);
    } finally {
      setGraphLoading(false);
    }
  }, [workflowRunId]);

  useEffect(() => {
    if (activeTab !== "research") return;
    void loadTeamGraph();
  }, [activeTab, loadTeamGraph]);

  /** 分析进行中轮询拓扑与台账，便于对话拓扑页实时更新 */
  useEffect(() => {
    if (!running || !workflowRunId.trim()) return;
    void loadTeamGraph({ preserveSelection: true });
    const id = window.setInterval(() => {
      void loadTeamGraph({ preserveSelection: true });
    }, 2500);
    return () => window.clearInterval(id);
  }, [running, workflowRunId, loadTeamGraph]);

  const graphToolsForNode = useMemo((): {
    tools: AnalystTeamGraphToolCall[];
    mcps: AnalystTeamGraphMcpCall[];
  } => {
    if (!teamGraph || graphSelection?.kind !== "node") return { tools: [], mcps: [] };
    const r = graphSelection.role;
    return {
      tools: teamGraph.toolCalls.filter((t) => t.agentRole === r),
      mcps: teamGraph.mcpCalls.filter((m) => m.agentRole === r),
    };
  }, [teamGraph, graphSelection]);

  const mergedLiveFeedRows = useMemo(() => {
    type Row = { key: string; t: number; kind: "interaction" | "debate"; body: string };
    const rows: Row[] = [];
    const allow = participatingAnalystRoles.length > 0 ? new Set(participatingAnalystRoles) : null;
    for (const row of teamGraph?.interactions ?? []) {
      if (allow && !allow.has(row.fromRole) && !allow.has(row.toRole)) continue;
      rows.push({
        key: `i-${row.id}`,
        t: new Date(row.createdAt).getTime() || 0,
        kind: "interaction",
        body: `${row.fromRole} → ${row.toRole} · ${row.kind}${row.toolName ? ` · ${row.toolName}` : ""}\n${row.contentText.slice(0, 1200)}`,
      });
    }
    liveDebateEvents.forEach((ev, i) => {
      rows.push({
        key: `d-${i}-${ev.ts}-${ev.type}`,
        t: ev.ts,
        kind: "debate",
        body: formatDebateStreamLine(ev),
      });
    });
    return rows.sort((a, b) => a.t - b.t).slice(-200);
  }, [teamGraph, participatingAnalystRoles, liveDebateEvents]);

  const liveFeedScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = liveFeedScrollRef.current;
    if (!el || activeTab !== "research") return;
    el.scrollTop = el.scrollHeight;
  }, [mergedLiveFeedRows, running, activeTab]);

  const filteredGraphDisplay = useMemo((): AnalystTeamGraphPayload | null => {
    if (!teamGraph) return null;
    if (!participatingAnalystRoles.length) return teamGraph;
    const allow = new Set(participatingAnalystRoles);
    const nodes = teamGraph.nodes.filter((n) => allow.has(n.role));
    const edges =
      teamGraph.edges?.filter((e) => allow.has(e.a) && allow.has(e.b)) ?? [];
    return {
      ...teamGraph,
      nodes,
      edges,
      interactions: (teamGraph.interactions ?? []).filter(
        (i) => allow.has(i.fromRole) || allow.has(i.toRole)
      ),
      toolCalls: (teamGraph.toolCalls ?? []).filter((t) => allow.has(t.agentRole)),
      mcpCalls: (teamGraph.mcpCalls ?? []).filter((m) => allow.has(m.agentRole)),
    };
  }, [teamGraph, participatingAnalystRoles]);

  const analystRoleCatalog = useMemo(
    () => roles.filter((r) => TEAM_RESEARCH_ANALYST_ROLES.has(r.role)),
    [roles]
  );

  const workflowSessionId = useMemo(() => {
    const row = workflowOptions.find((w) => String(w.id) === workflowRunId);
    const sid = row?.sessionId;
    return typeof sid === "string" && sid ? sid : "";
  }, [workflowRunId, workflowOptions]);

  useEffect(() => {
    if (analystRoleCatalog.length === 0) return;
    setParticipatingAnalystRoles((prev) => (prev.length > 0 ? prev : analystRoleCatalog.map((r) => r.role)));
  }, [analystRoleCatalog]);

  useEffect(() => {
    if (!workflowSessionId.trim()) {
      setStrategyScripts([]);
      setStrategyScriptChoice("");
      return;
    }
    void listStrategyScripts(workflowSessionId.trim()).then((all) => {
      const wf = workflowRunId.trim();
      const rows = all.filter((s) => !s.workflowRunId || s.workflowRunId === wf);
      setStrategyScripts(rows);
      setStrategyScriptChoice((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows[0]?.id ?? "";
      });
    });
  }, [workflowSessionId, workflowRunId]);

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const d = teamColDrag.current;
      const wrap = teamTriRef.current;
      if (!d || !wrap) return;
      const rect = wrap.getBoundingClientRect();
      const dx = e.clientX - d.startX;
      if (d.which === 1) {
        setTeamLeftW(Math.min(Math.max(200, d.left0 + dx), rect.width * 0.42));
      } else {
        setTeamRightW(Math.min(Math.max(200, d.right0 - dx), rect.width * 0.42));
      }
    };
    const onUp = () => {
      teamColDrag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onTeamColGutterDown = useCallback(
    (which: 1 | 2) => (e: ReactMouseEvent<HTMLDivElement>) => {
      teamColDrag.current = { which, startX: e.clientX, left0: teamLeftW, right0: teamRightW };
      e.preventDefault();
    },
    [teamLeftW, teamRightW]
  );

  const graphWrapRef = useRef<HTMLDivElement | null>(null);
  const [graphSize, setGraphSize] = useState({ w: 720, h: 420 });

  useLayoutEffect(() => {
    const el = graphWrapRef.current;
    if (!el || activeTab !== "research") return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      const w = Math.max(320, Math.floor(cr.width));
      const h = Math.max(260, Math.floor(cr.height));
      setGraphSize({ w, h });
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    setGraphSize({ w: Math.max(320, Math.floor(r.width)), h: Math.max(260, Math.floor(r.height)) });
    return () => ro.disconnect();
  }, [activeTab, teamGraph]);

  useEffect(() => {
    setGraphSelection(null);
  }, [workflowRunId, participatingAnalystRoles]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void loadTeamGraph();
    }, 400);
    return () => window.clearTimeout(t);
  }, [workflowRunId, loadTeamGraph]);

  useEffect(() => {
    void (async () => {
      getAgentRoles().then(setRoles).catch(() => {});
      void listAgentGroups()
        .then(setAnalystAgentGroupOptions)
        .catch(() => setAnalystAgentGroupOptions([]));
      try {
        const hist = await getFusionHistory({ limit: 10 });
        // #region agent log
        fetch("http://127.0.0.1:7617/ingest/82ec5b74-0b73-4815-bb8d-d6f541a02c64", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6ea60d" },
          body: JSON.stringify({
            sessionId: "6ea60d",
            hypothesisId: "H2",
            location: "MainContent.tsx:TeamDashboard:init:fusionHistory",
            message: "getFusionHistory ok",
            data: {
              count: Array.isArray(hist) ? hist.length : -1,
              sampleKeys: Array.isArray(hist) && hist[0] ? Object.keys(hist[0] as object) : [],
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        setHistory(hist);
      } catch (e) {
        // #region agent log
        fetch("http://127.0.0.1:7617/ingest/82ec5b74-0b73-4815-bb8d-d6f541a02c64", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6ea60d" },
          body: JSON.stringify({
            sessionId: "6ea60d",
            hypothesisId: "H2",
            location: "MainContent.tsx:TeamDashboard:init:fusionHistory:err",
            message: "getFusionHistory failed",
            data: { err: (e as Error).message },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
        // #endregion
        setHistory([]);
      }
      getDebateConfig().then(setDebateConfigState).catch(() => {});
      getRiskConfig().then(setRiskConfigState).catch(() => {});
      getExecutionSafetyConfig().then(setExecutionSafetyConfigState).catch(() => {});
      const wfRows = (await listMonitorWorkflows({})) as Array<Record<string, unknown>>;
      // #region agent log
      fetch("http://127.0.0.1:7617/ingest/82ec5b74-0b73-4815-bb8d-d6f541a02c64", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6ea60d" },
        body: JSON.stringify({
          sessionId: "6ea60d",
          hypothesisId: "H4",
          location: "MainContent.tsx:TeamDashboard:init:workflows",
          message: "listMonitorWorkflows",
          data: { wfCount: wfRows.length, firstId: wfRows[0]?.id ? String(wfRows[0].id) : null },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      setWorkflowOptions(wfRows);
      if (!workflowRunId && wfRows[0]?.id) {
        setWorkflowRunId(String(wfRows[0].id));
      }
      await refreshBrokerAndComp();
    })().catch(() => {});
  }, []);

  useEffect(() => {
    if (activeTab !== "history") return;
    void (async () => {
      const rows = await getFusionHistory({ limit: 50 }).catch(() => [] as SignalFusionRecord[]);
      setHistory(rows);
      // #region agent log
      fetch("http://127.0.0.1:7617/ingest/82ec5b74-0b73-4815-bb8d-d6f541a02c64", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6ea60d" },
        body: JSON.stringify({
          sessionId: "6ea60d",
          hypothesisId: "H5",
          location: "MainContent.tsx:TeamDashboard:tab:history",
          message: "history tab refetch",
          data: { fetchedLen: rows.length },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
    })();
  }, [activeTab]);

  useEffect(() => {
    const row = workflowOptions.find((item) => String(item.id) === workflowRunId);
    if (!row) return;
    const projectId = row.projectId ? String(row.projectId) : "";
    if (projectId && !geneProjectId) {
      setGeneProjectId(projectId);
    }
  }, [workflowRunId, workflowOptions, geneProjectId]);

  useEffect(() => {
    if (!workflowRunId) return;
    void refreshIntentOrders().catch(() => {});
  }, [workflowRunId]);

  const [runProgress, setRunProgress] = useState<string>("");

  const handleRun = async () => {
    if (!ticker.trim()) return;
    setError(null);
    setRunning(true);
    setResult(null);
    setLiveDebateEvents([]);
    setReplayTurns([]);
    setReplayVerdict(null);
    setRunProgress("正在启动分析任务...");
    try {
      const wfId = workflowRunId;
      if (!wfId) {
        setError("请先选择 workflowRunId（可在下拉框直接选取最近工作流）");
        setRunning(false);
        return;
      }
      setActiveTab("research");
      const unsubscribe = subscribeDebateStream({
        workflowRunId: wfId,
        onEvent: (event) => {
          setLiveDebateEvents((prev) => [...prev.slice(-49), event]);
        },
        onError: () => {},
      });
      void loadTeamGraph({ preserveSelection: true });
      // 使用异步轮询，避免浏览器 60s 系统级超时
      const res = await runAnalystTeam({
        workflowRunId: wfId,
        ticker: ticker.trim(),
        context: teamAnalysisContext.trim() || undefined,
        agentGroupId: analystAgentGroupId.trim() || undefined,
        onProgress: (elapsedMs) => {
          const secs = Math.floor(elapsedMs / 1000);
          setRunProgress(`分析进行中… 已用时 ${secs}s（多 Agent LLM 推理，请耐心等待）`);
        },
      });
      unsubscribe();
      setResult(res);
      setRunProgress("");
      setActiveTab("research");
      void loadTeamGraph();
      if (res.debate?.sessionId) {
        const [turns, verdict] = await Promise.all([
          getDebateTurns(res.debate.sessionId),
          getDebateVerdict(res.debate.sessionId),
        ]);
        setReplayTurns(turns);
        setReplayVerdict(verdict);
      }
      const vetoLogs = await getRiskVetoLogs(wfId);
      setRiskVetoLogs(vetoLogs);
      const newHistory = await getFusionHistory({ limit: 10 });
      setHistory(newHistory);
    } catch (e) {
      setError((e as Error).message);
      setRunProgress("");
    } finally {
      setRunning(false);
    }
  };

  const saveDebateRuntimeConfig = async () => {
    try {
      const next = await saveDebateConfig(debateConfig);
      setDebateConfigState(next);
    } catch (e) {
      setError(`保存辩论配置失败: ${(e as Error).message}`);
    }
  };

  const saveRiskRuntimeConfig = async () => {
    try {
      const next = await saveRiskConfig(riskConfig);
      setRiskConfigState(next);
    } catch (e) {
      setError(`保存风控配置失败: ${(e as Error).message}`);
    }
  };

  const runScreenerNow = async () => {
    if (!workflowRunId) {
      setError("请先填写 workflowRunId，再运行选股。");
      return;
    }
    try {
      const out = await runScreener({
        workflowRunId,
        universe: screenerUniverse,
        topN: screenerTopN,
      });
      const runs = await listScreenerRuns(workflowRunId);
      setScreenerRunsState(runs);
      setSelectedScreenerRunId(out.screenerRunId);
      const candidates = await listScreenerCandidates(out.screenerRunId);
      setScreenerCandidates(candidates);
    } catch (e) {
      setError(`运行选股失败: ${(e as Error).message}`);
    }
  };

  const initGenePoolNow = async () => {
    if (!geneProjectId) {
      setError("请填写 Gene ProjectId");
      return;
    }
    try {
      await initGenePool({
        projectId: geneProjectId,
        populationSize: genePopulationSize,
        mutationRate: geneMutationRate,
      });
      const gens = await listGeneGenerations(geneProjectId);
      setGeneGenerations(gens);
      if (gens[0]) {
        setSelectedGenerationId(gens[0].id);
        const rows = await listGenomes(gens[0].id);
        setGenomes(rows);
      }
      const trends = await listGeneTrends(geneProjectId);
      setGeneTrends(trends);
    } catch (e) {
      setError(`初始化基因池失败: ${(e as Error).message}`);
    }
  };

  const evolveNow = async () => {
    if (!geneProjectId) {
      setError("请填写 Gene ProjectId");
      return;
    }
    try {
      await evolveGenePool(geneProjectId);
      const gens = await listGeneGenerations(geneProjectId);
      setGeneGenerations(gens);
      if (gens[0]) {
        setSelectedGenerationId(gens[0].id);
        const rows = await listGenomes(gens[0].id);
        setGenomes(rows);
      }
      const trends = await listGeneTrends(geneProjectId);
      setGeneTrends(trends);
    } catch (e) {
      setError(`演化失败: ${(e as Error).message}`);
    }
  };

  const refreshIntentOrders = async () => {
    if (!workflowRunId) return;
    const rows = await listIntentOrders(workflowRunId);
    setIntentOrdersState(rows);
  };

  const createIntentNow = async () => {
    if (!workflowRunId) {
      setError("请先填写 workflowRunId");
      return;
    }
    try {
      const created = await createIntentOrder({
        workflowRunId,
        ticker: intentTicker,
        direction: intentDirection,
        quantity: intentQty,
        targetPrice: intentTargetPrice,
        rationale: "manual REIA test",
      });
      await refreshIntentOrders();
      setSelectedIntentId(created.id);
      const view = await getIntentExecutionView(created.id);
      setIntentView(view);
    } catch (e) {
      setError(`创建意图失败: ${(e as Error).message}`);
    }
  };

  const executeIntentNow = async () => {
    if (!selectedIntentId) {
      setError("请选择一个意图订单");
      return;
    }
    try {
      const check = await requestExecutionConfirmation(selectedIntentId);
      setLastSafetyCheck(check);
      const shouldContinue = window.confirm(
        [
          `最终风控得分: ${(check.finalRiskScore * 100).toFixed(1)}%`,
          `执行模式: ${check.dryRunOnly ? "仅演练(Paper)" : "允许实盘(Live)"}`,
          `双重确认: ${check.requireDoubleConfirm ? "开启" : "关闭"}`,
          check.blockers.length ? `阻断原因: ${check.blockers.join(", ")}` : "无阻断原因",
          "确认继续执行？",
        ].join("\n")
      );
      if (!shouldContinue) return;
      if (check.blockers.length > 0 && !check.dryRunOnly) {
        setError(`执行被阻断：${check.blockers.join(", ")}`);
        return;
      }
      await executeIntentConfirmed({
        intentOrderId: selectedIntentId,
        confirmToken: check.confirmToken,
        provider: brokerProvider,
      });
      await refreshIntentOrders();
      const view = await getIntentExecutionView(selectedIntentId);
      setIntentView(view);
    } catch (e) {
      setError(`执行意图失败: ${(e as Error).message}`);
    }
  };

  const loadIntentView = async (intentId: string) => {
    setSelectedIntentId(intentId);
    const view = await getIntentExecutionView(intentId);
    setIntentView(view);
  };

  const saveExecutionSafetyRuntimeConfig = async () => {
    try {
      const next = await saveExecutionSafetyConfig(executionSafetyConfig);
      setExecutionSafetyConfigState(next);
    } catch (e) {
      setError(`保存执行安全配置失败: ${(e as Error).message}`);
    }
  };

  const refreshBrokerAndComp = async () => {
    const [accounts, events, tasks] = await Promise.all([
      listBrokerAccounts(),
      listBrokerEvents(undefined, 30),
      listWorkflowCompensations({ workflowRunId: workflowRunId || undefined, limit: 30 }),
    ]);
    setBrokerAccounts(accounts);
    setBrokerEvents(events);
    setCompTasks(tasks);
  };

  const saveBrokerAccountNow = async () => {
    await upsertBrokerAccount({
      provider: brokerProvider,
      accountRef: brokerAccountRef || "default",
      mode: brokerMode,
      baseUrl: brokerBaseUrl || undefined,
      enabled: true,
    });
    await refreshBrokerAndComp();
  };

  const checkBrokerNow = async () => {
    const out = await checkBrokerHealth({ provider: brokerProvider, accountRef: brokerAccountRef || "default" });
    setError(`Broker健康检查: ${out.provider} ${out.status} ${out.message}`);
    await refreshBrokerAndComp();
  };

  const enqueueRetryNow = async () => {
    if (!workflowRunId) {
      setError("请选择 workflowRunId 后再加入补偿队列");
      return;
    }
    await enqueueWorkflowCompensation({
      workflowRunId,
      actionType: "retry_from_start",
      reason: "manual enqueue from team dashboard",
    });
    await refreshBrokerAndComp();
  };

  const processCompNow = async () => {
    const out = await processWorkflowCompensations(5);
    setError(`补偿队列处理: picked=${out.picked}, success=${out.success}, failed=${out.failed}`);
    await refreshBrokerAndComp();
  };

  const loadLatestFusion = async () => {
    if (!workflowRunId.trim()) {
      setError("请先选择工作流");
      return;
    }
    setError(null);
    try {
      const data = await getSignalFusion(workflowRunId);
      if (!data) {
        setError("数据库中暂无该工作流的融合记录");
        return;
      }
      const d = data as unknown as AnalystTeamResult & {
        signalBreakdown?: AnalystTeamResult["breakdown"];
      };
      setResult({
        fusionId: d.fusionId,
        ticker: d.ticker,
        fusedSignal: d.fusedSignal,
        fusedConfidence: d.fusedConfidence,
        debateTriggered: d.debateTriggered,
        breakdown: d.breakdown?.length ? d.breakdown : d.signalBreakdown ?? [],
        report:
          d.report?.trim() ||
          "（从数据库恢复：仅含融合与分项信号，完整文字报告需重新「启动团队分析」。）",
        debate: d.debate,
        risk: d.risk,
      });
      setActiveTab("research");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const groupedRoles = TEAM_GROUPS.map((g) => ({
    ...g,
    members: roles.filter((r) => r.team === g.key),
  }));

  return (
    <div style={teamStyles.container}>
      <div style={teamStyles.teamWorkbenchShell}>
        <div ref={teamTriRef} style={teamStyles.teamTriRow}>
        <aside style={{ ...teamStyles.leftRail, width: teamLeftW, flexShrink: 0, alignSelf: "stretch" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7", marginBottom: 10 }}>研究与工作流</div>
          <div style={teamStyles.field}>
            <label style={teamStyles.label}>标的代码</label>
            <input
              style={teamStyles.input}
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="e.g. AAPL / 600519"
            />
          </div>
          <div style={{ ...teamStyles.field, marginTop: 10 }}>
            <label style={teamStyles.label}>分析提示（可选）</label>
            <textarea
              style={teamStyles.textarea}
              rows={4}
              value={teamAnalysisContext}
              onChange={(e) => setTeamAnalysisContext(e.target.value)}
              placeholder={`留空则使用默认：请对 ${ticker.trim() || "标的"} 进行全面分析。可写侧重点、假设或约束。`}
            />
          </div>
          <div style={{ ...teamStyles.field, marginTop: 10 }}>
            <label style={teamStyles.label}>工作流 ID</label>
            <select style={teamStyles.input} value={workflowRunId} onChange={(e) => setWorkflowRunId(e.target.value)}>
              <option value="">请选择 workflow</option>
              {workflowOptions.slice(0, 80).map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.id)} · {String(row.status)} · {String(row.mode)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ ...teamStyles.field, marginTop: 10 }}>
            <label style={teamStyles.label}>分析师编组（可选）</label>
            <select
              style={teamStyles.input}
              value={analystAgentGroupId}
              onChange={(e) => setAnalystAgentGroupId(e.target.value)}
            >
              <option value="">默认（全部启用的分析师定义）</option>
              {analystAgentGroupOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            style={{ ...teamStyles.btn, marginTop: 12, width: "100%", ...(running ? teamStyles.btnDisabled : {}) }}
            onClick={handleRun}
            disabled={running}
          >
            {running ? "分析中…" : "启动团队分析"}
          </button>
          {running && runProgress && (
            <div
              style={{
                background: "#1e293b",
                color: "#38bdf8",
                fontSize: 12,
                padding: "8px 10px",
                marginTop: 10,
                borderRadius: 6,
                border: "1px solid #334155",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Loader2 size={14} className="team-loader-spin" aria-hidden style={{ flexShrink: 0 }} />
              <span>{runProgress}</span>
            </div>
          )}
          {error && <div style={{ ...teamStyles.error, marginTop: 10, fontSize: 12 }}>{error}</div>}

          <div style={{ marginTop: 14, borderTop: "1px solid #27272a", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1", marginBottom: 6 }}>团队成员（画布）</div>
            <p style={{ fontSize: 11, color: "#71717a", marginBottom: 8 }}>
              从目录加入或移出；仅影响中栏拓扑与实时流的展示范围（实际编排仍由后端与编组决定）。
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {participatingAnalystRoles.length === 0 ? (
                <span style={{ fontSize: 11, color: "#71717a" }}>暂无成员，请从下方添加</span>
              ) : (
                participatingAnalystRoles.map((role) => {
                  const meta = analystRoleCatalog.find((x) => x.role === role);
                  return (
                    <div
                      key={role}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: "1px solid #3f3f46",
                        fontSize: 11,
                        color: "#e4e4e7",
                        background: "#18181b",
                      }}
                    >
                      <span>{meta?.displayName ?? role}</span>
                      <button
                        type="button"
                        style={{ ...teamStyles.buttonSecondary, padding: "0 6px", fontSize: 10 }}
                        onClick={() => setParticipatingAnalystRoles((prev) => prev.filter((x) => x !== role))}
                      >
                        −
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <select
              style={{ ...teamStyles.input, width: "100%", fontSize: 12 }}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                setParticipatingAnalystRoles((prev) => (prev.includes(v) ? prev : [...prev, v]));
                e.target.value = "";
              }}
            >
              <option value="">＋ 添加分析师…</option>
              {analystRoleCatalog
                .filter((r) => !participatingAnalystRoles.includes(r.role))
                .map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.displayName} ({r.role})
                  </option>
                ))}
            </select>
          </div>

          <div style={{ marginTop: 14, borderTop: "1px solid #27272a", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1", marginBottom: 6 }}>工作流对话拓扑（只读）</div>
            <p style={{ fontSize: 11, color: "#71717a", marginBottom: 8 }}>
              边由系统在分析过程中根据交互生成；无数据时请在「研究画布」刷新拓扑。
            </p>
            {!teamGraph?.edges?.length ? (
              <div style={{ fontSize: 11, color: "#52525b" }}>暂无边记录</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "#d4d4d8", maxHeight: 160, overflow: "auto" }}>
                {teamGraph.edges.slice(0, 24).map((ed) => (
                  <li key={ed.key} style={{ marginBottom: 4 }}>
                    {ed.a} ↔ {ed.b} · 消息 {ed.messageCount} · 工具 {ed.toolCount}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧栏宽度"
          onMouseDown={onTeamColGutterDown(1)}
          style={teamStyles.teamColGutter}
        />

        <div style={teamStyles.centerCol}>
          <div style={teamStyles.ideCenterWrap}>
            <nav style={teamStyles.teamActivityBar} aria-label="研究团队视图">
              {TEAM_CENTER_VIEWS.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={TEAM_VIEW_TITLE[t]}
                  style={{
                    ...teamStyles.teamActBtn,
                    ...(activeTab === t ? teamStyles.teamActBtnActive : {}),
                  }}
                  onClick={() => setActiveTab(t)}
                >
                  {(() => {
                    const Glyph = TEAM_CENTER_GLYPH[t];
                    return (
                      <Glyph
                        size={20}
                        strokeWidth={1.75}
                        color="currentColor"
                        aria-hidden
                      />
                    );
                  })()}
                </button>
              ))}
            </nav>
            <div style={teamStyles.teamMainStage}>
              <header style={teamStyles.teamEditorTitleBar}>
                <span style={{ fontWeight: 600, color: "#e4e4e7" }}>{TEAM_VIEW_TITLE[activeTab]}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {running ? (
                    <span style={{ color: "#38bdf8", fontSize: 11 }}>
                      ● 分析进行中 · 拓扑与对话每 2.5s 刷新
                    </span>
                  ) : null}
                  {graphLoading && activeTab === "research" ? (
                    <span style={{ color: "#a1a1aa", fontSize: 11 }}>加载图数据…</span>
                  ) : null}
                </span>
              </header>
              <div style={teamStyles.teamEditorBody}>
      {/* Run Panel */}
      {activeTab === "run" && (
        <div style={teamStyles.panel}>
          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>辩论触发阈值（低于触发）</label>
              <input
                style={teamStyles.input}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={debateConfig.confidenceThreshold}
                onChange={(e) =>
                  setDebateConfigState((prev) => ({
                    ...prev,
                    confidenceThreshold: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>最大辩论轮次</label>
              <input
                style={teamStyles.input}
                type="number"
                min={1}
                max={5}
                value={debateConfig.maxRounds}
                onChange={(e) =>
                  setDebateConfigState((prev) => ({
                    ...prev,
                    maxRounds: Number(e.target.value),
                  }))
                }
              />
            </div>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void saveDebateRuntimeConfig()}>
              保存辩论配置
            </button>
          </div>
          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>风险否决阈值（风险分 ≥ 阈值拦截）</label>
              <input
                style={teamStyles.input}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={riskConfig.vetoThreshold}
                onChange={(e) =>
                  setRiskConfigState((prev) => ({
                    ...prev,
                    vetoThreshold: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>低置信阻断阈值</label>
              <input
                style={teamStyles.input}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={riskConfig.blockConfidenceThreshold}
                onChange={(e) =>
                  setRiskConfigState((prev) => ({
                    ...prev,
                    blockConfidenceThreshold: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>风控烈度</label>
              <select
                style={teamStyles.input}
                value={riskConfig.severityMode}
                onChange={(e) =>
                  setRiskConfigState((prev) => ({
                    ...prev,
                    severityMode: e.target.value as RiskConfig["severityMode"],
                  }))
                }
              >
                <option value="conservative">conservative</option>
                <option value="balanced">balanced</option>
                <option value="aggressive">aggressive</option>
              </select>
            </div>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void saveRiskRuntimeConfig()}>
              保存风控配置
            </button>
          </div>

          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>选股市场</label>
              <select
                style={teamStyles.input}
                value={screenerUniverse}
                onChange={(e) => setScreenerUniverse(e.target.value as "CN-A" | "US" | "HK")}
              >
                <option value="CN-A">CN-A</option>
                <option value="US">US</option>
                <option value="HK">HK</option>
              </select>
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>TopN</label>
              <input
                style={teamStyles.input}
                type="number"
                min={1}
                max={20}
                value={screenerTopN}
                onChange={(e) => setScreenerTopN(Number(e.target.value))}
              />
            </div>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void runScreenerNow()}>
              运行选股
            </button>
          </div>

          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>Gene ProjectId</label>
              <input
                style={teamStyles.input}
                value={geneProjectId}
                onChange={(e) => setGeneProjectId(e.target.value)}
                placeholder="project id"
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>种群大小</label>
              <input
                style={teamStyles.input}
                type="number"
                min={3}
                max={20}
                value={genePopulationSize}
                onChange={(e) => setGenePopulationSize(Number(e.target.value))}
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>变异率</label>
              <input
                style={teamStyles.input}
                type="number"
                min={0.01}
                max={0.5}
                step={0.01}
                value={geneMutationRate}
                onChange={(e) => setGeneMutationRate(Number(e.target.value))}
              />
            </div>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void initGenePoolNow()}>
              初始化基因池
            </button>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void evolveNow()}>
              演化一代
            </button>
          </div>

          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>执行安全：仅演练</label>
              <select
                style={teamStyles.input}
                value={executionSafetyConfig.dryRunOnly ? "yes" : "no"}
                onChange={(e) =>
                  setExecutionSafetyConfigState((prev) => ({
                    ...prev,
                    dryRunOnly: e.target.value === "yes",
                  }))
                }
              >
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>双重确认</label>
              <select
                style={teamStyles.input}
                value={executionSafetyConfig.requireDoubleConfirm ? "yes" : "no"}
                onChange={(e) =>
                  setExecutionSafetyConfigState((prev) => ({
                    ...prev,
                    requireDoubleConfirm: e.target.value === "yes",
                  }))
                }
              >
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>确认 token TTL(秒)</label>
              <input
                style={teamStyles.input}
                type="number"
                min={30}
                max={3600}
                value={executionSafetyConfig.confirmTokenTtlSec}
                onChange={(e) =>
                  setExecutionSafetyConfigState((prev) => ({
                    ...prev,
                    confirmTokenTtlSec: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>最终风险阈值</label>
              <input
                style={teamStyles.input}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={executionSafetyConfig.finalRiskScoreThreshold}
                onChange={(e) =>
                  setExecutionSafetyConfigState((prev) => ({
                    ...prev,
                    finalRiskScoreThreshold: Number(e.target.value),
                  }))
                }
              />
            </div>
            <button
              type="button"
              style={teamStyles.buttonSecondary}
              onClick={() => void saveExecutionSafetyRuntimeConfig()}
            >
              保存执行安全配置
            </button>
          </div>

          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>Intent Ticker</label>
              <input style={teamStyles.input} value={intentTicker} onChange={(e) => setIntentTicker(e.target.value)} />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>方向</label>
              <select
                style={teamStyles.input}
                value={intentDirection}
                onChange={(e) => setIntentDirection(e.target.value as "long" | "short" | "close")}
              >
                <option value="long">long</option>
                <option value="short">short</option>
                <option value="close">close</option>
              </select>
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>数量</label>
              <input
                style={teamStyles.input}
                type="number"
                min={1}
                value={intentQty}
                onChange={(e) => setIntentQty(Number(e.target.value))}
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>目标价</label>
              <input
                style={teamStyles.input}
                type="number"
                min={0.01}
                step={0.01}
                value={intentTargetPrice}
                onChange={(e) => setIntentTargetPrice(Number(e.target.value))}
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>Broker</label>
              <select
                style={teamStyles.input}
                value={brokerProvider}
                onChange={(e) => setBrokerProvider(e.target.value as "futu" | "ib")}
              >
                <option value="futu">futu</option>
                <option value="ib">ib</option>
              </select>
            </div>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void createIntentNow()}>
              创建意图
            </button>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void executeIntentNow()}>
              安全确认后执行
            </button>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void refreshIntentOrders()}>
              刷新意图列表
            </button>
          </div>
          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>Broker 账号</label>
              <input
                style={teamStyles.input}
                value={brokerAccountRef}
                onChange={(e) => setBrokerAccountRef(e.target.value)}
                placeholder="account ref"
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>Broker 模式</label>
              <select style={teamStyles.input} value={brokerMode} onChange={(e) => setBrokerMode(e.target.value as "mock" | "sandbox" | "live")}>
                <option value="mock">mock</option>
                <option value="sandbox">sandbox</option>
                <option value="live">live</option>
              </select>
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>Broker Base URL</label>
              <input
                style={teamStyles.input}
                value={brokerBaseUrl}
                onChange={(e) => setBrokerBaseUrl(e.target.value)}
                placeholder="http://broker-api"
              />
            </div>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void saveBrokerAccountNow()}>
              保存 Broker 账号
            </button>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void checkBrokerNow()}>
              健康检查
            </button>
          </div>
          <div style={teamStyles.configRow}>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void refreshBrokerAndComp()}>
              刷新补偿与Broker状态
            </button>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void enqueueRetryNow()}>
              加入失败补偿队列
            </button>
            <button type="button" style={teamStyles.buttonSecondary} onClick={() => void processCompNow()}>
              执行补偿队列
            </button>
          </div>
          <div style={teamStyles.configRow}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>意图订单选择器（联动）</label>
              <select style={teamStyles.input} value={selectedIntentId} onChange={(e) => void loadIntentView(e.target.value)}>
                <option value="">请选择 intent</option>
                {intentOrders.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.ticker} · {it.direction} · {it.status}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ fontSize: 10, color: "#52525b", marginTop: 8, lineHeight: 1.5 }}>
            本地缓存：选股 {screenerRuns.length} · 候选 {screenerCandidates.length} · 基因世代 {geneGenerations.length} ·
            基因组 {genomes.length} · 趋势 {geneTrends.length} · Broker {brokerAccounts.length} · Broker 事件{" "}
            {brokerEvents.length} · 补偿 {compTasks.length}
            {lastSafetyCheck ? " · 安全校验已缓存" : ""}
            {intentView?.intent ? " · 意图执行视图已缓存" : ""}
            {selectedScreenerRunId ? ` · 选股 run ${selectedScreenerRunId.slice(0, 8)}…` : ""}
            {selectedGenerationId ? ` · 世代 ${selectedGenerationId.slice(0, 8)}…` : ""}
          </div>

        </div>
      )}


      {/* Roles Panel */}
      {activeTab === "roles" && (
        <div style={teamStyles.panel}>
          {groupedRoles.map((group) => (
            <div key={group.key} style={teamStyles.groupBlock}>
              <div style={{ ...teamStyles.groupTitle, color: group.color }}>
                {group.label}（{group.members.length}）
              </div>
              <div style={teamStyles.memberGrid}>
                {group.members.map((r) => (
                  <div key={r.role} style={teamStyles.memberCard}>
                    <div style={teamStyles.memberRole}>{r.displayName}</div>
                    <div style={teamStyles.memberDesc}>{r.description}</div>
                    <div style={teamStyles.memberTag}>{r.role}</div>
                  </div>
                ))}
                {group.members.length === 0 && (
                  <div style={teamStyles.memberEmpty}>暂无成员（需运行后端以加载数据）</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* History Panel */}
      {activeTab === "history" && (
        <div style={teamStyles.panel}>
          <h3 style={teamStyles.sectionTitle}>近期信号融合记录</h3>
          {history.length === 0 ? (
            <div style={teamStyles.empty}>暂无历史记录</div>
          ) : (
            <table style={teamStyles.table}>
              <thead>
                <tr>
                  <th style={teamStyles.th}>时间</th>
                  <th style={teamStyles.th}>标的</th>
                  <th style={teamStyles.th}>融合信号</th>
                  <th style={teamStyles.th}>置信度</th>
                  <th style={teamStyles.th}>辩论</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td style={teamStyles.td}>{new Date(h.createdAt).toLocaleString()}</td>
                    <td style={teamStyles.td}>{h.ticker}</td>
                    <td style={{ ...teamStyles.td, color: SIGNAL_COLOR[h.fusedSignal] }}>
                      {h.fusedSignal.toUpperCase()}
                    </td>
                    <td style={teamStyles.td}>{(h.fusedConfidence * 100).toFixed(0)}%</td>
                    <td style={teamStyles.td}>{h.debateTriggered ? "是" : "否"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "research" && (
        <div style={{ ...teamStyles.panel, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <h3 style={{ ...teamStyles.sectionTitle, marginTop: 0 }}>多 Agent 对话拓扑</h3>
          <p style={{ fontSize: 12, color: "#a1a1aa", marginBottom: 12 }}>
            拓扑与实时对话流同屏；下方为分析结论。选中节点时显示 Tool/MCP。分析进行中自动轮询。
          </p>
          {!workflowRunId.trim() ? (
            <div style={teamStyles.empty}>请先在左侧栏选择工作流 ID</div>
          ) : (
            <>
              <div style={teamStyles.row}>
                <button
                  type="button"
                  style={teamStyles.btn}
                  disabled={graphLoading}
                  onClick={() => void loadTeamGraph({ preserveSelection: true })}
                >
                  {graphLoading ? "加载中…" : "刷新拓扑"}
                </button>
                <span style={{ fontSize: 12, color: "#71717a" }}>
                  {participatingAnalystRoles.length > 0
                    ? `展示 ${participatingAnalystRoles.length} 名分析师`
                    : "画布：全部节点"}
                </span>
              </div>
              {filteredGraphDisplay && filteredGraphDisplay.nodes.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    marginTop: 12,
                    flex: 1,
                    minHeight: 0,
                  }}
                >
                  <div ref={graphWrapRef} style={{ ...teamStyles.graphCanvasHost, flex: "1 1 50%", minHeight: 260 }}>
                    <TeamAgentGraph
                      nodes={filteredGraphDisplay.nodes}
                      edges={filteredGraphDisplay.edges}
                      width={graphSize.w}
                      height={graphSize.h}
                      selection={graphSelection}
                      onSelectNode={(role) => setGraphSelection({ kind: "node", role })}
                      onSelectEdge={(a, b) => setGraphSelection({ kind: "edge", a, b })}
                      onClear={() => setGraphSelection(null)}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ ...teamStyles.empty, marginTop: 12 }}>
                  {graphLoading
                    ? "…"
                    : teamGraph && teamGraph.nodes.length > 0 && participatingAnalystRoles.length > 0
                      ? "当前成员过滤后无可见节点，请在左侧调整参与分析师。"
                      : "暂无拓扑节点：分析刚开始或未落库时可能短暂为空；下方仍可查看实时对话流。"}
                </div>
              )}
              <div style={{ marginTop: 14, flex: "1 1 42%", minHeight: 180, display: "flex", flexDirection: "column" }}>
                <div style={{ ...teamStyles.sectionTitle, marginBottom: 6 }}>
                  实时对话流 {running ? "· 自动刷新" : ""}
                </div>
                <div
                  ref={liveFeedScrollRef}
                  style={{
                    flex: 1,
                    minHeight: 140,
                    overflow: "auto",
                    background: "#08080a",
                    border: "1px solid #2a2a30",
                    borderRadius: 8,
                    padding: 10,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: 11,
                    lineHeight: 1.45,
                    color: "#d4d4d8",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {mergedLiveFeedRows.length === 0 ? (
                    <span style={{ color: "#71717a" }}>
                      {running
                        ? "等待各分析师与系统写入交互记录（轮询中）…"
                        : "暂无记录。启动分析后，研究队交互与辩论事件将按时间显示在此。"}
                    </span>
                  ) : (
                    mergedLiveFeedRows.map((row) => (
                      <div
                        key={row.key}
                        style={{
                          marginBottom: 10,
                          paddingBottom: 8,
                          borderBottom: "1px solid #1a1a1f",
                          borderLeft: row.kind === "debate" ? "3px solid #7c3aed" : "3px solid #2563eb",
                          paddingLeft: 8,
                        }}
                      >
                        {row.body}
                      </div>
                    ))
                  )}
                </div>
              </div>
              {graphSelection?.kind === "node" ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ ...teamStyles.sectionTitle, marginBottom: 6 }}>Tool / MCP（{graphSelection.role}）</div>
                  {graphToolsForNode.tools.length === 0 && graphToolsForNode.mcps.length === 0 ? (
                    <div style={{ fontSize: 11, color: "#71717a" }}>无工具记录</div>
                  ) : (
                    <div style={{ maxHeight: 120, overflow: "auto", fontSize: 10, color: "#d4d4d8" }}>
                      {graphToolsForNode.tools.map((t) => (
                        <div key={t.id} style={{ marginBottom: 4 }}>
                          [{t.createdAt}] {t.toolKind} · {t.toolName} · {t.status}
                        </div>
                      ))}
                      {graphToolsForNode.mcps.map((m) => (
                        <div key={m.id} style={{ marginBottom: 4 }}>
                          [MCP] {m.serverName}/{m.toolName} · {m.status}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div style={{ marginTop: 18, borderTop: "1px solid #2a2a30", paddingTop: 12 }}>
                <h3 style={{ ...teamStyles.sectionTitle, marginTop: 0 }}>分析结论</h3>
                <div style={teamStyles.row}>
                  <button
                    type="button"
                    style={teamStyles.buttonSecondary}
                    onClick={() => void loadLatestFusion()}
                    disabled={!workflowRunId}
                  >
                    从数据库加载融合结果
                  </button>
                </div>
                {!result && (
                  <div style={{ ...teamStyles.empty, marginTop: 8 }}>暂无结论；运行分析或从库加载。</div>
                )}
                {result && (
                  <div style={{ marginTop: 10 }}>
                    <div style={teamStyles.heroBox}>
                      <span style={{ ...teamStyles.heroBadge, color: SIGNAL_COLOR[result.fusedSignal] }}>
                        {result.fusedSignal.toUpperCase()}
                      </span>
                      <div style={teamStyles.heroMeta}>
                        <span>置信度：{(result.fusedConfidence * 100).toFixed(0)}%</span>
                        {result.debateTriggered ? <span style={teamStyles.debateTag}>⚠️ 建议触发辩论</span> : null}
                      </div>
                    </div>
                    <h3 style={teamStyles.sectionTitle}>多信号融合 (MSA)</h3>
                    <div style={teamStyles.radarGrid}>
                      {result.breakdown.map((b) => (
                        <div key={b.role} style={teamStyles.radarCard}>
                          <div style={teamStyles.radarRole}>{ROLE_DISPLAY[b.role] ?? b.role}</div>
                          <div style={{ ...teamStyles.radarSignal, color: SIGNAL_COLOR[b.signal] }}>{b.signal.toUpperCase()}</div>
                          <div style={teamStyles.radarBar}>
                            <div
                              style={{
                                ...teamStyles.radarFill,
                                width: `${Math.round(b.confidence * 100)}%`,
                                background: SIGNAL_COLOR[b.signal],
                              }}
                            />
                          </div>
                          <div style={teamStyles.radarConf}>{(b.confidence * 100).toFixed(0)}%</div>
                        </div>
                      ))}
                    </div>
                    {result.debate ? (
                      <>
                        <h3 style={teamStyles.sectionTitle}>辩论裁决</h3>
                        <div style={teamStyles.debateBox}>
                          <div>裁决：{result.debate.verdict}</div>
                          <div>最终立场：{result.debate.finalStance.toUpperCase()}</div>
                          <div style={teamStyles.debateReason}>{result.debate.reasoning}</div>
                        </div>
                      </>
                    ) : null}
                    {result.risk ? (
                      <>
                        <h3 style={teamStyles.sectionTitle}>风控</h3>
                        <div
                          style={{
                            ...teamStyles.riskBox,
                            borderColor: result.risk.vetoed ? "#7f1d1d" : "#14532d",
                            background: result.risk.vetoed ? "#3f1d1d" : "#052e16",
                          }}
                        >
                          <div>{result.risk.vetoed ? "已拦截" : "通过"} · {result.risk.severity}</div>
                          <div>{result.risk.reason}</div>
                        </div>
                      </>
                    ) : null}
                    {(replayTurns.length > 0 || replayVerdict) && (
                      <>
                        <h3 style={teamStyles.sectionTitle}>辩论回放</h3>
                        <div style={teamStyles.replayBox}>
                          {replayTurns.map((t) => (
                            <div key={t.id} style={teamStyles.replayTurn}>
                              <div style={teamStyles.replayMeta}>
                                第 {t.roundNumber} 轮 · {t.speakerRole} · {t.stance.toUpperCase()} ·{" "}
                                {(t.confidence * 100).toFixed(0)}%
                              </div>
                              <div>{t.statement}</div>
                            </div>
                          ))}
                          {replayVerdict ? (
                            <div style={teamStyles.replayVerdict}>
                              裁决：{replayVerdict.finalStance.toUpperCase()} · 共识度{" "}
                              {(replayVerdict.consensusScore * 100).toFixed(0)}%
                              <br />
                              {replayVerdict.reasoning}
                            </div>
                          ) : null}
                        </div>
                      </>
                    )}
                    {riskVetoLogs.length > 0 ? (
                      <>
                        <h3 style={teamStyles.sectionTitle}>风控拦截记录</h3>
                        <div style={teamStyles.replayBox}>
                          {riskVetoLogs.slice(0, 8).map((v) => (
                            <div key={v.id} style={teamStyles.replayTurn}>
                              <div style={teamStyles.replayMeta}>
                                {new Date(v.createdAt).toLocaleString()} · {v.severity}
                              </div>
                              <div>{v.vetoReason}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}
                    <h3 style={teamStyles.sectionTitle}>分析报告</h3>
                    <pre style={teamStyles.report}>{result.report}</pre>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
              </div>
            </div>
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧策略栏宽度"
          onMouseDown={onTeamColGutterDown(2)}
          style={teamStyles.teamColGutter}
        />

        <aside style={{ ...teamStyles.rightRail, width: teamRightW, flexShrink: 0, alignSelf: "stretch" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7", marginBottom: 8 }}>策略与代码</div>
          <p style={{ fontSize: 11, color: "#71717a", marginBottom: 10, lineHeight: 1.45 }}>
            来自聊天会话中保存的指标/策略脚本（按当前工作流过滤）。对话内容请在「研究画布」实时流查看。
          </p>
          {!workflowSessionId.trim() ? (
            <div style={{ fontSize: 12, color: "#71717a" }}>当前工作流未关联会话，无法加载脚本。请选用从会话创建的工作流。</div>
          ) : strategyScripts.length === 0 ? (
            <div style={{ fontSize: 12, color: "#71717a" }}>暂无脚本；在 IDE 中保存策略后将出现在此。</div>
          ) : (
            <>
              <label style={{ ...teamStyles.label, marginBottom: 4 }}>选择脚本</label>
              <select
                style={{ ...teamStyles.input, width: "100%", marginBottom: 10 }}
                value={strategyScriptChoice}
                onChange={(e) => setStrategyScriptChoice(e.target.value)}
              >
                {strategyScripts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {new Date(s.updatedAt).toLocaleString()}
                  </option>
                ))}
              </select>
              {(() => {
                const s = strategyScripts.find((x) => x.id === strategyScriptChoice) ?? strategyScripts[0];
                if (!s) return null;
                return (
                  <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ fontSize: 11, color: "#a1a1aa" }}>
                      更新于 {new Date(s.updatedAt).toLocaleString()}
                      {s.workflowRunId ? ` · 关联 workflow` : ""}
                    </div>
                    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1" }}>IDE / 指标代码</div>
                      <pre
                        style={{
                          ...teamStyles.report,
                          flex: 1,
                          minHeight: 120,
                          maxHeight: "42vh",
                          overflow: "auto",
                          margin: 0,
                          fontSize: 11,
                        }}
                      >
                        {s.ideCode || "（空）"}
                      </pre>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1" }}>Python 信号 / 回测代码</div>
                      <pre
                        style={{
                          ...teamStyles.report,
                          flex: 1,
                          minHeight: 100,
                          maxHeight: "36vh",
                          overflow: "auto",
                          margin: 0,
                          fontSize: 11,
                        }}
                      >
                        {s.signalCode || "（空）"}
                      </pre>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </aside>
      </div>
      </div>
    </div>
  );
};

const teamStyles: Record<string, CSSProperties> = {
  container: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    width: "100%",
    padding: 0,
    margin: 0,
    display: "flex",
    flexDirection: "column",
  },
  teamWorkbenchShell: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    border: "1px solid #3f3f46",
    borderRadius: 10,
    overflow: "hidden",
    background: "#070708",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 12px 40px rgba(0,0,0,0.45)",
  },
  teamTriRow: {
    display: "flex",
    flexDirection: "row",
    flex: 1,
    minHeight: 0,
    alignItems: "stretch",
  },
  teamColGutter: {
    width: 6,
    flexShrink: 0,
    cursor: "col-resize",
    background: "#27272a",
    alignSelf: "stretch",
  },
  leftRail: {
    background: "#0c0c0f",
    borderRight: "1px solid #2d2d32",
    borderRadius: 0,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    alignSelf: "stretch",
    minHeight: 0,
    overflow: "auto",
  },
  centerCol: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "#0e0e12",
    borderLeft: "none",
    borderRight: "none",
  },
  ideCenterWrap: {
    display: "flex",
    flexDirection: "row",
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  teamActivityBar: {
    width: 52,
    flexShrink: 0,
    background: "#1a1a1f",
    borderRight: "1px solid #2d2d32",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "10px 0",
    gap: 6,
  },
  teamActBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    border: "1px solid transparent",
    background: "transparent",
    cursor: "pointer",
    fontSize: 0,
    lineHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#a1a1aa",
  },
  teamActBtnActive: {
    background: "#2d2d36",
    borderColor: "#7c3aed",
    color: "#f4f4f5",
  },
  teamMainStage: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "#101014",
  },
  teamEditorTitleBar: {
    height: 38,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
    borderBottom: "1px solid #2d2d32",
    fontSize: 12,
    color: "#d4d4d8",
    background: "#141418",
  },
  teamEditorBody: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: 14,
  },
  rightRail: {
    background: "#0c0c0f",
    borderLeft: "1px solid #2d2d32",
    borderRadius: 0,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  graphCanvasHost: {
    width: "100%",
    minHeight: 280,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  tabs: { display: "flex", gap: 8, marginBottom: 16 },
  tab: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #27272a",
    background: "#18181b",
    color: "#a1a1aa",
    cursor: "pointer",
    fontSize: 13,
  },
  tabActive: { background: "#27272a", color: "#e4e4e7", borderColor: "#7c3aed" },
  panel: { background: "#121216", border: "1px solid #2a2a30", borderRadius: 10, padding: 16 },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 88,
    resize: "vertical" as const,
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 6,
    color: "#e4e4e7",
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.45,
    outline: "none",
    fontFamily: "inherit",
  },
  row: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 },
  configRow: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 14 },
  field: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 160 },
  label: { fontSize: 12, color: "#a1a1aa" },
  input: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 6,
    color: "#e4e4e7",
    padding: "6px 10px",
    fontSize: 13,
    outline: "none",
  },
  btn: {
    background: "#7c3aed",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 18px",
    cursor: "pointer",
    fontSize: 13,
    whiteSpace: "nowrap",
  },
  btnDisabled: { opacity: 0.5, cursor: "not-allowed" },
  buttonSecondary: {
    border: "1px solid #3f3f46",
    color: "#e4e4e7",
    background: "#18181b",
    borderRadius: 6,
    padding: "8px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  error: {
    background: "#3f1d1d",
    border: "1px solid #7f1d1d",
    color: "#fca5a5",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 12,
    marginBottom: 10,
  },
  resultBox: { marginTop: 12 },
  heroBox: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: "12px 16px",
    marginBottom: 16,
  },
  heroBadge: { fontSize: 28, fontWeight: 700 },
  heroMeta: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "#a1a1aa" },
  debateTag: {
    background: "#78350f",
    color: "#fde68a",
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: 12,
    width: "fit-content",
  },
  sectionTitle: { color: "#e4e4e7", fontSize: 14, marginBottom: 10 },
  debateBox: {
    background: "#1a1424",
    border: "1px solid #3b2b63",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    color: "#ddd6fe",
    fontSize: 12,
    display: "grid",
    gap: 6,
  },
  debateReason: { color: "#a78bfa" },
  riskBox: {
    border: "1px solid",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    color: "#e4e4e7",
    fontSize: 12,
    display: "grid",
    gap: 6,
  },
  replayBox: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    display: "grid",
    gap: 8,
    maxHeight: 260,
    overflow: "auto",
  },
  replayTurn: {
    borderBottom: "1px dashed #3f3f46",
    paddingBottom: 6,
  },
  replayMeta: { fontSize: 11, color: "#a1a1aa", marginBottom: 4 },
  replayVerdict: {
    background: "#1a1424",
    border: "1px solid #3b2b63",
    borderRadius: 6,
    padding: 8,
    color: "#ddd6fe",
    fontSize: 12,
  },
  trendBox: {
    border: "1px solid #27272a",
    borderRadius: 8,
    background: "#18181b",
    padding: 10,
    marginBottom: 16,
  },
  trendTitle: {
    color: "#e4e4e7",
    fontSize: 12,
    marginBottom: 8,
  },
  screenerBox: {
    display: "grid",
    gridTemplateColumns: "260px 1fr",
    gap: 10,
    marginBottom: 16,
  },
  screenerRunList: {
    border: "1px solid #27272a",
    borderRadius: 8,
    background: "#18181b",
    padding: 8,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxHeight: 220,
    overflow: "auto",
  },
  screenerRunBtn: {
    border: "1px solid #3f3f46",
    borderRadius: 6,
    background: "#111114",
    color: "#d4d4d8",
    textAlign: "left",
    padding: "6px 8px",
    cursor: "pointer",
    fontSize: 12,
  },
  screenerRunBtnActive: {
    borderColor: "#7c3aed",
    background: "#221838",
  },
  screenerCandidates: {
    border: "1px solid #27272a",
    borderRadius: 8,
    background: "#18181b",
    padding: 8,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 8,
    maxHeight: 280,
    overflow: "auto",
  },
  screenerCard: {
    border: "1px solid #3f3f46",
    borderRadius: 8,
    background: "#111114",
    padding: 8,
    fontSize: 12,
    color: "#e4e4e7",
  },
  screenerHead: {
    display: "flex",
    justifyContent: "space-between",
    marginBottom: 6,
    fontSize: 12,
  },
  screenerBreakdown: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    color: "#a1a1aa",
    marginTop: 4,
    fontSize: 11,
  },
  radarGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 },
  radarCard: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  radarRole: { fontSize: 12, color: "#a1a1aa" },
  radarSignal: { fontSize: 18, fontWeight: 700 },
  radarBar: {
    height: 4,
    background: "#27272a",
    borderRadius: 2,
    overflow: "hidden",
  },
  radarFill: { height: "100%", borderRadius: 2, transition: "width 0.4s" },
  radarConf: { fontSize: 11, color: "#71717a" },
  report: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 12,
    fontSize: 12,
    color: "#d4d4d8",
    whiteSpace: "pre-wrap",
    maxHeight: 300,
    overflow: "auto",
  },
  groupBlock: { marginBottom: 16 },
  groupTitle: { fontSize: 14, fontWeight: 600, marginBottom: 8 },
  memberGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 },
  memberCard: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  memberRole: { fontSize: 13, color: "#e4e4e7", fontWeight: 500 },
  memberDesc: { fontSize: 11, color: "#71717a" },
  memberTag: {
    fontSize: 10,
    color: "#52525b",
    fontFamily: "monospace",
    background: "#27272a",
    borderRadius: 3,
    padding: "1px 5px",
    width: "fit-content",
  },
  memberEmpty: { color: "#52525b", fontSize: 12 },
  empty: { color: "#52525b", fontSize: 13, textAlign: "center", padding: 30 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    padding: "6px 10px",
    borderBottom: "1px solid #27272a",
    fontSize: 12,
    color: "#71717a",
  },
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid #1e1e21",
    fontSize: 12,
    color: "#d4d4d8",
  },
};
