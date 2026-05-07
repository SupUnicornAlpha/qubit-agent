import type { CSSProperties, FC, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  chatHealth,
  createAgentDraft,
  createChatSession,
  createProject,
  createSessionMessage,
  createWorkflow,
  createWorkspace,
  getAgentsConfig,
  getAgentRoles,
  getDefaultProjectSession,
  getFusionHistory,
  getModelConfig,
  getSessionAgentsBoard,
  getWorkflowDetail,
  listAgentDefinitions,
  listAgents,
  listChatSessions,
  listMonitorWorkflows,
  listProjects,
  listSessionMessages,
  listWorkspaces,
  patchSessionMessage,
  releaseAgentDraft,
  reloadAgents,
  runAnalystTeam,
  saveModelConfig,
  subscribeWorkflowStream,
} from "../../api/backend";
import type {
  AgentDefinitionBundle,
  AgentRoleCatalogItem,
  AnalystTeamResult,
  SessionAgentBoardItem,
  SignalFusionRecord,
  StepStreamEvent,
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

  const loadConfig = async () => {
    const [data, bundles] = await Promise.all([getAgentsConfig(), listAgentDefinitions()]);
    setConfigData(data);
    setDefinitions(bundles);
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
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalystTeamResult | null>(null);
  const [history, setHistory] = useState<SignalFusionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"run" | "roles" | "history">("run");


  useEffect(() => {
    getAgentRoles().then(setRoles).catch(() => {});
    getFusionHistory({ limit: 10 }).then(setHistory).catch(() => {});
  }, []);

  const handleRun = async () => {
    if (!ticker.trim()) return;
    setError(null);
    setRunning(true);
    setResult(null);
    try {
      // Need a workflow run ID — create a minimal one
      let wfId = workflowRunId;
      if (!wfId) {
        // Try to find default project from store
        setError("请先填写 workflowRunId，或在对话工作台触发一次研究任务后，在此处填入对应的工作流 ID");
        setRunning(false);
        return;
      }
      const res = await runAnalystTeam({ workflowRunId: wfId, ticker: ticker.trim() });
      setResult(res);
      const newHistory = await getFusionHistory({ limit: 10 });
      setHistory(newHistory);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
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
              <label style={teamStyles.label}>工作流 ID（必填）</label>
              <input
                style={teamStyles.input}
                value={workflowRunId}
                onChange={(e) => setWorkflowRunId(e.target.value)}
                placeholder="从监控页复制 workflow run id"
              />
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
