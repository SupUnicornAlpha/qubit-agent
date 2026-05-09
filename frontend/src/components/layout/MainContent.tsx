import type { CSSProperties, FC, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  chatHealth,
  checkBrokerHealth,
  createEvalDataset,
  createAgentDraft,
  createChatSession,
  createProject,
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
  initGenePool,
  getRiskConfig,
  getRiskVetoLogs,
  listGeneGenerations,
  listGeneTrends,
  listGenomes,
  listScreenerCandidates,
  listScreenerRuns,
  getModelConfig,
  getIntentExecutionView,
  getSessionAgentsBoard,
  getEvalRunDetail,
  getWorkflowDetail,
  listBrokerAccounts,
  listBrokerEvents,
  listMcpBindings,
  listMcpServers,
  listAgentDefinitions,
  listAgents,
  listAgentQuality,
  listAlerts,
  listChatSessions,
  listEvalDatasets,
  listEvalRuns,
  listWorkflowQuality,
  listMonitorWorkflows,
  listIntegrationChannels,
  listIntegrationLogs,
  listIntentOrders,
  listProjects,
  listSessionMessages,
  listWorkspaces,
  patchSessionMessage,
  releaseAgentDraft,
  reloadAgents,
  processWorkflowCompensations,
  evolveGenePool,
  runAnalystTeam,
  runScreener,
  executeIntentConfirmed,
  saveModelConfig,
  saveDebateConfig,
  saveExecutionSafetyConfig,
  saveRiskConfig,
  testMcpCall,
  upsertBrokerAccount,
  upsertIntegrationChannel,
  upsertMcpBinding,
  requestExecutionConfirmation,
  resolveAlert,
  runEval,
  subscribeDebateStream,
  subscribeWorkflowStream,
  triggerWorkflowAlerts,
  createWorkflowQuality,
  listWorkflowCompensations,
  enqueueWorkflowCompensation,
} from "../../api/backend";
import type {
  AgentDefinitionBundle,
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
  McpToolBindingRecord,
  ScreenerCandidateRecord,
  ScreenerRunRecord,
  SessionAgentBoardItem,
  AlertEventRecord,
  AgentRuntimeMetricRecord,
  BrokerAccountRecord,
  BrokerOrderEventRecord,
  CommunicationChannelRecord,
  CommunicationMessageLogRecord,
  WorkflowCompensationTaskRecord,
  SignalFusionRecord,
  StrategyGenomeRecord,
  StepStreamEvent,
  WorkflowQualitySnapshotRecord,
  WorkflowMode,
} from "../../api/types";
import { useAppStore } from "../../store";

export const MainContent: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  if (activeView === "chat") {
    return (
      <main style={styles.main}>
        <ChatPanel />
      </main>
    );
  }
  if (activeView === "team") {
    return (
      <main style={styles.main}>
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

      <h3 style={styles.subTitle}>运行质量（M9-F1）</h3>
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

      <h3 style={styles.subTitle}>告警中心（M9-B2）</h3>
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

      <h3 style={styles.subTitle}>评测报告（M10-F1）</h3>
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

const ChatPanel: FC = () => {
  const chatSessions = useAppStore((s) => s.chatSessions);
  const setChatSessions = useAppStore((s) => s.setChatSessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const pushStreamEvent = useAppStore((s) => s.pushStreamEvent);

  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [input, setInput] = useState("");
  const [errorText, setErrorText] = useState("");
  const [agentsBoard, setAgentsBoard] = useState<SessionAgentBoardItem[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

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
    const unsubscribe = subscribeWorkflowStream({
      workflowId,
      runId,
      onEvent: (event: StepStreamEvent) => {
        pushStreamEvent(event);
        if (event.type === "token") {
          const piece = String(event.payload.token ?? event.payload.text ?? "");
          buffer += piece;
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: buffer,
            status: "running",
          });
          setChatMessages((prev) =>
            prev.map((m) => (m.id === assistantMessageId ? { ...m, content: buffer, status: "running" } : m))
          );
        }
        if (event.type === "final") {
          const finalText = String((event.payload.finalResponse ?? buffer) || "完成");
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: finalText,
            status: "completed",
          });
          setRefreshKey((v) => v + 1);
          unsubscribe();
        }
        if (event.type === "error") {
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: buffer || "执行失败",
            status: "failed",
            errorMessage: String(event.payload.error ?? "unknown error"),
          });
          setRefreshKey((v) => v + 1);
          unsubscribe();
        }
      },
      onError: () => unsubscribe(),
    });
  };

  const onSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedSessionId || !projectId || !input.trim()) return;
    try {
      const userMsg = await createSessionMessage({
        sessionId: selectedSessionId,
        role: "user",
        sender: "user",
        content: input.trim(),
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
        goal: input.trim(),
        mode: "research",
        sessionId: selectedSessionId,
        source: "chat",
        messageId: userMsg.id,
      });
      await patchSessionMessage({
        messageId: assistantMsg.id,
        workflowRunIds: [created.data.id],
      });
      bindStream(created.data.id, created.runId, assistantMsg.id);
      setChatMessages(await listSessionMessages(selectedSessionId));
      setInput("");
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "发送失败");
    }
  };

  return (
    <>
      <h2 style={styles.title}>对话工作台</h2>
      {errorText ? <div style={styles.errorBox}>{errorText}</div> : null}
      <div style={styles.chatLayout}>
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
                <div>{msg.content || "(流式生成中...)"}</div>
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
        </div>
      </div>
    </>
  );
};

const ConfigPanel: FC = () => {
  const configData = useAppStore((s) => s.configData);
  const setConfigData = useAppStore((s) => s.setConfigData);
  const reloadSummary = useAppStore((s) => s.reloadSummary);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
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
  const [mcpServers, setMcpServers] = useState<McpServerConfigRecord[]>([]);
  const [mcpBindings, setMcpBindings] = useState<McpToolBindingRecord[]>([]);
  const [selectedMcpServer, setSelectedMcpServer] = useState("");
  const [mcpToolName, setMcpToolName] = useState("");
  const [mcpTimeoutMs, setMcpTimeoutMs] = useState(20000);
  const [mcpTestOutput, setMcpTestOutput] = useState("");
  const [integrationKind, setIntegrationKind] = useState<"telegram" | "webhook">("telegram");
  const [integrationName, setIntegrationName] = useState("default-telegram");
  const [integrationExternalChatId, setIntegrationExternalChatId] = useState("");
  const [integrationSecretRef, setIntegrationSecretRef] = useState("");
  const [integrationChannels, setIntegrationChannels] = useState<CommunicationChannelRecord[]>([]);
  const [integrationLogs, setIntegrationLogs] = useState<CommunicationMessageLogRecord[]>([]);

  const loadConfig = async () => {
    const [data, bundles, servers, bindings, channels, logs] = await Promise.all([
      getAgentsConfig(),
      listAgentDefinitions(),
      listMcpServers(),
      listMcpBindings(),
      listIntegrationChannels(),
      listIntegrationLogs(undefined, 50),
    ]);
    setConfigData(data);
    setDefinitions(bundles);
    setMcpServers(servers);
    setMcpBindings(bindings);
    setIntegrationChannels(channels);
    setIntegrationLogs(logs);
    if (!selectedMcpServer && servers[0]) {
      setSelectedMcpServer(servers[0].name);
    }
    if (!selectedDefinitionId && bundles[0]) {
      setSelectedDefinitionId(bundles[0].definition.id);
      setDraftPrompt(bundles[0].draft?.systemPrompt ?? bundles[0].definition.systemPrompt);
      setDraftSoul(bundles[0].profile?.soulFileRef ?? "");
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
  }, []);

  const selectedBundle = useMemo(
    () => definitions.find((item) => item.definition.id === selectedDefinitionId) ?? null,
    [definitions, selectedDefinitionId]
  );

  const saveMcpBindingNow = async () => {
    if (!selectedMcpServer || !mcpToolName.trim()) return;
    const row = await upsertMcpBinding({
      serverName: selectedMcpServer,
      toolName: mcpToolName.trim(),
      enabled: true,
      timeoutMs: mcpTimeoutMs,
      retryPolicyJson: { maxAttempts: 2, backoffMs: 300 },
      rateLimitJson: {},
    });
    setMcpTestOutput(`binding saved: ${row.serverName}/${row.toolName}`);
    setMcpBindings(await listMcpBindings());
  };

  const testMcpNow = async () => {
    if (!selectedMcpServer || !mcpToolName.trim()) return;
    const out = await testMcpCall({
      serverName: selectedMcpServer,
      toolName: mcpToolName.trim(),
      arguments: { ping: true, ts: Date.now() },
    });
    setMcpTestOutput(JSON.stringify(out, null, 2));
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
      <h3 style={styles.subTitle}>模型配置</h3>
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
          保存模型配置
        </button>
      </div>
      <h3 style={styles.subTitle}>MCP 配置与连通性</h3>
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
      <pre style={styles.streamBox}>{mcpTestOutput || "暂无测试结果"}</pre>
      <pre style={styles.streamBox}>{JSON.stringify(mcpBindings, null, 2)}</pre>
      <h3 style={styles.subTitle}>集成管理（T9）</h3>
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
      {reloadSummary ? (
        <div style={styles.meta}>
          <span>reload before: {reloadSummary.before}</span>
          <span>reload after: {reloadSummary.after}</span>
        </div>
      ) : null}
    </>
  );
};

const styles: Record<string, CSSProperties> = {
  main: { flex: 1, overflow: "auto", padding: 24 },
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
  },
  chatMessages: { flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 },
  chatBubble: { padding: "8px 10px", borderRadius: 8, border: "1px solid #27272a" },
  chatBubbleUser: { background: "#27272a", alignSelf: "flex-end", maxWidth: "82%" },
  chatBubbleAgent: { background: "#18181b", alignSelf: "flex-start", maxWidth: "90%" },
  chatMeta: { fontSize: 11, color: "#a1a1aa", marginBottom: 4 },
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

const TEAM_GROUPS = [
  { key: "analyst", label: "分析师团队", color: "#3b82f6" },
  { key: "researcher", label: "研究员团队", color: "#8b5cf6" },
  { key: "risk", label: "风控团队", color: "#ef4444" },
  { key: "portfolio", label: "组合管理", color: "#f59e0b" },
  { key: "execution", label: "执行团队", color: "#10b981" },
  { key: "ops", label: "运营支持", color: "#6b7280" },
];

const TeamDashboardPanel: FC = () => {
  const [roles, setRoles] = useState<AgentRoleCatalogItem[]>([]);
  const [ticker, setTicker] = useState("AAPL");
  const [workflowRunId, setWorkflowRunId] = useState("");
  const [workflowOptions, setWorkflowOptions] = useState<Array<Record<string, unknown>>>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalystTeamResult | null>(null);
  const [history, setHistory] = useState<SignalFusionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"run" | "roles" | "history">("run");
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


  useEffect(() => {
    void (async () => {
      getAgentRoles().then(setRoles).catch(() => {});
      getFusionHistory({ limit: 10 }).then(setHistory).catch(() => {});
      getDebateConfig().then(setDebateConfigState).catch(() => {});
      getRiskConfig().then(setRiskConfigState).catch(() => {});
      getExecutionSafetyConfig().then(setExecutionSafetyConfigState).catch(() => {});
      const wfRows = (await listMonitorWorkflows({})) as Array<Record<string, unknown>>;
      setWorkflowOptions(wfRows);
      if (!workflowRunId && wfRows[0]?.id) {
        setWorkflowRunId(String(wfRows[0].id));
      }
      await refreshBrokerAndComp();
    })().catch(() => {});
  }, []);

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

  const handleRun = async () => {
    if (!ticker.trim()) return;
    setError(null);
    setRunning(true);
    setResult(null);
    setLiveDebateEvents([]);
    setReplayTurns([]);
    setReplayVerdict(null);
    try {
      const wfId = workflowRunId;
      if (!wfId) {
        setError("请先选择 workflowRunId（可在下拉框直接选取最近工作流）");
        setRunning(false);
        return;
      }
      const unsubscribe = subscribeDebateStream({
        workflowRunId: wfId,
        onEvent: (event) => {
          setLiveDebateEvents((prev) => [...prev.slice(-49), event]);
        },
        onError: () => {},
      });
      const res = await runAnalystTeam({ workflowRunId: wfId, ticker: ticker.trim() });
      unsubscribe();
      setResult(res);
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

  const loadScreenerRun = async (runId: string) => {
    setSelectedScreenerRunId(runId);
    const candidates = await listScreenerCandidates(runId);
    setScreenerCandidates(candidates);
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

  const loadGeneration = async (generationId: string) => {
    setSelectedGenerationId(generationId);
    const rows = await listGenomes(generationId);
    setGenomes(rows);
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

  const groupedRoles = TEAM_GROUPS.map((g) => ({
    ...g,
    members: roles.filter((r) => r.team === g.key),
  }));

  return (
    <div style={teamStyles.container}>
      <h2 style={teamStyles.title}>🧑‍💼 量化研究团队仪表盘</h2>

      {/* Tabs */}
      <div style={teamStyles.tabs}>
        {(["run", "roles", "history"] as const).map((t) => (
          <button
            key={t}
            type="button"
            style={{ ...teamStyles.tab, ...(activeTab === t ? teamStyles.tabActive : {}) }}
            onClick={() => setActiveTab(t)}
          >
            {t === "run" ? "🚀 发起分析" : t === "roles" ? "👥 团队成员" : "📊 历史信号"}
          </button>
        ))}
      </div>

      {/* Run Panel */}
      {activeTab === "run" && (
        <div style={teamStyles.panel}>
          <div style={teamStyles.row}>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>标的代码</label>
              <input
                style={teamStyles.input}
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder="e.g. AAPL / 600519"
              />
            </div>
            <div style={teamStyles.field}>
              <label style={teamStyles.label}>工作流 ID（选择器联动）</label>
              <select style={teamStyles.input} value={workflowRunId} onChange={(e) => setWorkflowRunId(e.target.value)}>
                <option value="">请选择 workflow</option>
                {workflowOptions.slice(0, 80).map((row) => (
                  <option key={String(row.id)} value={String(row.id)}>
                    {String(row.id)} · {String(row.status)} · {String(row.mode)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              style={{ ...teamStyles.btn, ...(running ? teamStyles.btnDisabled : {}) }}
              onClick={handleRun}
              disabled={running}
            >
              {running ? "分析中..." : "启动团队分析"}
            </button>
          </div>

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

          {error && <div style={teamStyles.error}>{error}</div>}

          {result && (
            <div style={teamStyles.resultBox}>
              {/* Fused Signal Hero */}
              <div style={teamStyles.heroBox}>
                <span style={{ ...teamStyles.heroBadge, color: SIGNAL_COLOR[result.fusedSignal] }}>
                  {result.fusedSignal.toUpperCase()}
                </span>
                <div style={teamStyles.heroMeta}>
                  <span>置信度：{(result.fusedConfidence * 100).toFixed(0)}%</span>
                  {result.debateTriggered && (
                    <span style={teamStyles.debateTag}>⚠️ 建议触发辩论</span>
                  )}
                </div>
              </div>

              {/* MSA Radar (简版：文字+条形) */}
              <h3 style={teamStyles.sectionTitle}>📡 多信号融合 (MSA)</h3>
              <div style={teamStyles.radarGrid}>
                {result.breakdown.map((b) => (
                  <div key={b.role} style={teamStyles.radarCard}>
                    <div style={teamStyles.radarRole}>{ROLE_DISPLAY[b.role] ?? b.role}</div>
                    <div
                      style={{
                        ...teamStyles.radarSignal,
                        color: SIGNAL_COLOR[b.signal],
                      }}
                    >
                      {b.signal.toUpperCase()}
                    </div>
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

              {result.debate && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🗳️ 辩论裁决 (SDP)</h3>
                  <div style={teamStyles.debateBox}>
                    <div>会话：`{result.debate.sessionId}`</div>
                    <div>裁决：{result.debate.verdict}</div>
                    <div>最终立场：{result.debate.finalStance.toUpperCase()}</div>
                    <div>共识得分：{(result.debate.consensusScore * 100).toFixed(0)}%</div>
                    <div style={teamStyles.debateReason}>{result.debate.reasoning}</div>
                  </div>
                </>
              )}

              {result.risk && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🛡️ 风控裁决 (RFV)</h3>
                  <div
                    style={{
                      ...teamStyles.riskBox,
                      borderColor: result.risk.vetoed ? "#7f1d1d" : "#14532d",
                      background: result.risk.vetoed ? "#3f1d1d" : "#052e16",
                    }}
                  >
                    <div>
                      状态：{result.risk.vetoed ? "❌ 已拦截（VETO）" : "✅ 通过"} · 严重级别：{result.risk.severity}
                    </div>
                    <div>风险分：{(result.risk.riskScore * 100).toFixed(0)}%</div>
                    <div>{result.risk.reason}</div>
                    <div>触发规则：{result.risk.rulesTriggered.length ? result.risk.rulesTriggered.join(", ") : "无"}</div>
                  </div>
                </>
              )}

              {(screenerRuns.length > 0 || screenerCandidates.length > 0) && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🎯 选股结果（Screener）</h3>
                  <div style={teamStyles.screenerBox}>
                    <div style={teamStyles.screenerRunList}>
                      {screenerRuns.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          style={{
                            ...teamStyles.screenerRunBtn,
                            ...(selectedScreenerRunId === r.id ? teamStyles.screenerRunBtnActive : {}),
                          }}
                          onClick={() => void loadScreenerRun(r.id)}
                        >
                          {new Date(r.createdAt).toLocaleTimeString()} · {r.universe} · {r.candidateCount} 个
                        </button>
                      ))}
                    </div>
                    <div style={teamStyles.screenerCandidates}>
                      {screenerCandidates.map((c) => (
                        <div key={c.id} style={teamStyles.screenerCard}>
                          <div style={teamStyles.screenerHead}>
                            <strong>{c.ticker}</strong> <span>{c.companyName}</span>
                          </div>
                          <div>综合分：{(c.score * 100).toFixed(1)}</div>
                          <div style={teamStyles.screenerBreakdown}>
                            {Object.entries(c.scoreBreakdownJson ?? {}).map(([k, v]) => (
                              <span key={k}>{k}:{(Number(v) * 100).toFixed(0)}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                      {screenerCandidates.length === 0 && <div style={teamStyles.memberEmpty}>暂无候选</div>}
                    </div>
                  </div>
                </>
              )}

              {(geneGenerations.length > 0 || genomes.length > 0) && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🧬 策略基因池（SGP）</h3>
                  <div style={teamStyles.screenerBox}>
                    <div style={teamStyles.screenerRunList}>
                      {geneGenerations.map((g) => (
                        <button
                          key={g.id}
                          type="button"
                          style={{
                            ...teamStyles.screenerRunBtn,
                            ...(selectedGenerationId === g.id ? teamStyles.screenerRunBtnActive : {}),
                          }}
                          onClick={() => void loadGeneration(g.id)}
                        >
                          Gen {g.generationNumber} · bestSharpe {g.bestSharpe?.toFixed(2) ?? "-"} · pop {g.populationSize}
                        </button>
                      ))}
                    </div>
                    <div style={teamStyles.screenerCandidates}>
                      {genomes.map((gm) => (
                        <div key={gm.id} style={teamStyles.screenerCard}>
                          <div style={teamStyles.screenerHead}>
                            <strong>{gm.name}</strong> <span>{gm.isActive ? "active" : "idle"}</span>
                          </div>
                          <div>Sharpe: {gm.sharpeRatio?.toFixed(2) ?? "-"}</div>
                          <div>Drawdown: {gm.maxDrawdown?.toFixed(2) ?? "-"}</div>
                          <div>Return: {gm.totalReturn?.toFixed(2) ?? "-"}</div>
                          <div style={teamStyles.screenerBreakdown}>
                            {Object.entries(gm.genesSnapshotJson ?? {}).map(([k, v]) => (
                              <span key={k}>{k}:{Number(v).toFixed(2)}</span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {geneTrends.length > 0 && (
                    <div style={teamStyles.trendBox}>
                      <div style={teamStyles.trendTitle}>世代趋势（Best Sharpe / Avg Drawdown）</div>
                      <table style={teamStyles.table}>
                        <thead>
                          <tr>
                            <th style={teamStyles.th}>Generation</th>
                            <th style={teamStyles.th}>Best Sharpe</th>
                            <th style={teamStyles.th}>Avg Sharpe</th>
                            <th style={teamStyles.th}>Avg Drawdown</th>
                          </tr>
                        </thead>
                        <tbody>
                          {geneTrends.map((t) => (
                            <tr key={t.generationId}>
                              <td style={teamStyles.td}>Gen {t.generationNumber}</td>
                              <td style={teamStyles.td}>{t.bestSharpe?.toFixed(2) ?? "-"}</td>
                              <td style={teamStyles.td}>{t.avgSharpe?.toFixed(2) ?? "-"}</td>
                              <td style={teamStyles.td}>{t.avgDrawdown?.toFixed(2) ?? "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

              {(intentOrders.length > 0 || intentView) && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🧾 意图 vs 实际执行（REIA）</h3>
                  <div style={teamStyles.screenerBox}>
                    <div style={teamStyles.screenerRunList}>
                      {intentOrders.map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          style={{
                            ...teamStyles.screenerRunBtn,
                            ...(selectedIntentId === it.id ? teamStyles.screenerRunBtnActive : {}),
                          }}
                          onClick={() => void loadIntentView(it.id)}
                        >
                          {it.ticker} · {it.direction} · qty {it.quantity} · {it.status}
                        </button>
                      ))}
                    </div>
                    <div style={teamStyles.replayBox}>
                      {intentView?.intent && (
                        <div style={teamStyles.replayVerdict}>
                          <strong>Intent</strong>
                          <br />
                          {intentView.intent.ticker} {intentView.intent.direction} qty {intentView.intent.quantity} @
                          {intentView.intent.targetPrice}
                        </div>
                      )}
                      {intentView?.report && (
                        <div style={teamStyles.replayVerdict}>
                          <strong>Execution</strong>
                          <br />
                          actual {intentView.report.actualQuantity} @ {intentView.report.actualPrice} · slippage{" "}
                          {intentView.report.slippage.toFixed(4)} · {intentView.report.executionTimeMs}ms
                        </div>
                      )}
                      {intentView?.deviation && (
                        <div
                          style={{
                            ...teamStyles.replayVerdict,
                            borderColor: intentView.deviation.exceededThreshold ? "#7f1d1d" : "#14532d",
                          }}
                        >
                          <strong>Deviation</strong>
                          <br />
                          price {(intentView.deviation.priceDeviationPct * 100).toFixed(2)}% · qty{" "}
                          {(intentView.deviation.quantityDeviationPct * 100).toFixed(2)}% · exceeded{" "}
                          {intentView.deviation.exceededThreshold ? "YES" : "NO"}
                        </div>
                      )}
                      {lastSafetyCheck && (
                        <div style={teamStyles.replayVerdict}>
                          <strong>Safety Check</strong>
                          <br />
                          risk {(lastSafetyCheck.finalRiskScore * 100).toFixed(1)}% · blockers{" "}
                          {lastSafetyCheck.blockers.length ? lastSafetyCheck.blockers.join(", ") : "none"}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {(brokerAccounts.length > 0 || brokerEvents.length > 0 || compTasks.length > 0) && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🔌 Broker / 补偿队列（T1/T4）</h3>
                  <div style={teamStyles.replayBox}>
                    <div style={teamStyles.replayVerdict}>
                      <strong>Broker Accounts</strong>
                      <br />
                      {brokerAccounts
                        .slice(0, 10)
                        .map((a) => `${a.provider}:${a.accountRef} ${a.mode} ${a.healthStatus}`)
                        .join("\n") || "none"}
                    </div>
                    <div style={teamStyles.replayVerdict}>
                      <strong>Broker Events</strong>
                      <br />
                      {brokerEvents
                        .slice(0, 10)
                        .map((e) => `${e.provider}:${e.eventType} ${e.status} ${e.intentOrderId ?? "-"}`)
                        .join("\n") || "none"}
                    </div>
                    <div style={teamStyles.replayVerdict}>
                      <strong>Compensation Tasks</strong>
                      <br />
                      {compTasks
                        .slice(0, 10)
                        .map((t) => `${t.workflowRunId} ${t.actionType} ${t.status} retry ${t.retryCount}/${t.maxRetries}`)
                        .join("\n") || "none"}
                    </div>
                  </div>
                </>
              )}

              {riskVetoLogs.length > 0 && (
                <>
                  <h3 style={teamStyles.sectionTitle}>📕 风控拦截回放</h3>
                  <div style={teamStyles.replayBox}>
                    {riskVetoLogs.map((v) => (
                      <div key={v.id} style={teamStyles.replayTurn}>
                        <div style={teamStyles.replayMeta}>
                          {new Date(v.createdAt).toLocaleString()} · {v.severity.toUpperCase()} ·{" "}
                          {(v.riskScore * 100).toFixed(0)}%
                        </div>
                        <div>{v.vetoReason}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <h3 style={teamStyles.sectionTitle}>📡 实时辩论事件流</h3>
              <pre style={teamStyles.report}>
                {liveDebateEvents.length
                  ? liveDebateEvents
                      .map((e) => `${new Date(e.ts).toLocaleTimeString()} [${e.type}] ${JSON.stringify(e.payload)}`)
                      .join("\n")
                  : "暂无实时辩论事件"}
              </pre>

              {(replayTurns.length > 0 || replayVerdict) && (
                <>
                  <h3 style={teamStyles.sectionTitle}>🎬 辩论回放</h3>
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
                    {replayVerdict && (
                      <div style={teamStyles.replayVerdict}>
                        裁决：{replayVerdict.finalStance.toUpperCase()} · 共识度{" "}
                        {(replayVerdict.consensusScore * 100).toFixed(0)}%
                        <br />
                        {replayVerdict.reasoning}
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Report */}
              <h3 style={teamStyles.sectionTitle}>📝 分析报告</h3>
              <pre style={teamStyles.report}>{result.report}</pre>
            </div>
          )}
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
    </div>
  );
};

const teamStyles: Record<string, CSSProperties> = {
  container: { padding: 20, maxWidth: 960, margin: "0 auto" },
  title: { color: "#e4e4e7", fontSize: 20, marginBottom: 16 },
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
  panel: { background: "#111114", border: "1px solid #27272a", borderRadius: 10, padding: 16 },
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
