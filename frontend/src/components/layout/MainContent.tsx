import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { Loader2, Network, Rocket, Users, type LucideIcon } from "lucide-react";
import {
  chatHealth,
  checkBrokerHealth,
  createChatSession,
  createProject,
  createSessionMessage,
  createIntentOrder,
  createWorkflow,
  createWorkspace,
  getAgentsConfig,
  getDebateConfig,
  getDebateTurns,
  getDebateVerdict,
  getDefaultProjectSession,
  getExecutionSafetyConfig,
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
  listBrokerAccounts,
  listBrokerEvents,
  listMcpBindings,
  listMcpMarketCatalog,
  listMcpProjectInstalls,
  listMcpSources,
  listMcpServers,
  appendAgentDraftSkills,
  deleteChatSession,
  deleteSkillMarketInstall,
  deleteWorkflow,
  getSkillMarketStatus,
  installManualSkill,
  installSkillFromMarket,
  listSkillLibrary,
  listSkillMarketInstalls,
  patchAgentSkill,
  listAgentDefinitions,
  refreshSkillMarketRegistry,
  searchSkillMarket,
  getAgentDefinitionMemoryStats,
  getAgentDefinitionPack,
  listAgentGroups,
  listChatSessions,
  listMonitorWorkflows,
  listStrategyScripts,
  getWorkflowArtifacts,
  saveWorkflowReportArtifact,
  listIntentOrders,
  listProjects,
  listSessionMessages,
  listWorkspaces,
  createStrategyScript,
  patchSessionMessage,
  patchWorkflow,
  reloadAgents,
  processWorkflowCompensations,
  evolveGenePool,
  runAnalystTeam,
  AnalystJobPollError,
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
  upsertMcpBinding,
  upsertMcpSource,
  upsertMcpServer,
  requestExecutionConfirmation,
  subscribeDebateStream,
  approveWorkflowHitl,
  listPendingWorkflowHitl,
  rejectWorkflowHitl,
  subscribeWorkflowStream,
  listWorkflowCompensations,
  enqueueWorkflowCompensation,
  installMcpMarket,
  syncMcpSource,
  uninstallMcpProjectInstall,
} from "../../api/backend";
import type {
  AgentDefinitionBundle,
  AgentDefinitionRecord,
  AgentMemoryStatsResponse,
  AgentPackResponse,
  AgentGroupRecord,
  AgentSkillRecord,
  AnalystTeamResult,
  DebateConfig,
  DebateStreamEvent,
  DebateTurnRecord,
  DebateVerdictRecord,
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
  OpenSkillMarketEntryDto,
  SkillMarketInstallRecord,
  SkillMarketStatusDto,
  ScreenerCandidateRecord,
  ScreenerRunRecord,
  SessionAgentBoardItem,
  SessionA2AMessageItem,
  BrokerAccountRecord,
  BrokerOrderEventRecord,
  WorkflowCompensationTaskRecord,
  AnalystTeamGraphPayload,
  AnalystTeamGraphInteraction,
  AnalystTeamGraphAgentStep,
  AnalystTeamGraphToolCall,
  AnalystTeamGraphMcpCall,
  StrategyGenomeRecord,
  StepStreamEvent,
  BuiltinConnectorConfig,
  IndicatorStrategyScriptRecord,
  AgentLoopKind,
} from "../../api/types";
import { groupStreamEventsByRun } from "../../lib/groupStreamEventsByRun";
import { RESEARCH_TEAM_SLOT_ROLE_SET } from "../../lib/researchTeamRoles";
import { useAppStore, type ChartContextPayload } from "../../store";
import { MarkdownBubble } from "../chat/MarkdownBubble";
import { StreamTimelineGroupCard } from "../chat/StreamTimelineGroupCard";
import {
  clearChatStreamBinding,
  hydrateStaleChatMessages,
  persistChatStreamBinding,
  reconnectActiveChatStreams,
  buildFinalAssistantText,
  messageStatusFromFinalPayload,
  stripToolCallSentinels,
} from "../../lib/chatMessageHydration";
import { KlinePanel } from "../chart/KlinePanel";
import { IdeResearchWorkbench } from "../ide/IdeResearchWorkbench";
import { TeamAgentGraph, teamGraphUndirectedKey, type TeamGraphActivity, type TeamGraphSelection } from "../ide/TeamAgentGraph";
import { TeamAgentPixelOffice } from "../team/TeamAgentPixelOffice";
import { formatEdgeSelectionSummary, isToolGraphEdge } from "../../lib/teamGraphEdgeVisual";
import {
  buildResearchScopePayload,
  instrumentLabel,
  scopeModeLabel,
  type ResearchInstrumentUi,
  type ResearchScopeMode,
} from "../../lib/researchScope";
import {
  buildFilteredTeamGraphDisplay,
  filterInteractionsForEdge,
} from "../../lib/teamGraphDisplay";
import { BrokerAccountsPanel } from "../broker/BrokerAccountsPanel";
import { MonitorDashboard } from "../monitor/MonitorDashboard";
import { TraderLivePanel } from "../trader/TraderLivePanel";
import { agentDisplayLabel } from "../../lib/agentDisplay";
import { ConfigAgentPanel, parseAgentMcpServerNames, type AgentConfigUiTab } from "../config/ConfigAgentPanel";
import { IntegrationCenterPanel } from "../config/IntegrationCenterPanel";
import { ScheduledJobsPanel } from "../config/ScheduledJobsPanel";
import { ProvidersPanel } from "../config/ProvidersPanel";
import { LlmProvidersList } from "../config/LlmProvidersList";
import { OriginBadge } from "../common/OriginBadge";
import { PythonRuntimeCard } from "../common/PythonRuntimeCard";
import { QuantStudioPanel } from "../quant/QuantStudioPanel";
import { TeamResearchMemberDirectory } from "../team/TeamResearchMemberDirectory";
import { AgentGeneratedFactorsBlock } from "../team/AgentGeneratedFactorsBlock";
import { AgentGeneratedStrategiesBlock } from "../team/AgentGeneratedStrategiesBlock";
import { AgentRunPanel } from "../team/AgentRunChatView";
import {
  LiveConversationView,
  type LiveConversationEvent,
} from "../team/LiveConversationView";
import { ResizableY } from "../team/ResizableY";
import { TeamHitlBanner } from "../team/TeamHitlBanner";
import { TokyoCodeView } from "../code/TokyoCodeEditor";
import {
  classifyWorkflow,
  formatWorkflowOptionLabel,
  groupWorkflowOptions,
  WORKFLOW_KIND_LABEL,
  type WorkflowKind,
} from "../../lib/workflowKind";

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
      <main style={styles.mainTrader}>
        <TraderLivePanel />
      </main>
    );
  }
  if (activeView === "chat") {
    return (
      <main style={styles.mainChat}>
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
  if (activeView === "broker") {
    return (
      <main style={styles.main}>
        <BrokerAccountsPanel />
      </main>
    );
  }
  if (activeView === "quant") {
    return (
      <main style={styles.main}>
        <QuantStudioPanel />
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
      <MonitorDashboard />
    </main>
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

function shortWorkflowLabel(workflowRunId: string): string {
  return workflowRunId.length > 12 ? `${workflowRunId.slice(0, 8)}…` : workflowRunId;
}

const CHAT_SESSION_AGENT_BOARD_LS = "qubit:chatSessionAgentBoardOpen";
const CHAT_SIDEBAR_WIDTH_LS = "qubit:chatSidebarWidthPx";

function readChatSidebarWidthPx(): number {
  if (typeof window === "undefined") return 220;
  try {
    const n = Number.parseInt(localStorage.getItem(CHAT_SIDEBAR_WIDTH_LS) ?? "", 10);
    if (Number.isFinite(n) && n >= 120 && n <= 640) return n;
  } catch {
    /* ignore */
  }
  return 220;
}

function readSessionAgentBoardOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = localStorage.getItem(CHAT_SESSION_AGENT_BOARD_LS);
    if (v === "false") return false;
    if (v === "true") return true;
  } catch {
    /* ignore */
  }
  return true;
}

function groupAgentsBoardByRole(
  agents: SessionAgentBoardItem[]
): Array<{ role: string; displayName: string; instances: SessionAgentBoardItem[] }> {
  const byRole = new Map<string, SessionAgentBoardItem[]>();
  for (const a of agents) {
    const list = byRole.get(a.role) ?? [];
    list.push(a);
    byRole.set(a.role, list);
  }
  for (const list of byRole.values()) {
    list.sort((a, b) => {
      const ta = a.workflowStartedAt ? new Date(a.workflowStartedAt).getTime() : 0;
      const tb = b.workflowStartedAt ? new Date(b.workflowStartedAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return b.instanceId.localeCompare(a.instanceId);
    });
  }
  const roles = [...byRole.keys()].sort((a, b) => {
    if (a === "orchestrator") return -1;
    if (b === "orchestrator") return 1;
    return a.localeCompare(b);
  });
  return roles.map((role) => {
    const instances = byRole.get(role) ?? [];
    return { role, displayName: instances[0]?.name ?? "unknown", instances };
  });
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
  const [chatLoopKind, setChatLoopKind] = useState<AgentLoopKind>("native");
  const [hitlRequestByMessageId, setHitlRequestByMessageId] = useState<Record<string, string>>({});
  /**
   * 正在被用户操作（点击 approve/reject 中）的 HITL request 锁。
   * 防止双击 / Tauri webview 延迟 / SSE 状态尚未同步导致重复 POST：第一次点击立刻入锁，
   * 按钮变 disabled + 文案改"处理中…"，直到 backend 返回（成功 → 真清状态；
   * idempotent → 静默清；失败 → 清锁并报错让用户重试）。
   */
  const [hitlInflightRequestIds, setHitlInflightRequestIds] = useState<Set<string>>(() => new Set());
  // Tauri webview 屏蔽了 window.confirm/prompt（点击没反应），所以走 inline 2-click 兜底：
  // 第一下点击进入 pending（按钮变红+变文案），第二下才真正执行硬删除；3 秒后自动取消。
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (chatDraftPrefill === null) return;
    setInput(chatDraftPrefill);
    setChatDraftPrefill(null);
  }, [chatDraftPrefill, setChatDraftPrefill]);

  const [agentsBoard, setAgentsBoard] = useState<SessionAgentBoardItem[]>([]);
  const [expandedAgentRoles, setExpandedAgentRoles] = useState<Set<string>>(() => new Set());
  const [a2aMessages, setA2aMessages] = useState<SessionA2AMessageItem[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionAgentBoardOpen, setSessionAgentBoardOpen] = useState(readSessionAgentBoardOpen);
  const [chatSidebarWidthPx, setChatSidebarWidthPx] = useState(readChatSidebarWidthPx);
  const chatLayoutRef = useRef<HTMLDivElement | null>(null);
  const bindStreamRef = useRef<
    ((workflowId: string, runId: string, assistantMessageId: string) => void) | null
  >(null);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_SESSION_AGENT_BOARD_LS, String(sessionAgentBoardOpen));
    } catch {
      /* ignore */
    }
  }, [sessionAgentBoardOpen]);

  const chatGridTemplateColumns = useMemo(() => {
    const w = chatSidebarWidthPx;
    const grip = 6;
    if (sessionAgentBoardOpen) {
      return ideEmbedded
        ? `minmax(120px, ${w}px) ${grip}px minmax(0, 1fr) minmax(120px, 20%)`
        : `minmax(140px, ${w}px) ${grip}px minmax(0, 1fr) minmax(160px, 1fr)`;
    }
    return ideEmbedded
      ? `minmax(120px, ${w}px) ${grip}px minmax(0, 1fr)`
      : `minmax(140px, ${w}px) ${grip}px minmax(0, 1fr)`;
  }, [sessionAgentBoardOpen, ideEmbedded, chatSidebarWidthPx]);

  useLayoutEffect(() => {
    const el = chatLayoutRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const ratioMax = sessionAgentBoardOpen ? 0.38 : 0.52;
      const maxW = Math.min(560, Math.floor(rect.width * ratioMax));
      const minW = ideEmbedded ? 120 : 140;
      setChatSidebarWidthPx((prev) => Math.min(maxW, Math.max(minW, prev)));
    };
    const ro = new ResizeObserver(() => {
      clamp();
    });
    ro.observe(el);
    clamp();
    return () => ro.disconnect();
  }, [sessionAgentBoardOpen, ideEmbedded]);

  const onChatSidebarResizeMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const layout = chatLayoutRef.current;
      if (!layout) return;
      const startX = e.clientX;
      const startW = chatSidebarWidthPx;
      const clampW = (candidate: number) => {
        const rect = layout.getBoundingClientRect();
        const ratioMax = sessionAgentBoardOpen ? 0.38 : 0.52;
        const maxW = Math.min(560, Math.floor(rect.width * ratioMax));
        const minW = ideEmbedded ? 120 : 140;
        return Math.min(maxW, Math.max(minW, Math.round(candidate)));
      };
      let lastW = startW;
      const onMove = (ev: MouseEvent) => {
        lastW = clampW(startW + (ev.clientX - startX));
        setChatSidebarWidthPx(lastW);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        try {
          localStorage.setItem(CHAT_SIDEBAR_WIDTH_LS, String(lastW));
        } catch {
          /* ignore */
        }
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatSidebarWidthPx, sessionAgentBoardOpen, ideEmbedded]
  );

  const agentsBoardByRole = useMemo(() => groupAgentsBoardByRole(agentsBoard), [agentsBoard]);

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

    const filterSet = sessionWorkflowIds.size === 0 ? null : sessionWorkflowIds;
    const grouped = groupStreamEventsByRun(streamEvents, filterSet);

    const streamGroups: StreamGroupItem[] = grouped.map((g) => ({
      kind: "stream_group" as const,
      id: `stream-group-${g.workflowRunId}::${g.runId}`,
      at: g.at,
      workflowRunId: g.workflowRunId,
      runId: g.runId,
      firstTs: g.firstTs,
      roleSummary: g.roleSummary,
      steps: g.steps,
    }));

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

  const reloadSessionMessages = useCallback(
    async (sessionId: string) => {
      const raw = await listSessionMessages(sessionId);
      const hydrated = await hydrateStaleChatMessages(raw);
      setChatMessages(hydrated);
      const hitlMap: Record<string, string> = {};
      for (const msg of hydrated) {
        if (msg.status !== "awaiting_approval" || !msg.workflowRunIds?.[0]) continue;
        try {
          const pending = await listPendingWorkflowHitl(msg.workflowRunIds[0]);
          if (pending[0]?.id) hitlMap[msg.id] = pending[0].id;
        } catch {
          /* ignore */
        }
      }
      if (Object.keys(hitlMap).length > 0) {
        setHitlRequestByMessageId((prev) => ({ ...prev, ...hitlMap }));
      }
      reconnectActiveChatStreams(hydrated, (workflowId, runId, assistantMessageId) => {
        bindStreamRef.current?.(workflowId, runId, assistantMessageId);
      });
    },
    [setChatMessages]
  );

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
      if (sessions.length > 0) {
        setChatSessions(sessions);
        const currentSelected = useAppStore.getState().selectedSessionId;
        const keep =
          currentSelected && sessions.some((s) => s.id === currentSelected)
            ? currentSelected
            : sessions[0].id;
        setSelectedSessionId(keep);
      } else {
        const created = await createChatSession({ workspaceId: wsId, projectId: pid, title: "默认会话" });
        setChatSessions([created]);
        setSelectedSessionId(created.id);
      }
      setErrorText("");
    };
    void boot().catch((err) => setErrorText(err instanceof Error ? err.message : "初始化失败"));
  }, [setChatSessions, setSelectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void reloadSessionMessages(selectedSessionId).catch((err) =>
      setErrorText(err instanceof Error ? err.message : "加载会话消息失败")
    );
  }, [selectedSessionId, reloadSessionMessages]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setExpandedAgentRoles(new Set());
    void getSessionAgentsBoard(selectedSessionId)
      .then(setAgentsBoard)
      .catch(() => setAgentsBoard([]));
    void getSessionA2AMessages(selectedSessionId, 120)
      .then(setA2aMessages)
      .catch(() => setA2aMessages([]));
  }, [selectedSessionId, refreshKey]);

  const toggleAgentRoleExpanded = (role: string) => {
    setExpandedAgentRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  };

  const onSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
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

  /**
   * 硬删除一个会话（实际执行）。
   * 由 inline 2-click 流程触发：UI 上第一次点 × 进 pending 态、提示"再次点击确认"，
   * 第二次点 × 才会调到这里——Tauri webview 屏蔽了 window.confirm，无法走原生弹窗。
   */
  const performHardDeleteSession = async (sessionId: string, sessionTitle: string) => {
    setPendingDeleteSessionId(null);
    try {
      const result = await deleteChatSession(sessionId, { hard: true });
      const remaining = chatSessions.filter((s) => s.id !== sessionId);
      setChatSessions(remaining);
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(remaining[0]?.id ?? "");
      }
      setErrorText(
        `已硬删除会话「${sessionTitle}」（同时清理 ${result.workflowRunIds?.length ?? 0} 个工作流）`
      );
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "硬删除会话失败");
    }
  };

  /**
   * × 按钮单击：第一次设 pending、3 秒后自动撤销；第二次（pending 命中）才真正硬删。
   * 通过 setTimeout + 闭包 id 比对，避免不同会话之间互相干扰。
   */
  const handleClickDeleteSession = (sessionId: string, sessionTitle: string) => {
    if (pendingDeleteSessionId === sessionId) {
      void performHardDeleteSession(sessionId, sessionTitle);
      return;
    }
    setPendingDeleteSessionId(sessionId);
    setErrorText("");
    setTimeout(() => {
      setPendingDeleteSessionId((cur) => (cur === sessionId ? null : cur));
    }, 3000);
  };

  const bindStream = (workflowId: string, runId: string, assistantMessageId: string) => {
    persistChatStreamBinding(assistantMessageId, workflowId, runId);
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
      clearChatStreamBinding(assistantMessageId);
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
            const displayContent = stripToolCallSentinels(buffer);
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: displayContent, status: "running" }
                  : m
              )
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
                  ? (() => {
                      const st = String(event.payload.status ?? "success");
                      const name = String(event.payload.toolName ?? event.payload.targetName ?? "");
                      if (st === "blocked_by_sandbox" || st === "failed") {
                        return `❌ 工具失败: ${name} — ${String(event.payload.reason ?? st)}`;
                      }
                      if (st === "timeout") {
                        return `⏱ 工具超时: ${name}`;
                      }
                      return `✅ 工具完成: ${name}`;
                    })()
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
        if (event.type === "hitl_request") {
          const requestId = String(event.payload.requestId ?? "");
          if (requestId) {
            setHitlRequestByMessageId((prev) => ({ ...prev, [assistantMessageId]: requestId }));
          }
        }
        if (event.type === "final") {
          clearFailTimer();
          streamDone = true;
          const msgStatus = messageStatusFromFinalPayload(event.payload);
          const requestId = String(event.payload.hitlRequestId ?? "");
          if (requestId) {
            setHitlRequestByMessageId((prev) => ({ ...prev, [assistantMessageId]: requestId }));
          }
          const finalText = buildFinalAssistantText(buffer, event.payload, event.stepIndex);
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: finalText,
            status: msgStatus,
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId ? { ...m, content: finalText, status: msgStatus } : m
            )
          );
          setRefreshKey((v) => v + 1);
          stopStream();
        }
        if (event.type === "error") {
          clearFailTimer();
          streamDone = true;
          const errMsg = String(event.payload.error ?? "unknown error");
          const cleaned = stripToolCallSentinels(buffer);
          const errorContent = cleaned || `❌ 执行出错: ${errMsg}`;
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: errorContent,
            status: "failed",
            errorMessage: errMsg,
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: errorContent,
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
        const cleanedBuffer = stripToolCallSentinels(buffer);
        // If we already have some buffer content, the stream likely ended cleanly
        // just without a proper final event — treat as completed rather than failed.
        if (cleanedBuffer.trim()) {
          clearFailTimer();
          streamDone = true;
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: cleanedBuffer,
            status: "completed",
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId ? { ...m, content: cleanedBuffer, status: "completed" } : m
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
          const cleanedLate = stripToolCallSentinels(buffer);
          const lateContent = cleanedLate || "⚠️ 流式连接中断，请重试";
          void patchSessionMessage({
            messageId: assistantMessageId,
            content: lateContent,
            status: "failed",
            errorMessage: "workflow stream disconnected",
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: lateContent,
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
  bindStreamRef.current = bindStream;

  const handleHitlDecision = async (
    messageId: string,
    workflowId: string,
    requestId: string,
    decision: "approved" | "rejected"
  ) => {
    /**
     * 入锁——避免双击 / Tauri webview 延迟 / SSE 还没把状态推回来时用户再点一次：
     * 第二次点击会被按钮的 disabled + 这里的早返兜底。
     */
    if (hitlInflightRequestIds.has(requestId)) return;
    setHitlInflightRequestIds((prev) => {
      const next = new Set(prev);
      next.add(requestId);
      return next;
    });
    try {
      if (decision === "approved") {
        const result = await approveWorkflowHitl(workflowId, requestId);
        /**
         * idempotent=true 说明请求已经被处理过（典型：双击导致两次 POST，第二次后端命中
         * "already approved" 的幂等分支）。仍然按"成功"处理：清掉本地 hitl 状态，
         * 但不重复 patchSessionMessage 写 "▶️ 已批准…"，也不重新 bindStream，
         * 避免一个工作流被订阅两次（看到双倍流式 token）。
         */
        if (!result.idempotent) {
          await patchSessionMessage({ messageId, status: "running", content: "▶️ 已批准，继续执行…" });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === messageId ? { ...m, status: "running", content: "▶️ 已批准，继续执行…" } : m
            )
          );
          if (result.runId) {
            bindStream(workflowId, result.runId, messageId);
          }
        }
      } else {
        const result = await rejectWorkflowHitl(workflowId, requestId);
        if (!result.idempotent) {
          await patchSessionMessage({
            messageId,
            status: "failed",
            content: "🚫 已拒绝本次 Agent 操作",
          });
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === messageId
                ? { ...m, status: "failed", content: "🚫 已拒绝本次 Agent 操作" }
                : m
            )
          );
        }
      }
      setHitlRequestByMessageId((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "HITL 操作失败");
    } finally {
      setHitlInflightRequestIds((prev) => {
        if (!prev.has(requestId)) return prev;
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
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
        loopKind: chatLoopKind,
      });
      await patchSessionMessage({
        messageId: assistantMsg.id,
        workflowRunIds: [created.data.id],
      });
      await patchSessionMessage({ messageId: userMsg.id, status: "completed" });
      if (created.runId) {
        bindStream(created.data.id, created.runId, assistantMsg.id);
      }
      await reloadSessionMessages(selectedSessionId);
      setInput("");
      setChartContext(null);
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "发送失败");
    }
  };

  return (
    <div
      data-qb-chat-panel
      className="qb-chat-panel"
      style={ideEmbedded ? styles.chatIdeRoot : styles.chatPageRoot}
    >
      {ideEmbedded ? (
        <div style={styles.chatIdeHeader}>
          对话 · 与右侧 K 线联动；「带入对话分析」会附加行情上下文。
        </div>
      ) : null}
      <div style={styles.chatChrome}>
        {chartContext ? (
          <div style={styles.chartCtxBanner}>
            已附带行情上下文（{chartContext.symbol} / {chartContext.timeframe}）。发送一条消息后会自动清除。
          </div>
        ) : null}
        {errorText ? <div style={styles.errorBox}>{errorText}</div> : null}
      </div>
      <div
        ref={chatLayoutRef}
        style={{
          ...styles.chatLayout,
          ...(ideEmbedded ? styles.chatLayoutIde : {}),
          gridTemplateColumns: chatGridTemplateColumns,
        }}
      >
        <div className="qb-chat-sidebar" style={styles.chatSidebar}>
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={{ flexShrink: 0, alignSelf: "stretch" }}
            onClick={() => void onCreateSession()}
          >
            新建会话
          </button>
          <div className="qb-chat-session-list" style={styles.chatSessionList}>
            {chatSessions.map((session) => (
              <div
                key={session.id}
                style={{
                  ...styles.chatSessionItem,
                  ...(selectedSessionId === session.id ? styles.chatSessionItemActive : {}),
                  display: "flex",
                  alignItems: "stretch",
                  gap: 4,
                  padding: 0,
                }}
              >
                <button
                  type="button"
                  style={{
                    flex: 1,
                    background: "transparent",
                    border: 0,
                    color: "inherit",
                    textAlign: "left",
                    cursor: "pointer",
                    padding: "8px 10px",
                    minWidth: 0,
                  }}
                  onClick={() => void onSelectSession(session.id)}
                  title={session.title}
                >
                  <div
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {session.title}
                  </div>
                  <div className="qb-chat-bubble__meta">
                    {new Date(session.updatedAt).toLocaleString()}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={
                    pendingDeleteSessionId === session.id
                      ? `再次点击确认硬删除会话 ${session.title}`
                      : `硬删除会话 ${session.title}`
                  }
                  title={
                    pendingDeleteSessionId === session.id
                      ? "再次点击确认硬删除（含全部工作流/消息/checkpoint，不可恢复）。3 秒内未确认将自动取消。"
                      : "硬删除会话（含全部工作流，不可恢复）"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClickDeleteSession(session.id, session.title);
                  }}
                  style={{
                    background:
                      pendingDeleteSessionId === session.id ? "#7f1d1d" : "transparent",
                    border: 0,
                    color: pendingDeleteSessionId === session.id ? "#fecaca" : "#a1a1aa",
                    cursor: "pointer",
                    padding: "0 8px",
                    fontSize: pendingDeleteSessionId === session.id ? 11 : 16,
                    lineHeight: 1,
                    alignSelf: "stretch",
                    fontWeight: pendingDeleteSessionId === session.id ? 600 : 400,
                  }}
                >
                  {pendingDeleteSessionId === session.id ? "再次确认" : "×"}
                </button>
              </div>
            ))}
          </div>
        </div>

        <button
          type="button"
          aria-label="拖动调整会话列表与对话区宽度"
          title="拖动调整宽度"
          onMouseDown={onChatSidebarResizeMouseDown}
          style={styles.chatColResizer}
        />

        <div className="qb-chat-main" style={styles.chatMain}>
          <div style={styles.chatBoardToggleRow}>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => setSessionAgentBoardOpen((o) => !o)}
              title={sessionAgentBoardOpen ? "隐藏右侧会话 Agent 看板" : "显示会话 Agent 看板"}
            >
              {sessionAgentBoardOpen ? "隐藏会话看板" : "显示会话看板"}
            </button>
          </div>
          <div style={styles.chatMessages}>
            {chatMessages.map((msg) => (
              <div key={msg.id} className={`qb-chat-bubble qb-chat-bubble--${msg.role}`}>
                <div className="qb-chat-bubble__meta">
                  {msg.role} · {msg.status}
                </div>
                <div className="qb-chat-markdown">
                  {msg.content ? (
                    <MarkdownBubble text={msg.content} />
                  ) : msg.status === "running" || msg.status === "queued" ? (
                    <span style={{ color: "var(--qb-chat-meta-fg)" }}>(流式生成中…)</span>
                  ) : (
                    <span style={{ color: "var(--qb-chat-meta-fg)" }}>（暂无回复内容）</span>
                  )}
                </div>
                {msg.workflowRunIds?.length ? (
                  <div className="qb-chat-bubble__meta">workflow: {msg.workflowRunIds.join(", ")}</div>
                ) : null}
                {msg.status === "awaiting_approval" &&
                msg.workflowRunIds?.[0] &&
                hitlRequestByMessageId[msg.id] ? (
                  (() => {
                    const reqId = hitlRequestByMessageId[msg.id]!;
                    const inflight = hitlInflightRequestIds.has(reqId);
                    return (
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          type="button"
                          className="qb-btn-primary-brand"
                          disabled={inflight}
                          onClick={() =>
                            void handleHitlDecision(
                              msg.id,
                              msg.workflowRunIds![0]!,
                              reqId,
                              "approved"
                            )
                          }
                        >
                          {inflight ? "处理中…" : "批准继续"}
                        </button>
                        <button
                          type="button"
                          className="qb-btn-ghost"
                          disabled={inflight}
                          onClick={() =>
                            void handleHitlDecision(
                              msg.id,
                              msg.workflowRunIds![0]!,
                              reqId,
                              "rejected"
                            )
                          }
                        >
                          拒绝
                        </button>
                      </div>
                    );
                  })()
                ) : null}
              </div>
            ))}
          </div>
          <form style={styles.chatForm} onSubmit={onSend}>
            <label style={{ ...styles.chatMeta, display: "flex", alignItems: "center", gap: 6 }}>
              Loop
              <select
                value={chatLoopKind}
                onChange={(e) => setChatLoopKind(e.target.value as AgentLoopKind)}
                style={{ ...styles.input, maxWidth: 160 }}
              >
                <option value="native">Native</option>
                <option value="claude_cli">Claude CLI</option>
                <option value="codex_cli">Codex CLI</option>
              </select>
            </label>
            <input
              style={{ ...styles.input, flex: 1 }}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入任务目标，发送给主 Agent"
            />
            <button className="qb-btn-primary-brand" type="submit">
              发送
            </button>
          </form>
        </div>

        {sessionAgentBoardOpen ? (
        <div className="qb-chat-board-col" style={styles.boardCol}>
          <div style={styles.boardColHeader}>
            <h3 style={{ ...styles.subTitle, margin: 0 }}>会话 Agent 看板</h3>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => setSessionAgentBoardOpen(false)}
              title="隐藏右侧看板"
            >
              隐藏
            </button>
          </div>
          <div style={styles.boardColScroll}>
            <div style={styles.boardList}>
              {agentsBoardByRole.map((group) => {
                const expanded = expandedAgentRoles.has(group.role);
                const newest = group.instances[0];
                const runningN = group.instances.filter((i) => i.status === "running").length;
                return (
                  <div key={group.role} style={styles.boardCard}>
                    <button
                      type="button"
                      onClick={() => toggleAgentRoleExpanded(group.role)}
                      style={styles.boardRoleToggle}
                    >
                      <div style={styles.cardName}>{group.role}</div>
                      <div style={styles.cardDesc}>
                        {group.displayName !== group.role ? `${group.displayName} · ` : ""}
                        {group.instances.length} 个 workflow
                        {runningN > 0 ? ` · ${runningN} 运行中` : ""}
                      </div>
                      {!expanded && newest ? (
                        <div style={styles.cardDesc}>
                          最近: {newest.status} · {newest.latestStep?.phase ?? "-"} #
                          {newest.latestStep?.stepIndex ?? "-"}
                          {newest.workflowStartedAt
                            ? ` · ${new Date(newest.workflowStartedAt).toLocaleString()}`
                            : ""}
                        </div>
                      ) : null}
                      <div style={{ ...styles.chatMeta, marginTop: 4 }}>{expanded ? "▼ 收起" : "▶ 展开各 workflow"}</div>
                    </button>
                    {expanded ? (
                      <div style={styles.boardNested}>
                        {group.instances.map((item) => (
                          <div key={item.instanceId} style={styles.boardNestedRow}>
                            <div style={styles.cardDesc} title={item.workflowRunId}>
                              workflow: <code style={styles.boardMono}>{shortWorkflowLabel(item.workflowRunId)}</code>
                              {item.workflowMode ? ` · ${item.workflowMode}` : ""}
                              {item.workflowStatus ? ` · ${item.workflowStatus}` : ""}
                            </div>
                            <div style={styles.cardDesc}>
                              {item.workflowStartedAt
                                ? new Date(item.workflowStartedAt).toLocaleString()
                                : "—"}
                            </div>
                            <div style={styles.cardDesc}>
                              status: {item.status} · iteration: {item.currentIteration}
                            </div>
                            <div style={styles.cardDesc}>
                              latest: {item.latestStep?.phase ?? "-"} #{item.latestStep?.stepIndex ?? "-"}
                            </div>
                            {item.lastError ? <div style={styles.errorText}>{item.lastError}</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
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
        ) : null}
      </div>
    </div>
  );
};

const ConfigPanel: FC = () => {
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
  const [agentUiTab, setAgentUiTab] = useState<AgentConfigUiTab>("overview");
  const [agentPack, setAgentPack] = useState<AgentPackResponse | null>(null);
  const [agentMemoryStats, setAgentMemoryStats] = useState<AgentMemoryStatsResponse | null>(null);
  const [fileSoulMd, setFileSoulMd] = useState("");
  const [filePromptMd, setFilePromptMd] = useState("");
  const [fileAgentMd, setFileAgentMd] = useState("");
  const [fileUserMd, setFileUserMd] = useState("");
  const [fileMemoryMd, setFileMemoryMd] = useState("");
  const [draftPromptMode, setDraftPromptMode] = useState<"db_primary" | "file_primary" | "merged">("db_primary");
  const [draftMemoryNamespace, setDraftMemoryNamespace] = useState("");
  const [draftConfigRootUri, setDraftConfigRootUri] = useState("");
  const [draftMcpServerNames, setDraftMcpServerNames] = useState<string[]>([]);
  const [draftDisplayName, setDraftDisplayName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftTools, setDraftTools] = useState<string[]>([]);
  const [draftMaxIterations, setDraftMaxIterations] = useState(20);
  const [draftSkills, setDraftSkills] = useState<string[]>([]);
  const [draftSubscriptions, setDraftSubscriptions] = useState<string[]>([]);
  const [draftPromptTemplateRef, setDraftPromptTemplateRef] = useState("");
  const [provider, setProvider] = useState<
    "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock"
  >("mock");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [tushareToken, setTushareToken] = useState("");
  const [klinesDataSource, setKlinesDataSource] = useState<
    | "auto"
    | "tushare_daily"
    | "yahoo_chart"
    | "eastmoney"
    | "akshare"
    | "binance_crypto"
    | "synthetic"
  >("auto");
  const [cryptoUseTestnet, setCryptoUseTestnet] = useState(false);
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
  const [sourceBaseUrl, setSourceBaseUrl] = useState(
    "https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100"
  );
  const [sourceAuthType, setSourceAuthType] = useState<"none" | "bearer" | "api_key">("none");
  const [sourceAuthRef, setSourceAuthRef] = useState("");
  const [mcpMarketItems, setMcpMarketItems] = useState<McpCatalogItemRecord[]>([]);
  const [mcpMarketPage, setMcpMarketPage] = useState(1);
  const [mcpMarketTotal, setMcpMarketTotal] = useState(0);
  const [mcpMarketTotalPages, setMcpMarketTotalPages] = useState(1);
  const [mcpMarketLoading, setMcpMarketLoading] = useState(false);
  const MCP_MARKET_PAGE_SIZE = 24;
  const [mcpMarketInstalls, setMcpMarketInstalls] = useState<McpProjectInstallRecord[]>([]);
  const [skillMarketStatus, setSkillMarketStatus] = useState<SkillMarketStatusDto | null>(null);
  const [skillMarketProvider, setSkillMarketProvider] = useState<"skillsmp" | "open">("skillsmp");
  const [skillSearchQ, setSkillSearchQ] = useState("");
  const [skillSearchBusy, setSkillSearchBusy] = useState(false);
  const [skillSearchHits, setSkillSearchHits] = useState<OpenSkillMarketEntryDto[]>([]);
  const [skillMarketPage, setSkillMarketPage] = useState(1);
  const [skillMarketTotal, setSkillMarketTotal] = useState(0);
  const [skillMarketTotalPages, setSkillMarketTotalPages] = useState(1);
  const SKILL_MARKET_PAGE_SIZE = 24;
  const [skillInstalls, setSkillInstalls] = useState<SkillMarketInstallRecord[]>([]);
  /** 由 curator / evolver / 用户手写 / 市场镜像汇总到 agent_skill 表的统一 skill 库。 */
  const [skillLibrary, setSkillLibrary] = useState<AgentSkillRecord[]>([]);
  const [skillLibraryIncludeArchived, setSkillLibraryIncludeArchived] = useState(false);
  const [skillRefreshBusy, setSkillRefreshBusy] = useState(false);
  const [skillAppendDefinitionId, setSkillAppendDefinitionId] = useState("");
  const [manualSkillName, setManualSkillName] = useState("");
  const [manualSkillDescription, setManualSkillDescription] = useState("");
  const [manualSkillRepo, setManualSkillRepo] = useState("");
  const [manualSkillPath, setManualSkillPath] = useState("");
  const [manualSkillLocalPath, setManualSkillLocalPath] = useState("");
  const [manualSkillTags, setManualSkillTags] = useState("");
  const [manualSkillError, setManualSkillError] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [currentProjectId, setCurrentProjectId] = useState("");
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState("");
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
  const [mcpAdvancedEditorOpen, setMcpAdvancedEditorOpen] = useState(false);
  const [mcpAdvancedJsonDraft, setMcpAdvancedJsonDraft] = useState("");
  const [mcpAdvancedJsonError, setMcpAdvancedJsonError] = useState("");
  const [mcpProbeByServer, setMcpProbeByServer] = useState<
    Record<string, { status: "idle" | "checking" | "ok" | "error"; message?: string; checkedAt?: string }>
  >({});
  // 定时任务 / 集成 / IM：状态由各自的子面板（ScheduledJobsPanel / IntegrationCenterPanel）自管，
  // 这里只透传 workspace/project 上下文。

  const hydrateBuiltinConnectorForm = (cfg: BuiltinConnectorConfig) => {
    const d = cfg["qubit-data"] ?? {};
    const n = cfg["qubit-news"] ?? {};
    setTushareToken(typeof d.tushareToken === "string" ? d.tushareToken : "");
    const kds = d["klinesDataSource"];
    setKlinesDataSource(
      kds === "tushare_daily" ||
      kds === "yahoo_chart" ||
      kds === "eastmoney" ||
      kds === "akshare" ||
      kds === "binance_crypto" ||
      kds === "synthetic" ||
      kds === "auto"
        ? kds
        : "auto"
    );
    const testnet = d["cryptoUseTestnet"];
    setCryptoUseTestnet(testnet === true || testnet === "true");
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

  const preferAgentDefinitionIdRef = useRef<string | null>(null);
  const prevAgentDefId = useRef<string>("");

  const loadConfig = async () => {
    const workspaces = await listWorkspaces();
    const currentWorkspace = workspaces[0];
    const projects = currentWorkspace ? await listProjects(currentWorkspace.id) : [];
    const currentProject = projects[0];
    const [data, bundles, servers, bindings, sources] = await Promise.all([
      getAgentsConfig(),
      listAgentDefinitions(),
      listMcpServers(currentProject?.id),
      listMcpBindings(currentProject?.id),
      listMcpSources(),
    ]);
    const [installs, skillInstallRows] = await Promise.all([
      currentProject ? listMcpProjectInstalls(currentProject.id) : Promise.resolve([]),
      currentProject ? listSkillMarketInstalls(currentProject.id) : Promise.resolve([]),
    ]);
    setConfigData(data);
    let list: AgentDefinitionBundle[] = bundles ?? [];
    if (list.length === 0 && Array.isArray(data.dbEffective?.definitions)) {
      const raw = data.dbEffective.definitions as AgentDefinitionRecord[];
      if (raw.length > 0) {
        list = raw.map((definition) => ({ definition, profile: null, draft: null }));
      }
    }
    setDefinitions(list);
    setMcpServers(servers);
    setMcpBindings(bindings);
    setMcpProbeByServer({});
    setFocusedMcpServerId((prev) => (prev && servers.some((s) => s.id === prev) ? prev : null));
    setMcpSources(sources);
    setMcpMarketItems([]);
    setMcpMarketPage(1);
    setMcpMarketTotal(0);
    setMcpMarketTotalPages(1);
    setMcpMarketInstalls(installs);
    setSkillInstalls(skillInstallRows);
    if (currentWorkspace) setCurrentWorkspaceId(currentWorkspace.id);
    if (currentProject) setCurrentProjectId(currentProject.id);
    if (!selectedMcpServer && servers[0]) {
      setSelectedMcpServer(servers[0].name);
    }
    if (!selectedSourceId && sources[0]) {
      setSelectedSourceId(sources[0].id);
      setSourceName(sources[0].name);
      setSourceBaseUrl(sources[0].baseUrl);
      setSourceAuthType(sources[0].authType);
      setSourceAuthRef(sources[0].authRef ?? "");
    }
    if (list.length === 0) {
      setSelectedDefinitionId("");
    } else {
      const preferred = preferAgentDefinitionIdRef.current;
      preferAgentDefinitionIdRef.current = null;
      const resolvedId =
        (preferred && list.some((x) => x.definition.id === preferred) ? preferred : null) ??
        (selectedDefinitionId && list.some((x) => x.definition.id === selectedDefinitionId) ? selectedDefinitionId : null) ??
        list[0]!.definition.id;
      const b = list.find((x) => x.definition.id === resolvedId) ?? list[0]!;
      const selectionChanged = resolvedId !== selectedDefinitionId;
      setSelectedDefinitionId(resolvedId);
      if (selectionChanged) {
        prevAgentDefId.current = "";
        setDraftPrompt(b.draft?.systemPrompt ?? b.definition.systemPrompt);
        setDraftSoul(b.profile?.soulFileRef ?? "");
        setDraftPromptMode((b.profile?.promptMode as "db_primary" | "file_primary" | "merged") ?? "db_primary");
        setDraftMemoryNamespace(b.profile?.memoryNamespace ?? "");
        setDraftConfigRootUri(b.profile?.configRootUri ?? "");
        setDraftMcpServerNames(parseAgentMcpServerNames(b.draft?.mcpServersJson ?? b.definition.mcpServersJson));
        setDraftPromptTemplateRef(b.profile?.promptTemplateRef ?? "");
      }
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

  useEffect(() => {
    if (activeConfigSubPage !== "skills") return;
    void getSkillMarketStatus().then(setSkillMarketStatus);
  }, [activeConfigSubPage]);

  useEffect(() => {
    if (activeConfigSubPage !== "skills" || !currentProjectId) return;
    void listSkillMarketInstalls(currentProjectId).then(setSkillInstalls);
  }, [activeConfigSubPage, currentProjectId]);

  useEffect(() => {
    if (activeConfigSubPage !== "skills" || !currentProjectId) return;
    void listSkillLibrary(currentProjectId, { includeArchived: skillLibraryIncludeArchived })
      .then(setSkillLibrary)
      .catch(() => setSkillLibrary([]));
  }, [activeConfigSubPage, currentProjectId, skillLibraryIncludeArchived]);

  const loadMcpMarketPage = useCallback(
    async (page: number) => {
      const sourceId = selectedSourceId || mcpSources[0]?.id;
      if (!sourceId) {
        setMcpMarketItems([]);
        setMcpMarketTotal(0);
        setMcpMarketTotalPages(1);
        setMcpMarketPage(1);
        return;
      }
      setMcpMarketLoading(true);
      try {
        const res = await listMcpMarketCatalog({
          sourceId,
          q: marketQuery.trim() || undefined,
          page,
          pageSize: MCP_MARKET_PAGE_SIZE,
        });
        const items = Array.isArray(res.items) ? res.items : [];
        setMcpMarketItems(items);
        setMcpMarketPage(res.page ?? page);
        setMcpMarketTotal(res.total ?? items.length);
        setMcpMarketTotalPages(Math.max(1, res.totalPages ?? 1));
        if (items.length > 0) {
          const first = items[0]!;
          setSelectedCatalogId((prev) => {
            const nextId = prev && items.some((x) => x.id === prev) ? prev : first.id;
            const hit = items.find((x) => x.id === nextId) ?? first;
            setCatalogServerName(hit.slug.replace(/[^a-z0-9_-]/gi, "-"));
            return nextId;
          });
        }
      } finally {
        setMcpMarketLoading(false);
      }
    },
    [selectedSourceId, mcpSources, marketQuery]
  );

  useEffect(() => {
    if (activeConfigSubPage !== "mcp") return;
    void loadMcpMarketPage(1);
  }, [activeConfigSubPage, selectedSourceId, loadMcpMarketPage]);

  const loadSkillMarketPage = useCallback(
    async (page: number) => {
      setSkillSearchBusy(true);
      try {
        const res = await searchSkillMarket({
          q: skillSearchQ,
          page,
          pageSize: SKILL_MARKET_PAGE_SIZE,
          provider: skillMarketProvider,
        });
        const items = Array.isArray(res.items) ? res.items : [];
        setSkillSearchHits(items);
        setSkillMarketPage(res.page ?? page);
        setSkillMarketTotal(res.total ?? items.length);
        setSkillMarketTotalPages(Math.max(1, res.totalPages ?? 1));
      } finally {
        setSkillSearchBusy(false);
      }
    },
    [skillSearchQ, skillMarketProvider]
  );

  const searchSkillMarketNow = async () => {
    await loadSkillMarketPage(1);
  };

  const installManualSkillNow = async () => {
    if (!currentProjectId) {
      setManualSkillError("请先加载项目后再添加 Skill。");
      return;
    }
    const skillName = manualSkillName.trim();
    if (!skillName) {
      setManualSkillError("请填写 skill 名称。");
      return;
    }
    try {
      setManualSkillError("");
      await installManualSkill({
        projectId: currentProjectId,
        skillName,
        description: manualSkillDescription.trim() || undefined,
        repo: manualSkillRepo.trim() || undefined,
        path: manualSkillPath.trim() || undefined,
        localPath: manualSkillLocalPath.trim() || undefined,
        tags: manualSkillTags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setManualSkillName("");
      setManualSkillDescription("");
      setManualSkillRepo("");
      setManualSkillPath("");
      setManualSkillLocalPath("");
      setManualSkillTags("");
      await listSkillMarketInstalls(currentProjectId).then(setSkillInstalls);
    } catch (e) {
      setManualSkillError(e instanceof Error ? e.message : "添加 Skill 失败");
    }
  };

  useEffect(() => {
    if (!definitions.length) return;
    setSkillAppendDefinitionId((prev) =>
      prev && definitions.some((b) => b.definition.id === prev) ? prev : definitions[0]!.definition.id
    );
  }, [definitions]);

  const selectedBundle = useMemo(
    () => definitions.find((item) => item.definition.id === selectedDefinitionId) ?? null,
    [definitions, selectedDefinitionId]
  );

  useEffect(() => {
    if (!selectedDefinitionId) return;
    void Promise.all([getAgentDefinitionPack(selectedDefinitionId), getAgentDefinitionMemoryStats(selectedDefinitionId)])
      .then(([pack, mem]) => {
        setAgentPack(pack);
        setAgentMemoryStats(mem);
        setFileAgentMd(pack.agentMarkdown ?? "");
        setFileSoulMd(pack.soulMarkdown);
        setFilePromptMd(pack.promptMarkdown);
        setFileUserMd(pack.userMarkdown ?? "");
        setFileMemoryMd(pack.memoryMarkdown ?? "");
      })
      .catch(() => {
        setAgentPack(null);
        setAgentMemoryStats(null);
        setFileAgentMd("");
        setFileUserMd("");
        setFileMemoryMd("");
      });
  }, [selectedDefinitionId]);

  useEffect(() => {
    if (!selectedDefinitionId) return;
    if (prevAgentDefId.current === selectedDefinitionId) return;
    prevAgentDefId.current = selectedDefinitionId;
    const b = definitions.find((x) => x.definition.id === selectedDefinitionId);
    if (!b) return;
    setDraftPrompt(b.draft?.systemPrompt ?? b.definition.systemPrompt);
    setDraftSoul(b.profile?.soulFileRef ?? "");
    setDraftPromptMode((b.profile?.promptMode as "db_primary" | "file_primary" | "merged") ?? "db_primary");
    setDraftMemoryNamespace(b.profile?.memoryNamespace ?? "");
    setDraftConfigRootUri(b.profile?.configRootUri ?? "");
    setDraftMcpServerNames(parseAgentMcpServerNames(b.draft?.mcpServersJson ?? b.definition.mcpServersJson));
    setDraftDisplayName(b.profile?.displayName?.trim() || agentDisplayLabel(b));
    setDraftDescription(b.profile?.description ?? "");
    const parseStrList = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : [];
    setDraftTools(parseStrList(b.draft?.toolsJson ?? b.definition.toolsJson));
    setDraftMaxIterations(b.draft?.maxIterations ?? b.definition.maxIterations ?? 20);
    setDraftSkills(parseStrList(b.draft?.skillsJson ?? b.definition.skillsJson));
    setDraftSubscriptions(parseStrList(b.draft?.subscriptionsJson ?? b.definition.subscriptionsJson));
    setDraftPromptTemplateRef(b.profile?.promptTemplateRef ?? "");
  }, [selectedDefinitionId, definitions]);

  const knownToolPool = useMemo(() => {
    const s = new Set<string>();
    for (const b of definitions) {
      const raw = b.draft?.toolsJson ?? b.definition.toolsJson;
      if (Array.isArray(raw)) {
        for (const x of raw) {
          if (typeof x === "string" && x.trim()) s.add(x.trim());
        }
      }
    }
    return Array.from(s).sort();
  }, [definitions]);

  const mcpServerBindingCount = useMemo(() => {
    const map = new Map<string, number>();
    const did = selectedDefinitionId || undefined;
    for (const row of mcpBindings) {
      if (did) {
        if (row.definitionId && row.definitionId !== did) continue;
      } else if (row.definitionId) continue;
      map.set(row.serverName, (map.get(row.serverName) ?? 0) + 1);
    }
    return map;
  }, [mcpBindings, selectedDefinitionId]);

  const pickBindingForMcpServer = (serverName: string): McpToolBindingRecord | undefined => {
    const pid = currentProjectId || undefined;
    const did = selectedDefinitionId || undefined;
    const forServer = mcpBindings.filter((b) => b.serverName === serverName);
    const score = (b: McpToolBindingRecord) => {
      let s = 0;
      if (did) {
        if (b.definitionId === did) s += 100;
        else if (b.definitionId == null) s += 10;
        else return -1;
      } else {
        if (b.definitionId != null) return -1;
        s += 10;
      }
      if (pid) {
        if (b.projectId === pid) s += 50;
        else if (b.projectId == null) s += 5;
        else return -1;
      } else {
        if (b.projectId != null) return -1;
        s += 5;
      }
      return s;
    };
    const pool = forServer.filter((b) => score(b) >= 0);
    const sorted = [...pool].sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return 0;
    });
    return sorted.find((b) => b.enabled) ?? sorted[0];
  };

  const mcpConnectionSpecOk = (row: McpServerConfigRecord): boolean => {
    if (!row.enabled) return false;
    if (row.transport === "stdio") return Boolean(row.command?.trim());
    return Boolean(row.url?.trim());
  };

  const formatMcpProbeDetail = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const jsonMatch = raw.match(/^HTTP \d+:([\s\S]*)$/);
    if (jsonMatch?.[1]) {
      try {
        const body = JSON.parse(jsonMatch[1].trim()) as unknown;
        return typeof body === "string" ? body : JSON.stringify(body, null, 2);
      } catch {
        return raw;
      }
    }
    return raw;
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
      const msg = formatMcpProbeDetail(e);
      setMcpTestOutput(msg);
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: { status: "error", message: msg, checkedAt: new Date().toISOString() },
      }));
    }
  };

  const buildMcpAdvancedPayload = (row: McpServerConfigRecord, bind?: McpToolBindingRecord) => ({
    server: {
      id: row.id,
      name: row.name,
      projectId: row.projectId,
      transport: row.transport,
      command: row.command?.trim() ? String(row.command) : "",
      url: row.url?.trim() ? String(row.url) : "",
      capabilitiesJson: row.capabilitiesJson,
      enabled: row.enabled,
    },
    binding: bind
      ? {
          id: bind.id,
          projectId: bind.projectId,
          serverName: bind.serverName,
          toolName: bind.toolName,
          enabled: bind.enabled,
          timeoutMs: bind.timeoutMs ?? 20_000,
          retryPolicyJson: bind.retryPolicyJson,
          rateLimitJson: bind.rateLimitJson,
        }
      : null,
  });

  const openMcpAdvancedEditor = (row: McpServerConfigRecord) => {
    const bind = pickBindingForMcpServer(row.name);
    setMcpAdvancedJsonDraft(JSON.stringify(buildMcpAdvancedPayload(row, bind), null, 2));
    setMcpAdvancedJsonError("");
    setMcpTestOutput("");
    setSelectedMcpServer(row.name);
    setFocusedMcpServerId(row.id);
    setMcpAdvancedEditorOpen(true);
    if (bind) {
      setMcpToolName(bind.toolName);
      if (typeof bind.timeoutMs === "number" && Number.isFinite(bind.timeoutMs)) {
        setMcpTimeoutMs(bind.timeoutMs);
      }
    }
    void probeMcpServer(row, bind);
  };

  const saveMcpAdvancedJson = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(mcpAdvancedJsonDraft || "{}");
    } catch {
      setMcpAdvancedJsonError("JSON 解析失败，请检查语法");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      setMcpAdvancedJsonError("根节点须为对象，且包含 server 字段");
      return;
    }
    const root = parsed as Record<string, unknown>;
    const server = root["server"];
    if (!server || typeof server !== "object") {
      setMcpAdvancedJsonError("缺少 server 对象");
      return;
    }
    const s = server as Record<string, unknown>;
    const name = typeof s["name"] === "string" ? s["name"].trim() : "";
    const transport = s["transport"];
    if (!name || (transport !== "stdio" && transport !== "http" && transport !== "ws")) {
      setMcpAdvancedJsonError("server.name 与 server.transport（stdio|http|ws）为必填");
      return;
    }
    const cmd = typeof s["command"] === "string" ? s["command"].trim() : "";
    const url = typeof s["url"] === "string" ? s["url"].trim() : "";
    const caps = s["capabilitiesJson"];
    const enabled = typeof s["enabled"] === "boolean" ? s["enabled"] : true;
    const proj =
      typeof s["projectId"] === "string" && s["projectId"].trim()
        ? s["projectId"].trim()
        : currentProjectId || undefined;
    try {
      await upsertMcpServer({
        name,
        projectId: proj,
        transport,
        command: cmd || undefined,
        url: url || undefined,
        capabilitiesJson: Array.isArray(caps) ? (caps as unknown[]) : ["tools"],
        enabled,
      });
    } catch (e) {
      setMcpAdvancedJsonError(e instanceof Error ? e.message : String(e));
      return;
    }
    const binding = root["binding"];
    if (binding && typeof binding === "object") {
      const b = binding as Record<string, unknown>;
      const toolName = typeof b["toolName"] === "string" ? b["toolName"].trim() : "";
      if (toolName) {
        const timeoutRaw = b["timeoutMs"];
        const timeoutMs =
          typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
            ? timeoutRaw
            : typeof timeoutRaw === "string" && Number.isFinite(Number(timeoutRaw))
              ? Number(timeoutRaw)
              : 20_000;
        const ben = typeof b["enabled"] === "boolean" ? b["enabled"] : true;
        const retry = b["retryPolicyJson"];
        const rate = b["rateLimitJson"];
        try {
          await upsertMcpBinding({
            projectId: proj,
            serverName: name,
            toolName,
            enabled: ben,
            timeoutMs,
            retryPolicyJson:
              retry && typeof retry === "object" ? (retry as Record<string, unknown>) : { maxAttempts: 2, backoffMs: 300 },
            rateLimitJson: rate && typeof rate === "object" ? (rate as Record<string, unknown>) : {},
          });
        } catch (e) {
          setMcpAdvancedJsonError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
    }
    setMcpAdvancedJsonError("");
    setMcpServers(await listMcpServers(currentProjectId || undefined));
    setMcpBindings(await listMcpBindings(currentProjectId || undefined));
    setMcpTestOutput("高级 JSON 已保存并同步到数据库");
    setMcpProbeByServer((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const installMarketCatalogItem = async (item: McpCatalogItemRecord) => {
    if (!currentProjectId) return;
    const spec = (item.specJson ?? {}) as Record<string, unknown>;
    const serverName = item.slug.replace(/[^a-z0-9_-]/gi, "-");
    const toolRaw = spec["defaultToolName"];
    const toolName = typeof toolRaw === "string" && toolRaw.trim() ? toolRaw.trim() : undefined;
    const toRaw = spec["defaultTimeoutMs"];
    const timeoutMs =
      typeof toRaw === "number" && Number.isFinite(toRaw)
        ? toRaw
        : typeof toRaw === "string" && Number.isFinite(Number(toRaw))
          ? Number(toRaw)
          : mcpTimeoutMs;
    const cmd = typeof spec["command"] === "string" ? spec["command"].trim() : "";
    const url = typeof spec["url"] === "string" ? spec["url"].trim() : "";
    try {
      const installed = await installMcpMarket({
        projectId: currentProjectId,
        catalogItemId: item.id,
        serverName,
        toolName,
        timeoutMs,
        command: cmd || undefined,
        url: url || undefined,
      });
      setSelectedCatalogId(item.id);
      setCatalogServerName(serverName);
      if (toolName) setMcpToolName(toolName);
      setMcpTimeoutMs(timeoutMs);
      setMcpMarketInstalls((prev) => [installed, ...prev].slice(0, 30));
      setMcpServers(await listMcpServers(currentProjectId));
      setMcpBindings(await listMcpBindings(currentProjectId));
      setSelectedMcpServer(installed.serverName);
      setMcpTestOutput(`已从市场安装：${item.name} → ${installed.serverName}`);
    } catch (e) {
      setMcpTestOutput(e instanceof Error ? e.message : String(e));
    }
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
    setMcpMarketLoading(true);
    try {
      const out = await syncMcpSource(selectedSourceId);
      setMcpTestOutput(`source synced: ${out.syncedCount}, fallback=${out.usedFallback}`);
      await loadMcpMarketPage(1);
    } finally {
      setMcpMarketLoading(false);
    }
  };

  const searchMarketNow = async () => {
    await loadMcpMarketPage(1);
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

  // 定时任务 / 集成的 CRUD 逻辑已下沉到 ScheduledJobsPanel 与 IntegrationCenterPanel。

  return (
    <div data-qb-config-center className="qb-config-center">
      <h2 style={styles.title}>配置中心</h2>
      <div style={styles.actions}>
        <button type="button" className="qb-btn-primary-brand" onClick={() => void loadConfig()}>
          刷新配置
        </button>
        <button
          type="button"
          className="qb-btn-secondary"
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
      <div className="qb-segmented" role="tablist" aria-label="配置分类">
        {(
          [
            ["llm", "LLM"],
            ["datasources", "数据源"],
            ["mcp", "MCP"],
            ["skills", "Skills"],
            ["agent", "Agent"],
            ["providers", "Providers"],
            ["integration", "集成 / IM"],
            ["schedule", "定时任务"],
            ["runtime", "运行时"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeConfigSubPage === id}
            className={`qb-segmented__tab${activeConfigSubPage === id ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setConfigSubPage(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={styles.configPageBody}>
        {activeConfigSubPage === "llm" ? (
          <>
            <h3 style={styles.subTitle}>默认 LLM 配置（降级模型）</h3>
            <p className="qb-config-hint">
              此处配置的模型作为<strong>系统默认</strong>，当 Agent 未指定 provider 或
              指定 provider 不可用时自动降级到这里。保存写入 <code>.qubit/model.json</code>。
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
                className="qb-btn-primary-brand"
                onClick={() =>
                  void saveModelConfig({
                    provider,
                    model: modelName,
                    apiKey: modelApiKey,
                    baseUrl: modelBaseUrl || undefined,
                  })
                }
              >
                保存默认配置
              </button>
            </div>

            <h3 style={{ ...styles.subTitle, marginTop: 24 }}>多 LLM Provider（per-Agent 路由）</h3>
            <p className="qb-config-hint">
              新增不同的模型 provider 后，可在 Agent 编辑页把指定 Agent 路由到不同模型
              （如 def-research 用 Claude、def-orchestrator 用 GPT）。任一 provider 失败
              会自动降级到上方的默认模型。
            </p>
            <LlmProvidersList />
          </>
        ) : null}
        {activeConfigSubPage === "datasources" ? (
          <>
            <h3 style={styles.subTitle}>数据源（qubit-data / qubit-news）</h3>
            <p className="qb-config-hint qb-config-hint--tight">
              在客户端填写后写入本机数据库（~/.quant-agent/db），启动时与保存后都会重新注入连接器；无需环境变量。
              <br />
              K 线数据源 <code style={{ fontSize: 11 }}>klinesDataSource</code>：默认「自动」为 A 股优先{" "}
              <strong>东方财富</strong>；加密货币（市场 CRYPTO / 如 BTCUSDT）走 <strong>Binance</strong> 公开 API；
              有 Tushare token 时 A 股日线可走 Tushare；美股等走 Yahoo。
            </p>
            <div style={{ ...styles.form, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <span style={{ whiteSpace: "nowrap" }}>K 线数据源</span>
                <select
                  style={styles.select}
                  value={klinesDataSource}
                  onChange={(e) =>
                    setKlinesDataSource(
                      e.target.value as
                        | "auto"
                        | "tushare_daily"
                        | "yahoo_chart"
                        | "eastmoney"
                        | "akshare"
                        | "binance_crypto"
                        | "synthetic"
                    )
                  }
                >
                  <option value="auto">自动（A 股 → 东方财富；加密 → Binance；有 Tushare → 日线；其它 → Yahoo）</option>
                  <option value="eastmoney">东方财富（A 股日线 + 分钟/小时，免费）</option>
                  <option value="binance_crypto">Binance（加密货币 K 线 / 报价，公开 API）</option>
                  <option value="akshare">AKShare（A 股，需 Python: pip install akshare pandas）</option>
                  <option value="yahoo_chart">Yahoo Finance（日线 + 分钟/小时）</option>
                  <option value="tushare_daily">Tushare 日线（需 token）</option>
                  <option value="synthetic">不拉外源（K 线为空，用于禁用行情）</option>
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <input
                  type="checkbox"
                  checked={cryptoUseTestnet}
                  onChange={(e) => setCryptoUseTestnet(e.target.checked)}
                />
                Binance 测试网
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
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <input
                  type="checkbox"
                  checked={newsSyntheticWhenEmpty}
                  onChange={(e) => setNewsSyntheticWhenEmpty(e.target.checked)}
                />
                空结果时回落 stub
              </label>
              <button
                className="qb-btn-primary-brand"
                onClick={() =>
                  void saveBuiltinConnectorConfig({
                    "qubit-data": {
                      klinesDataSource,
                      tushareToken: tushareToken.trim() || undefined,
                      cryptoUseTestnet: cryptoUseTestnet || undefined,
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
            <h3 style={styles.subTitle}>已注册的 MCP</h3>
            <p className="qb-config-hint">
              每张卡片展示连接规格与最近一次探测结果。点击卡片打开<strong>高级 JSON 编辑</strong>（含 server + binding）；打开时会尝试探测连通性。
            </p>
            <div style={styles.meta}>
              <span>Server: {mcpServers.length}</span>
              <span>绑定: {mcpBindings.length}</span>
              <span>市场安装: {mcpMarketInstalls.length}</span>
            </div>
            <div style={styles.grid}>
              {mcpServers.length === 0 ? (
                <div style={{ ...styles.card, color: "var(--qb-main-meta)", fontSize: 13 }}>暂无 MCP，可从下方市场安装或使用「快速添加」。</div>
              ) : null}
              {mcpServers.map((row) => {
                const probe = mcpProbeByServer[row.name];
                const specOk = mcpConnectionSpecOk(row);
                const bindCount = mcpServerBindingCount.get(row.name) ?? 0;
                const shortMsg = (m?: string) => (!m ? "" : m.length > 56 ? `${m.slice(0, 56)}…` : m);
                const cfgPill =
                  !row.enabled
                    ? { bg: "var(--qb-pill-disabled-bg)", color: "var(--qb-pill-disabled-fg)", text: "配置：已禁用" }
                    : !specOk
                      ? {
                          bg: "var(--qb-pill-warn-bg)",
                          color: "var(--qb-pill-warn-fg)",
                          text: row.transport === "stdio" ? "配置：缺少 command" : "配置：缺少 url",
                        }
                      : { bg: "var(--qb-pill-ok-bg)", color: "var(--qb-pill-ok-fg)", text: "配置：就绪" };
                const reachPill =
                  probe?.status === "checking"
                    ? { bg: "var(--qb-pill-info-bg)", color: "var(--qb-pill-info-fg)", text: "连通：检测中…" }
                    : probe?.status === "ok"
                      ? {
                          bg: "var(--qb-pill-success-bg)",
                          color: "var(--qb-pill-success-fg)",
                          text: `连通：可用${probe.message ? ` · ${shortMsg(probe.message)}` : ""}`,
                        }
                      : probe?.status === "error"
                        ? {
                            bg: "var(--qb-pill-error-bg)",
                            color: "var(--qb-pill-error-fg)",
                            text: `连通：失败${probe.message ? ` · ${shortMsg(probe.message)}` : ""}`,
                          }
                        : specOk && bindCount > 0
                          ? { bg: "var(--qb-pill-muted-bg)", color: "var(--qb-pill-muted-fg)", text: "连通：打开卡片以检测" }
                          : {
                              bg: "var(--qb-pill-muted-bg)",
                              color: "var(--qb-pill-muted-fg)",
                              text: bindCount === 0 ? "连通：需 binding" : "连通：待检测",
                            };
                const dotColor =
                  probe?.status === "checking"
                    ? "#60a5fa"
                    : probe?.status === "ok"
                      ? "#22c55e"
                      : probe?.status === "error"
                        ? "#ef4444"
                        : !row.enabled
                          ? "#52525b"
                          : !specOk
                            ? "#f97316"
                            : bindCount === 0
                              ? "#a1a1aa"
                              : "#eab308";
                const selected = focusedMcpServerId === row.id && mcpAdvancedEditorOpen;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => openMcpAdvancedEditor(row)}
                    title="点击打开高级 JSON 编辑"
                    style={{
                      ...styles.card,
                      ...styles.mcpCardBtn,
                      ...(selected ? styles.mcpCardBtnSelected : {}),
                    }}
                  >
                    <div style={styles.mcpCardTopRow}>
                      <span
                        style={{
                          ...styles.mcpStatusDot,
                          background: dotColor,
                          boxShadow:
                            probe?.status === "checking" ? "0 0 0 3px rgba(96,165,250,0.35)" : undefined,
                        }}
                        aria-hidden
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.cardName}>{row.name}</div>
                        <div style={styles.cardDesc}>
                          {row.transport} · {row.enabled ? "启用" : "禁用"} · {bindCount} 个工具绑定
                        </div>
                        <div style={styles.cardDesc}>
                          {row.projectId ? `项目: ${row.projectId.slice(0, 8)}…` : "作用域: 全局"}
                        </div>
                      </div>
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

            <details className="qb-mcp-details" style={styles.mcpDetails}>
              <summary style={styles.mcpDetailsSummary}>快速添加 MCP Server（表单）</summary>
              <div style={{ ...styles.form, paddingBottom: 10 }}>
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
                <button className="qb-btn-secondary" type="button" onClick={() => void upsertMcpServerNow()}>
                  保存 Server
                </button>
              </div>
            </details>

            <details className="qb-mcp-details" style={styles.mcpDetails}>
              <summary style={styles.mcpDetailsSummary}>表单：工具绑定与快速测试</summary>
              <div style={{ ...styles.form, paddingBottom: 10, flexWrap: "wrap" }}>
                <select
                  style={styles.select}
                  value={selectedMcpServer}
                  onChange={(e) => setSelectedMcpServer(e.target.value)}
                >
                  {mcpServers.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name} · {s.transport}
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
                <button className="qb-btn-secondary" type="button" onClick={() => void saveMcpBindingNow()}>
                  保存绑定
                </button>
                <button className="qb-btn-primary-brand" type="button" onClick={() => void testMcpNow()}>
                  测试 MCP
                </button>
              </div>
            </details>

            <h3 style={{ ...styles.subTitle, marginTop: 18 }}>MCP 市场</h3>
            <p className="qb-config-hint">
              来自开放注册表的条目；卡片展示目录中的<strong>能力声明</strong>（capabilities、默认工具、启动命令摘要）。市场列表<strong>分页加载</strong>（每页 {MCP_MARKET_PAGE_SIZE} 条），避免一次渲染数千卡片卡顿。「同步目录」从官方 Registry 拉取元数据（可能较慢）；「搜索/刷新」仅查询本地已同步目录。
            </p>

            <details className="qb-mcp-details" style={styles.mcpDetails}>
              <summary style={styles.mcpDetailsSummary}>目录源与鉴权</summary>
              <div style={{ ...styles.form, paddingBottom: 8, flexWrap: "wrap" }}>
                <input
                  style={styles.input}
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder="source name"
                />
                <input
                  style={styles.input}
                  value={sourceBaseUrl}
                  onChange={(e) => setSourceBaseUrl(e.target.value)}
                  placeholder="source base url"
                />
                <select
                  style={styles.select}
                  value={sourceAuthType}
                  onChange={(e) => setSourceAuthType(e.target.value as "none" | "bearer" | "api_key")}
                >
                  <option value="none">none</option>
                  <option value="bearer">bearer</option>
                  <option value="api_key">api_key</option>
                </select>
                <input
                  style={styles.input}
                  value={sourceAuthRef}
                  onChange={(e) => setSourceAuthRef(e.target.value)}
                  placeholder="auth ref (optional)"
                />
                <button className="qb-btn-secondary" type="button" onClick={() => void saveSourceNow()}>
                  保存源
                </button>
              </div>
            </details>

            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 10 }}>
              <select style={styles.select} value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)}>
                {mcpSources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.isDefault ? "default" : "custom"} · {item.enabled ? "enabled" : "disabled"}
                  </option>
                ))}
              </select>
              <input
                style={styles.input}
                value={marketQuery}
                onChange={(e) => setMarketQuery(e.target.value)}
                placeholder="搜索名称 / slug / 描述"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void searchMarketNow();
                }}
              />
              <button
                className="qb-btn-secondary"
                type="button"
                disabled={mcpMarketLoading}
                onClick={() => void syncSourceNowAction()}
              >
                {mcpMarketLoading ? "同步中…" : "同步目录"}
              </button>
              <button
                className="qb-btn-primary-brand"
                type="button"
                disabled={mcpMarketLoading}
                onClick={() => void searchMarketNow()}
              >
                {mcpMarketLoading ? "加载中…" : "搜索"}
              </button>
            </div>

            <div style={{ ...styles.meta, marginBottom: 8 }}>
              {mcpMarketLoading
                ? "正在加载市场列表…"
                : `共 ${mcpMarketTotal.toLocaleString()} 条 · 第 ${mcpMarketPage} / ${mcpMarketTotalPages} 页`}
            </div>

            <div className="qb-mcp-market-grid" style={styles.mcpMarketGrid}>
              {!mcpMarketLoading && mcpMarketItems.length === 0 ? (
                <div className="qb-mcp-market-card qb-mcp-market-card--empty" style={{ ...styles.mcpMarketCard, color: "var(--qb-main-meta)" }}>暂无目录项，请先同步注册表或检查网络。</div>
              ) : null}
              {mcpMarketItems.map((item) => {
                const spec = (item.specJson ?? {}) as Record<string, unknown>;
                const caps = Array.isArray(spec["defaultCapabilitiesJson"])
                  ? (spec["defaultCapabilitiesJson"] as unknown[]).filter((x): x is string => typeof x === "string")
                  : [];
                const defaultTool = typeof spec["defaultToolName"] === "string" ? spec["defaultToolName"] : "";
                const cmdPreview = typeof spec["command"] === "string" ? spec["command"] : "";
                const riskBorder =
                  item.riskLevel === "high" ? "#991b1b" : item.riskLevel === "medium" ? "#a16207" : "#166534";
                const selected = selectedCatalogId === item.id;
                return (
                  <div
                    key={item.id}
                    role="button"
                    className={`qb-mcp-market-card${selected ? " qb-mcp-market-card--selected" : ""}`}
                    tabIndex={0}
                    onClick={() => {
                      setSelectedCatalogId(item.id);
                      setCatalogServerName(item.slug.replace(/[^a-z0-9_-]/gi, "-"));
                      if (defaultTool) setMcpToolName(defaultTool);
                      const to = spec["defaultTimeoutMs"];
                      if (typeof to === "number" && Number.isFinite(to)) setMcpTimeoutMs(to);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedCatalogId(item.id);
                        setCatalogServerName(item.slug.replace(/[^a-z0-9_-]/gi, "-"));
                      }
                    }}
                    style={{
                      ...styles.mcpMarketCard,
                      ...(selected ? {} : { borderColor: riskBorder }),
                    }}
                  >
                    <div style={styles.mcpMarketCardHeader}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="qb-mcp-market-card__title" style={{ ...styles.cardName, color: "var(--qb-body-fg)" }}>{item.name}</div>
                        <div className="qb-mcp-market-meta" style={styles.mcpMarketMeta}>
                          {item.provider} · v{item.version} · {item.transport}{" "}
                          <span
                            className="qb-mcp-market-risk"
                            style={{
                              ...styles.mcpMarketRisk,
                              background:
                                item.riskLevel === "high"
                                  ? "rgba(127,29,29,0.45)"
                                  : item.riskLevel === "medium"
                                    ? "rgba(133,77,14,0.45)"
                                    : "rgba(22,101,52,0.45)",
                            }}
                          >
                            风险 {item.riskLevel}
                          </span>
                        </div>
                      </div>
                    </div>
                    <p className="qb-mcp-market-desc" style={styles.mcpMarketDesc}>{item.description || "（无描述）"}</p>
                    <div style={styles.mcpMarketChips}>
                      {caps.length ? caps.map((c) => (
                        <span key={c} className="qb-mcp-market-chip" style={styles.mcpMarketChip}>
                          {c}
                        </span>
                      )) : (
                        <span className="qb-mcp-market-chip" style={{ ...styles.mcpMarketChip, opacity: 0.75 }}>未声明 capabilities</span>
                      )}
                      {defaultTool ? (
                        <span className="qb-mcp-market-chip" style={styles.mcpMarketChip}>默认工具: {defaultTool}</span>
                      ) : null}
                    </div>
                    {cmdPreview ? (
                      <div className="qb-mcp-market-cmd" style={styles.mcpMarketCmd} title={cmdPreview}>
                        {cmdPreview.length > 120 ? `${cmdPreview.slice(0, 120)}…` : cmdPreview}
                      </div>
                    ) : null}
                    <div style={styles.mcpMarketCardActions}>
                      <button
                        type="button"
                        className="qb-btn-primary-brand"
                        disabled={!currentProjectId}
                        onClick={(e) => {
                          e.stopPropagation();
                          void installMarketCatalogItem(item);
                        }}
                      >
                        安装到当前项目
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {mcpMarketTotalPages > 1 ? (
              <div style={{ ...styles.form, flexWrap: "wrap", marginTop: 10, marginBottom: 4, alignItems: "center" }}>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={mcpMarketLoading || mcpMarketPage <= 1}
                  onClick={() => void loadMcpMarketPage(mcpMarketPage - 1)}
                >
                  上一页
                </button>
                <span style={styles.chatMeta}>
                  第 {mcpMarketPage} / {mcpMarketTotalPages} 页
                </span>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={mcpMarketLoading || mcpMarketPage >= mcpMarketTotalPages}
                  onClick={() => void loadMcpMarketPage(mcpMarketPage + 1)}
                >
                  下一页
                </button>
              </div>
            ) : null}

            <div style={{ ...styles.form, flexWrap: "wrap", marginTop: 10 }}>
              <input
                style={styles.input}
                value={catalogServerName}
                onChange={(e) => setCatalogServerName(e.target.value)}
                placeholder="安装后的 server 名（可改）"
              />
              <button className="qb-btn-secondary" type="button" onClick={() => void installMarketItemNow()} disabled={!currentProjectId}>
                安装当前选中条目
              </button>
              <button className="qb-btn-primary-brand" type="button" onClick={() => void testProjectInstallNow()}>
                测试最近安装
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {mcpMarketInstalls.map((row) => (
                <div key={row.id} style={styles.form}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {row.serverName} · {row.installStatus}
                  </span>
                  <button
                    type="button"
                    className="qb-btn-secondary"
                    onClick={() => void uninstallMarketInstallNow(row.id)}
                    disabled={!currentProjectId}
                  >
                    卸载
                  </button>
                </div>
              ))}
            </div>

            <details style={{ ...styles.mcpDetails, marginTop: 14 }}>
              <summary style={styles.mcpDetailsSummary}>高级：诊断与原始 JSON</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--qb-main-meta)" }}>最近一次操作 / 测试结果</div>
                <pre className="qb-config-stream-box">{mcpTestOutput || "暂无输出"}</pre>
                <details style={styles.mcpDetailsNested}>
                  <summary style={styles.mcpDetailsSummarySmall}>注册表源 (mcpSources)</summary>
                  <pre className="qb-config-stream-box">{JSON.stringify(mcpSources, null, 2)}</pre>
                </details>
                <details style={styles.mcpDetailsNested}>
                  <summary style={styles.mcpDetailsSummarySmall}>市场安装记录</summary>
                  <pre className="qb-config-stream-box">{JSON.stringify(mcpMarketInstalls, null, 2)}</pre>
                </details>
                <details style={styles.mcpDetailsNested}>
                  <summary style={styles.mcpDetailsSummarySmall}>工具绑定列表</summary>
                  <pre className="qb-config-stream-box">{JSON.stringify(mcpBindings, null, 2)}</pre>
                </details>
              </div>
            </details>

            {mcpAdvancedEditorOpen && focusedMcpServerId ? (
              <div
                style={styles.mcpModalBackdrop}
                role="presentation"
                onClick={() => {
                  setMcpAdvancedEditorOpen(false);
                }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="mcp-adv-title"
                  style={styles.mcpModal}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div style={styles.mcpModalHeader}>
                    <h4 id="mcp-adv-title" style={{ margin: 0, fontSize: 15, color: "var(--qb-body-fg)" }}>
                      高级编辑 · {mcpServers.find((s) => s.id === focusedMcpServerId)?.name ?? ""}
                    </h4>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="qb-btn-secondary"
                        onClick={() => {
                          const row = mcpServers.find((s) => s.id === focusedMcpServerId);
                          if (!row) return;
                          void probeMcpServer(row, pickBindingForMcpServer(row.name));
                        }}
                      >
                        探测连通性
                      </button>
                      <button type="button" className="qb-btn-secondary" onClick={() => setMcpAdvancedEditorOpen(false)}>
                        关闭
                      </button>
                    </div>
                  </div>
                  <div style={styles.mcpModalBody}>
                    <p className="qb-config-hint qb-config-hint--tight">
                      编辑 <code style={{ fontSize: 11 }}>server</code> 与可选的 <code style={{ fontSize: 11 }}>binding</code>
                      。保存将调用 upsert 接口写入数据库。将 <code style={{ fontSize: 11 }}>binding</code> 设为{" "}
                      <code style={{ fontSize: 11 }}>null</code> 可仅更新 server（不删除已有绑定）。
                    </p>
                    {mcpAdvancedJsonError ? <div style={styles.errorBox}>{mcpAdvancedJsonError}</div> : null}
                    {(() => {
                      const row = mcpServers.find((s) => s.id === focusedMcpServerId);
                      const probe = row ? mcpProbeByServer[row.name] : undefined;
                      const showProbePanel =
                        probe?.status === "checking" ||
                        probe?.status === "ok" ||
                        probe?.status === "error" ||
                        Boolean(mcpTestOutput.trim());
                      if (!showProbePanel) return null;
                      const statusLabel =
                        probe?.status === "checking"
                          ? "检测中…"
                          : probe?.status === "ok"
                            ? "可用"
                            : probe?.status === "error"
                              ? "失败"
                              : "—";
                      const statusColor =
                        probe?.status === "checking"
                          ? "var(--qb-pill-info-fg, #93c5fd)"
                          : probe?.status === "ok"
                            ? "var(--qb-pill-success-fg, #86efac)"
                            : probe?.status === "error"
                              ? "var(--qb-pill-error-fg, #fca5a5)"
                              : "var(--qb-main-meta, #a1a1aa)";
                      const detailText =
                        mcpTestOutput.trim() || probe?.message?.trim() || "暂无详情";
                      return (
                        <div
                          style={{
                            ...styles.mcpProbePanel,
                            borderColor:
                              probe?.status === "error"
                                ? "var(--qb-config-error-border, #7f1d1d)"
                                : probe?.status === "ok"
                                  ? "var(--qb-pill-success-border, #14532d)"
                                  : "var(--qb-mcp-json-border, #27272a)",
                          }}
                        >
                          <div style={styles.mcpProbePanelHeader}>
                            <span style={{ fontWeight: 600, color: "var(--qb-body-fg)" }}>连通性探测</span>
                            <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
                            {probe?.checkedAt ? (
                              <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
                                {new Date(probe.checkedAt).toLocaleString()}
                              </span>
                            ) : null}
                          </div>
                          <pre style={styles.mcpProbeFullMsg}>{detailText}</pre>
                          {mcpTestOutput.trim() &&
                          probe?.message?.trim() &&
                          mcpTestOutput.trim() !== probe.message.trim() ? (
                            <>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "var(--qb-main-meta)",
                                  marginTop: 8,
                                  marginBottom: 4,
                                }}
                              >
                                原始响应
                              </div>
                              <pre style={styles.mcpProbeFullMsg}>{mcpTestOutput}</pre>
                            </>
                          ) : null}
                        </div>
                      );
                    })()}
                    <textarea
                      style={styles.mcpJsonTextarea}
                      value={mcpAdvancedJsonDraft}
                      onChange={(e) => setMcpAdvancedJsonDraft(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <div style={styles.mcpModalFooter}>
                    <button type="button" className="qb-btn-secondary" onClick={() => setMcpAdvancedEditorOpen(false)}>
                      取消
                    </button>
                    <button type="button" className="qb-btn-primary-brand" onClick={() => void saveMcpAdvancedJson()}>
                      保存 JSON
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {activeConfigSubPage === "skills" ? (
          <>
            <h3 style={styles.subTitle}>Skills 与市场</h3>
            <p className="qb-config-hint">
              默认使用{" "}
              <a href="https://skillsmp.com/docs/api" target="_blank" rel="noreferrer">
                SkillsMP
              </a>{" "}
              实时搜索（与 Claude Code / Codex 等生态兼容）。可选加载{" "}
              <a href="https://github.com/coolzwc/open-skill-market" target="_blank" rel="noreferrer">
                Open Skill Market
              </a>{" "}
              全量 <code>skills.json</code>（体积大、首次较慢）。MCP 目录默认对接 Anthropic 官方{" "}
              <a href="https://registry.modelcontextprotocol.io/docs" target="_blank" rel="noreferrer">
                MCP Registry
              </a>{" "}
              （<code>v0.1/servers</code>）。服务端可配置环境变量 <code>SKILLSMP_API_KEY</code> 提高 SkillsMP 配额。
            </p>
            <div style={styles.meta}>
              <span>Open 索引: {skillMarketStatus?.loaded ? "已加载" : "未加载"}</span>
              <span>Open 条目数: {skillMarketStatus?.skillCount ?? "—"}</span>
              <span>SkillsMP 缓存 id: {skillMarketStatus?.skillsmpCacheSize ?? 0}</span>
              <span>项目安装: {skillInstalls.length}</span>
            </div>
            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 12 }}>
              <button
                type="button"
                className="qb-btn-secondary"
                disabled={skillRefreshBusy}
                onClick={() => {
                  setSkillRefreshBusy(true);
                  void refreshSkillMarketRegistry({ provider: "skillsmp" })
                    .then(setSkillMarketStatus)
                    .finally(() => setSkillRefreshBusy(false));
                }}
              >
                {skillRefreshBusy ? "刷新中…" : "连通 SkillsMP"}
              </button>
              <button
                type="button"
                className="qb-btn-secondary"
                disabled={skillRefreshBusy}
                onClick={() => {
                  setSkillRefreshBusy(true);
                  void refreshSkillMarketRegistry({ provider: "open" })
                    .then(setSkillMarketStatus)
                    .finally(() => setSkillRefreshBusy(false));
                }}
              >
                加载 Open Skill Market 全量索引
              </button>
              <button
                type="button"
                className="qb-btn-ghost qb-btn--compact"
                onClick={() => void getSkillMarketStatus().then(setSkillMarketStatus)}
              >
                刷新状态
              </button>
            </div>
            <h4 style={{ ...styles.subTitle, fontSize: 14, margin: "14px 0 8px" }}>手工添加 Skill</h4>
            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <input
                style={{ ...styles.input, minWidth: 180 }}
                value={manualSkillName}
                onChange={(e) => setManualSkillName(e.target.value)}
                placeholder="skill name / id"
              />
              <input
                style={{ ...styles.input, minWidth: 260, flex: "1 1 260px" }}
                value={manualSkillDescription}
                onChange={(e) => setManualSkillDescription(e.target.value)}
                placeholder="说明（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 220 }}
                value={manualSkillRepo}
                onChange={(e) => setManualSkillRepo(e.target.value)}
                placeholder="repo URL（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 180 }}
                value={manualSkillPath}
                onChange={(e) => setManualSkillPath(e.target.value)}
                placeholder="repo path（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 220 }}
                value={manualSkillLocalPath}
                onChange={(e) => setManualSkillLocalPath(e.target.value)}
                placeholder="local path（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 180 }}
                value={manualSkillTags}
                onChange={(e) => setManualSkillTags(e.target.value)}
                placeholder="tags，逗号分隔"
              />
              <button
                type="button"
                className="qb-btn-primary-brand"
                disabled={!currentProjectId || !manualSkillName.trim()}
                onClick={() => void installManualSkillNow()}
              >
                添加到项目
              </button>
            </div>
            {manualSkillError ? <div style={styles.errorBox}>{manualSkillError}</div> : null}
            <h4 style={{ ...styles.subTitle, fontSize: 14, margin: "14px 0 8px" }}>搜索市场</h4>
            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <label style={{ ...styles.chatMeta, display: "flex", alignItems: "center", gap: 6 }}>
                来源
                <select
                  value={skillMarketProvider}
                  onChange={(e) => setSkillMarketProvider(e.target.value as "skillsmp" | "open")}
                  style={{ ...styles.input, maxWidth: 200 }}
                >
                  <option value="skillsmp">SkillsMP（默认）</option>
                  <option value="open">Open Skill Market（本地索引）</option>
                </select>
              </label>
              <input
                style={{ ...styles.input, minWidth: 220, flex: "1 1 200px" }}
                value={skillSearchQ}
                onChange={(e) => setSkillSearchQ(e.target.value)}
                placeholder={
                  skillMarketProvider === "skillsmp"
                    ? "关键词（SkillsMP 实时搜索）"
                    : "关键词：名称、描述、仓库、标签…（需先加载全量索引）"
                }
              />
              <button
                type="button"
                className="qb-btn-primary-brand"
                disabled={skillSearchBusy}
                onClick={() => void searchSkillMarketNow()}
              >
                {skillSearchBusy ? "搜索中…" : "搜索"}
              </button>
            </div>
            <div style={{ ...styles.meta, marginBottom: 8 }}>
              {skillSearchBusy
                ? "正在搜索…"
                : skillSearchHits.length > 0 || skillMarketTotal > 0
                  ? `共 ${skillMarketTotal.toLocaleString()} 条 · 第 ${skillMarketPage} / ${skillMarketTotalPages} 页`
                  : "输入关键词后搜索"}
            </div>
            <div style={{ overflowX: "auto", marginBottom: 18 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                    <th style={{ padding: "6px 8px" }}>name</th>
                    <th style={{ padding: "6px 8px" }}>描述</th>
                    <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>★ Stars</th>
                    <th style={{ padding: "6px 8px" }}>仓库</th>
                    <th style={{ padding: "6px 8px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {skillSearchBusy ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                        加载中…
                      </td>
                    </tr>
                  ) : skillSearchHits.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                        无结果。SkillsMP 需网络可达；Open Skill Market 请先点击「加载全量索引」后再搜索。
                      </td>
                    </tr>
                  ) : (
                    /*
                     * 按 stars 降序展示。SkillsMP API 本身已按 stars 排序，但 Open Skill Market
                     * 的本地索引是任意顺序，统一在前端做一次排序，保证两种来源体验一致。
                     */
                    [...skillSearchHits]
                      .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
                      .map((row) => (
                        <tr key={row.id} style={{ borderTop: "1px solid #27272a", color: "var(--qb-body-fg)" }}>
                          <td style={{ padding: "8px", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                            {row.name}
                          </td>
                          <td style={{ padding: "8px", maxWidth: 360 }}>
                            {row.description.length > 160 ? `${row.description.slice(0, 160)}…` : row.description}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                              color: row.stars != null ? "var(--qb-body-fg)" : "var(--qb-main-meta)",
                            }}
                            title={row.stars != null ? `GitHub stars: ${row.stars}` : "GitHub stars 未知"}
                          >
                            {row.stars != null ? row.stars.toLocaleString() : "—"}
                          </td>
                          <td style={{ padding: "8px", wordBreak: "break-all", maxWidth: 320 }}>
                            {row.repo ? (
                              <a
                                href={row.repo}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--qb-link, #60a5fa)" }}
                              >
                                {row.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              disabled={!currentProjectId}
                              title={!currentProjectId ? "需先加载工作区项目" : undefined}
                              onClick={() =>
                                currentProjectId &&
                                void installSkillFromMarket({
                                  projectId: currentProjectId,
                                  externalSkillId: row.id,
                                }).then(() =>
                                  listSkillMarketInstalls(currentProjectId).then(setSkillInstalls)
                                )
                              }
                            >
                              安装到项目
                            </button>
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
            {skillMarketTotalPages > 1 ? (
              <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={skillSearchBusy || skillMarketPage <= 1}
                  onClick={() => void loadSkillMarketPage(skillMarketPage - 1)}
                >
                  上一页
                </button>
                <span style={styles.chatMeta}>
                  第 {skillMarketPage} / {skillMarketTotalPages} 页
                </span>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={skillSearchBusy || skillMarketPage >= skillMarketTotalPages}
                  onClick={() => void loadSkillMarketPage(skillMarketPage + 1)}
                >
                  下一页
                </button>
              </div>
            ) : null}
            <h4 style={{ ...styles.subTitle, fontSize: 14, margin: "14px 0 8px" }}>本项目已安装</h4>
            {!currentProjectId ? (
              <p className="qb-config-hint">加载配置后可按项目记录安装；请先进入配置中心触发加载。</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                      <th style={{ padding: "6px 8px" }}>skill_name</th>
                      <th style={{ padding: "6px 8px" }}>说明</th>
                      <th style={{ padding: "6px 8px" }}>来源</th>
                      <th style={{ padding: "6px 8px" }}>registry id</th>
                      <th style={{ padding: "6px 8px" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillInstalls.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                          尚未从市场安装任何技能。
                        </td>
                      </tr>
                    ) : (
                      skillInstalls.map((row) => (
                        <tr key={row.id} style={{ borderTop: "1px solid #27272a", color: "var(--qb-body-fg)" }}>
                          <td style={{ padding: "8px", fontFamily: "ui-monospace, monospace" }}>{row.skillName}</td>
                          <td style={{ padding: "8px", maxWidth: 280 }}>
                            {row.description.length > 120 ? `${row.description.slice(0, 120)}…` : row.description}
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            {/* 直接复用 OriginBadge 的 SkillsMP / Open Skill Market 预设；其它 registry 名也能兜底渲染 */}
                            <OriginBadge origin={row.registry} style={{ marginLeft: 0 }} />
                          </td>
                          <td style={{ padding: "8px", wordBreak: "break-all", fontSize: 11 }}>{row.externalSkillId}</td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              onClick={() => void navigator.clipboard.writeText(row.skillName)}
                            >
                              复制 name
                            </button>
                            <button
                              type="button"
                              className="qb-btn-secondary qb-btn--compact"
                              disabled={
                                !definitions.find((b) => b.definition.id === skillAppendDefinitionId)?.draft
                              }
                              title={
                                !definitions.find((b) => b.definition.id === skillAppendDefinitionId)?.draft
                                  ? "请先在 Agent 页为该定义保存草稿"
                                  : undefined
                              }
                              onClick={() => {
                                const defId = skillAppendDefinitionId;
                                if (!defId) return;
                                const bundle = definitions.find((b) => b.definition.id === defId);
                                if (!bundle?.draft) return;
                                void appendAgentDraftSkills(defId, [row.skillName])
                                  .then(() => listAgentDefinitions())
                                  .then(setDefinitions);
                              }}
                            >
                              追加到草稿
                            </button>
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              onClick={() =>
                                void deleteSkillMarketInstall(currentProjectId, row.id).then(() =>
                                  listSkillMarketInstalls(currentProjectId).then(setSkillInstalls)
                                )
                              }
                            >
                              移除
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ ...styles.form, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--qb-main-meta)" }}>追加到 Agent 草稿时选择：</span>
              {definitions.length === 0 ? (
                <span className="qb-config-hint">无 Agent 定义</span>
              ) : (
                <select
                  style={styles.select}
                  value={skillAppendDefinitionId}
                  onChange={(e) => setSkillAppendDefinitionId(e.target.value)}
                >
                  {definitions.map((b) => (
                    <option key={b.definition.id} value={b.definition.id}>
                      {b.profile?.displayName?.trim() || b.definition.name} · {b.definition.role}
                      {b.draft ? "" : "（无草稿）"}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                margin: "20px 0 8px",
              }}
            >
              <h4 style={{ ...styles.subTitle, fontSize: 14, margin: 0 }}>
                归纳与演化（agent_skill）
              </h4>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--qb-main-meta)",
                }}
              >
                <input
                  type="checkbox"
                  checked={skillLibraryIncludeArchived}
                  onChange={(e) => setSkillLibraryIncludeArchived(e.target.checked)}
                />
                显示已归档
              </label>
            </div>
            <p className="qb-config-hint" style={{ margin: "0 0 8px" }}>
              Agent 在执行复杂任务后由 curator 沉淀的程序性记忆，以及 evolver
              基于 baseline 突变得到的演化版本（类 Hermes / GEPA 机制）。pending_review
              的演化产物需要审批后才会转 active。
            </p>
            {!currentProjectId ? (
              <p className="qb-config-hint">加载配置后可按项目记录归纳；请先进入配置中心触发加载。</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                      <th style={{ padding: "6px 8px" }}>name</th>
                      <th style={{ padding: "6px 8px" }}>描述</th>
                      <th style={{ padding: "6px 8px" }}>来源</th>
                      <th style={{ padding: "6px 8px" }}>状态</th>
                      <th style={{ padding: "6px 8px" }}>version</th>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>使用 / 成功</th>
                      <th style={{ padding: "6px 8px" }}>最近使用</th>
                      <th style={{ padding: "6px 8px" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillLibrary.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                          暂无 agent_skill 记录。等待 Agent 在工作流里触发 curator/evolver，或在
                          运维脚本里执行 `bun run src/scripts/run-skill-curator.ts`。
                        </td>
                      </tr>
                    ) : (
                      skillLibrary.map((s) => {
                        const reviewing = s.state === "pending_review";
                        return (
                          <tr
                            key={s.id}
                            style={{
                              borderTop: "1px solid #27272a",
                              color: "var(--qb-body-fg)",
                              opacity: s.state === "archived" ? 0.55 : 1,
                            }}
                          >
                            <td
                              style={{
                                padding: "8px",
                                fontFamily: "ui-monospace, monospace",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {s.pinned ? "★ " : ""}
                              {s.name}
                            </td>
                            <td style={{ padding: "8px", maxWidth: 320 }}>
                              {s.description.length > 140
                                ? `${s.description.slice(0, 140)}…`
                                : s.description}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              <OriginBadge origin={s.source} style={{ marginLeft: 0 }} />
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                whiteSpace: "nowrap",
                                color: reviewing
                                  ? "#f87171"
                                  : s.state === "archived"
                                    ? "var(--qb-main-meta)"
                                    : "var(--qb-body-fg)",
                              }}
                            >
                              {s.state}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{s.version}</td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              {s.useCount} / {s.successCount}
                              {s.failCount > 0 ? (
                                <span style={{ color: "#fca5a5" }}> · 失败 {s.failCount}</span>
                              ) : null}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                whiteSpace: "nowrap",
                                color: "var(--qb-main-meta)",
                              }}
                            >
                              {s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "—"}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              <button
                                type="button"
                                className="qb-btn-ghost qb-btn--compact"
                                onClick={() => {
                                  const preview = s.bodyMd?.slice(0, 4000) || "(empty)";
                                  window.alert(`# ${s.name}\n\n${preview}`);
                                }}
                              >
                                查看
                              </button>
                              <button
                                type="button"
                                className="qb-btn-ghost qb-btn--compact"
                                onClick={() =>
                                  void patchAgentSkill(s.id, { pinned: !s.pinned })
                                    .then(() =>
                                      listSkillLibrary(currentProjectId, {
                                        includeArchived: skillLibraryIncludeArchived,
                                      })
                                    )
                                    .then(setSkillLibrary)
                                }
                              >
                                {s.pinned ? "取消置顶" : "置顶"}
                              </button>
                              {reviewing ? (
                                <button
                                  type="button"
                                  className="qb-btn-secondary qb-btn--compact"
                                  onClick={() =>
                                    void patchAgentSkill(s.id, { state: "active" })
                                      .then(() =>
                                        listSkillLibrary(currentProjectId, {
                                          includeArchived: skillLibraryIncludeArchived,
                                        })
                                      )
                                      .then(setSkillLibrary)
                                  }
                                >
                                  审批通过
                                </button>
                              ) : null}
                              {s.state !== "archived" ? (
                                <button
                                  type="button"
                                  className="qb-btn-ghost qb-btn--compact"
                                  onClick={() =>
                                    void patchAgentSkill(s.id, { state: "archived" })
                                      .then(() =>
                                        listSkillLibrary(currentProjectId, {
                                          includeArchived: skillLibraryIncludeArchived,
                                        })
                                      )
                                      .then(setSkillLibrary)
                                  }
                                >
                                  归档
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="qb-btn-ghost qb-btn--compact"
                                  onClick={() =>
                                    void patchAgentSkill(s.id, { state: "active" })
                                      .then(() =>
                                        listSkillLibrary(currentProjectId, {
                                          includeArchived: skillLibraryIncludeArchived,
                                        })
                                      )
                                      .then(setSkillLibrary)
                                  }
                                >
                                  恢复
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
        {activeConfigSubPage === "schedule" ? (
          <ScheduledJobsPanel workspaceId={currentWorkspaceId || undefined} projectId={currentProjectId || null} />
        ) : null}
        {activeConfigSubPage === "runtime" ? (
          <>
            <h3 style={styles.subTitle}>系统运行时</h3>
            <p className="qb-config-hint">
              展示 Python 沙箱（code.run_python 与 qlib/signal/backtest 算子共用）的解释器路径和关键依赖。
              红灯时沙箱会 fail-fast 拒绝执行；黄灯（可选依赖缺失）只影响部分高级能力。
            </p>
            <PythonRuntimeCard />
          </>
        ) : null}
        {activeConfigSubPage === "providers" ? <ProvidersPanel /> : null}
        {activeConfigSubPage === "integration" ? (
          <IntegrationCenterPanel
            workspaceId={currentWorkspaceId || undefined}
            projectId={currentProjectId || null}
          />
        ) : null}
        {activeConfigSubPage === "agent" ? (
          <ConfigAgentPanel
            definitions={definitions}
            selectedDefinitionId={selectedDefinitionId}
            onSelectDefinitionId={setSelectedDefinitionId}
            onResetAgentSelectionRef={() => {
              prevAgentDefId.current = "";
            }}
            onReloadAll={() => void loadConfig()}
            onPreferAgentAfterReload={(id) => {
              preferAgentDefinitionIdRef.current = id;
            }}
            onOpenMcpSubPage={setConfigSubPage}
            agentUiTab={agentUiTab}
            setAgentUiTab={setAgentUiTab}
            selectedBundle={selectedBundle}
            agentPack={agentPack}
            agentMemoryStats={agentMemoryStats}
            draftPrompt={draftPrompt}
            setDraftPrompt={setDraftPrompt}
            draftSoul={draftSoul}
            setDraftSoul={setDraftSoul}
            draftPromptTemplateRef={draftPromptTemplateRef}
            setDraftPromptTemplateRef={setDraftPromptTemplateRef}
            draftNote={draftNote}
            setDraftNote={setDraftNote}
            draftPromptMode={draftPromptMode}
            setDraftPromptMode={setDraftPromptMode}
            draftMemoryNamespace={draftMemoryNamespace}
            setDraftMemoryNamespace={setDraftMemoryNamespace}
            draftConfigRootUri={draftConfigRootUri}
            setDraftConfigRootUri={setDraftConfigRootUri}
            draftMcpServerNames={draftMcpServerNames}
            setDraftMcpServerNames={setDraftMcpServerNames}
            draftDisplayName={draftDisplayName}
            setDraftDisplayName={setDraftDisplayName}
            draftDescription={draftDescription}
            setDraftDescription={setDraftDescription}
            draftTools={draftTools}
            setDraftTools={setDraftTools}
            draftMaxIterations={draftMaxIterations}
            setDraftMaxIterations={setDraftMaxIterations}
            draftSkills={draftSkills}
            setDraftSkills={setDraftSkills}
            draftSubscriptions={draftSubscriptions}
            setDraftSubscriptions={setDraftSubscriptions}
            skillInstalls={skillInstalls}
            knownToolPool={knownToolPool}
            fileSoulMd={fileSoulMd}
            setFileSoulMd={setFileSoulMd}
            filePromptMd={filePromptMd}
            setFilePromptMd={setFilePromptMd}
            fileAgentMd={fileAgentMd}
            setFileAgentMd={setFileAgentMd}
            fileUserMd={fileUserMd}
            setFileUserMd={setFileUserMd}
            fileMemoryMd={fileMemoryMd}
            setFileMemoryMd={setFileMemoryMd}
            mcpServers={mcpServers}
            mcpBindings={mcpBindings}
            currentProjectId={currentProjectId}
            pickBindingForMcpServer={pickBindingForMcpServer}
            mcpServerBindingCount={mcpServerBindingCount}
          />
        ) : null}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  main: { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: 24 },
  /** 对话页：占满主区、禁止整页横向滚动，三栏各自纵向滚动 */
  mainChat: {
    flex: 1,
    width: "100%",
    maxWidth: "100%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 16,
  },
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
  /** 实时交易 Agent：四段布局（配置 / 对话流 / K线+快捷） */
  mainTrader: {
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
    background: "var(--qb-ide-chrome-border, #27272a)",
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
    background: "var(--qb-ide-chrome-border, #27272a)",
    alignSelf: "stretch",
  },
  title: { fontSize: 26, fontWeight: 700, margin: "0 0 8px", color: "var(--qb-body-fg)" },
  subTitle: { fontSize: 16, margin: "16px 0 8px", color: "var(--qb-body-fg)" },
  form: { display: "flex", gap: 8, marginBottom: 10 },
  input: {
    flex: 1,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  textarea: {
    width: "100%",
    minHeight: 140,
    resize: "vertical",
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 8,
  },
  select: {
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  actions: { display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" },
  meta: { display: "flex", gap: 12, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  configPageBody: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 0,
    width: "100%",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 },
  card: {
    background: "var(--qb-main-card-bg, #18181b)",
    border: "1px solid var(--qb-main-card-border, #27272a)",
    borderRadius: 8,
    padding: 12,
  },
  cardButton: {
    background: "var(--qb-main-card-bg, #18181b)",
    border: "1px solid var(--qb-main-card-border, #27272a)",
    borderRadius: 8,
    padding: 12,
    textAlign: "left",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    cursor: "pointer",
  },
  cardName: { fontSize: 13, fontWeight: 600, color: "var(--qb-card-name, #a78bfa)" },
  cardDesc: { fontSize: 12, color: "var(--qb-card-desc, #a1a1aa)", overflowWrap: "anywhere", wordBreak: "break-word" },
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
    borderColor: "var(--qb-blue)",
    boxShadow: "0 0 0 1px var(--qb-focus-ring)",
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
  mcpCardTopRow: { display: "flex", alignItems: "flex-start", gap: 10 },
  mcpStatusDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0, marginTop: 4 },
  mcpDetails: {
    marginBottom: 12,
    border:
      "1px solid var(--qb-mcp-details-border, var(--qb-sidebar-border, #27272a))",
    borderRadius: 8,
    padding: "0 12px",
    background:
      "var(--qb-mcp-details-bg, var(--qb-sidebar-nav-bg, #111114))",
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  mcpDetailsSummary: {
    cursor: "pointer",
    padding: "10px 0",
    fontSize: 13,
    color: "var(--qb-main-meta, #a1a1aa)",
    userSelect: "none",
    listStyle: "none",
  } as CSSProperties,
  mcpDetailsSummarySmall: {
    cursor: "pointer",
    padding: "6px 0",
    fontSize: 12,
    color: "var(--qb-main-meta, #71717a)",
    userSelect: "none",
  } as CSSProperties,
  mcpDetailsNested: {
    border:
      "1px solid var(--qb-mcp-details-border, var(--qb-sidebar-border, #27272a))",
    borderRadius: 6,
    padding: "0 10px",
    background:
      "var(--qb-mcp-details-nested-bg, var(--qb-main-card-bg, #0c0c0e))",
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  mcpMarketGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))",
    gap: 12,
  },
  mcpMarketCard: {
    background:
      "var(--qb-mcp-market-card-bg, var(--qb-main-card-bg, #18181b))",
    border:
      "1px solid var(--qb-mcp-market-card-border, var(--qb-main-card-border, var(--qb-sidebar-border, #27272a)))",
    color: "var(--qb-body-fg, #e4e4e7)",
    borderRadius: 10,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    cursor: "pointer",
    textAlign: "left",
    transition: "border-color 0.15s ease",
  },
  mcpMarketCardHeader: { display: "flex", alignItems: "flex-start", gap: 8 },
  mcpMarketMeta: {
    fontSize: 11,
    color: "var(--qb-mcp-market-meta, var(--qb-main-meta, #a1a1aa))",
    marginTop: 4,
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  mcpMarketRisk: {
    fontSize: 10,
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: 4,
    color: "#fafafa",
  },
  mcpMarketDesc: {
    fontSize: 12,
    color: "var(--qb-mcp-market-desc, var(--qb-body-fg, #d4d4d8))",
    margin: 0,
    lineHeight: 1.45,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  } as CSSProperties,
  mcpMarketChips: { display: "flex", flexWrap: "wrap", gap: 6 },
  mcpMarketChip: {
    fontSize: 10,
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: 999,
    background:
      "var(--qb-mcp-market-chip-bg, var(--qb-pill-muted-bg, #27272a))",
    color: "var(--qb-mcp-market-chip-fg, var(--qb-body-fg, #e4e4e7))",
    border:
      "1px solid var(--qb-mcp-market-chip-border, var(--qb-sidebar-border, #3f3f46))",
  },
  mcpMarketCmd: {
    fontSize: 11,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
    color: "var(--qb-mcp-market-cmd-fg, var(--qb-main-meta, #a1a1aa))",
    background:
      "var(--qb-mcp-market-cmd-bg, var(--qb-sidebar-explorer-bg, #09090b))",
    borderRadius: 6,
    padding: "6px 8px",
    border:
      "1px solid var(--qb-mcp-market-cmd-border, var(--qb-sidebar-border, #27272a))",
    wordBreak: "break-all",
  },
  mcpMarketCardActions: { marginTop: "auto", paddingTop: 4 },
  mcpModalBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 200,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  mcpModal: {
    width: "min(760px, 100%)",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--qb-modal-bg, var(--qb-main-card-bg, #111114))",
    border:
      "1px solid var(--qb-modal-border, var(--qb-main-card-border, var(--qb-sidebar-border, #3f3f46)))",
    color: "var(--qb-body-fg, #e4e4e7)",
    borderRadius: 12,
    boxShadow: "0 24px 48px rgba(0,0,0,0.45)",
  },
  mcpModalHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
    padding: "12px 14px",
    borderBottom:
      "1px solid var(--qb-modal-sep, var(--qb-sidebar-border, #27272a))",
  },
  mcpModalBody: { padding: 12, overflow: "auto", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
  mcpModalFooter: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    padding: "10px 14px",
    borderTop:
      "1px solid var(--qb-modal-sep, var(--qb-sidebar-border, #27272a))",
  },
  mcpProbePanel: {
    marginBottom: 10,
    padding: "10px 12px",
    borderRadius: 8,
    border:
      "1px solid var(--qb-mcp-json-border, var(--qb-sidebar-border, #27272a))",
    background: "var(--qb-stream-box-bg, var(--qb-sidebar-explorer-bg, #09090b))",
    color: "var(--qb-stream-box-fg, var(--qb-body-fg, #d4d4d8))",
    flexShrink: 0,
  },
  mcpProbePanelHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 8,
    fontSize: 12,
  },
  mcpProbeFullMsg: {
    margin: 0,
    maxHeight: 220,
    overflow: "auto",
    fontSize: 11,
    lineHeight: 1.5,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    color: "var(--qb-stream-box-fg, var(--qb-body-fg, #d4d4d8))",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  mcpJsonTextarea: {
    width: "100%",
    minHeight: 320,
    flex: 1,
    resize: "vertical",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.45,
    background:
      "var(--qb-mcp-json-bg, var(--qb-main-input-bg, var(--qb-sidebar-explorer-bg, #09090b)))",
    border:
      "1px solid var(--qb-mcp-json-border, var(--qb-main-input-border, var(--qb-sidebar-border, #27272a)))",
    color: "var(--qb-mcp-json-fg, var(--qb-body-fg, #e4e4e7))",
    borderRadius: 8,
    padding: 10,
  },
  streamBox: {
    background:
      "var(--qb-stream-box-bg, var(--qb-sidebar-explorer-bg, #09090b))",
    border:
      "1px solid var(--qb-stream-box-border, var(--qb-sidebar-border, #27272a))",
    borderRadius: 8,
    padding: 10,
    maxHeight: 260,
    overflow: "auto",
    color: "var(--qb-stream-box-fg, var(--qb-body-fg, #d4d4d8))",
    fontSize: 12,
    whiteSpace: "pre-wrap",
  },
  errorBox: {
    background:
      "var(--qb-config-error-bg, var(--qb-pill-error-bg, rgba(239,68,68,0.18)))",
    border:
      "1px solid var(--qb-config-error-border, var(--qb-pill-error-fg, rgba(239,68,68,0.5)))",
    color: "var(--qb-config-error-fg, var(--qb-pill-error-fg, #fecaca))",
    borderRadius: 8,
    padding: "8px 10px",
    marginBottom: 10,
  },
  configHint: {
    fontSize: 12,
    color: "var(--qb-main-meta, #a1a1aa)",
    margin: "0 0 10px",
    lineHeight: 1.5,
  },
  chatPageRoot: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    background: "var(--qb-chat-page-bg)",
    width: "100%",
    maxWidth: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  chatChrome: {
    flexShrink: 0,
    minWidth: 0,
  },
  chatLayout: {
    display: "grid",
    /** 列宽由 ChatPanel 内联 gridTemplateColumns 控制（会话列表 px + 拖拽条 + 主区 + 可选看板） */
    gridTemplateRows: "minmax(0, 1fr)",
    gap: 10,
    flex: 1,
    width: "100%",
    maxWidth: "100%",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    alignContent: "stretch",
  },
  chatLayoutIde: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    width: "100%",
    maxWidth: "100%",
    gridTemplateRows: "minmax(0, 1fr)",
    gap: 8,
  },
  chatColResizer: {
    margin: 0,
    padding: 0,
    border: "none",
    width: 6,
    minWidth: 6,
    maxWidth: 6,
    borderRadius: 4,
    cursor: "col-resize",
    touchAction: "none",
    background: "var(--qb-chat-resizer-bg, #27272a)",
    alignSelf: "stretch",
    flexShrink: 0,
    opacity: 0.55,
  } satisfies CSSProperties,
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
    color: "var(--qb-chat-ide-header-fg, #a1a1aa)",
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-chat-border, #27272a)",
    background: "var(--qb-chat-ide-header-bg, #111114)",
  },
  chatSidebar: {
    border: "1px solid var(--qb-chat-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    background: "var(--qb-chat-sidebar-bg, #111114)",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  chatSessionList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: 8,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
  },
  chatSessionItem: {
    border: "1px solid var(--qb-chat-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-chat-session-item-bg, #18181b)",
    color: "var(--qb-chat-session-item-fg, #e4e4e7)",
    textAlign: "left",
    padding: "8px 10px",
    cursor: "pointer",
  },
  chatSessionItemActive: {
    borderColor: "var(--qb-chat-session-active-border, #7c3aed)",
    background: "var(--qb-chat-session-active-bg, transparent)",
  },
  chatMain: {
    border: "1px solid var(--qb-chat-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    background: "var(--qb-chat-main-bg, #111114)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    flex: 1,
  },
  chatBoardToggleRow: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    flexShrink: 0,
    marginBottom: 6,
    minWidth: 0,
  },
  chatMessages: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    overflowX: "hidden",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 10,
  },
  chatForm: {
    display: "flex",
    gap: 8,
    marginBottom: 0,
    flexShrink: 0,
    minWidth: 0,
  },
  chatBubble: {
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--qb-chat-bubble-border, #27272a)",
    minWidth: 0,
    boxSizing: "border-box",
  },
  chatBubbleUser: {
    background: "var(--qb-chat-bubble-user-bg, #27272a)",
    color: "var(--qb-chat-bubble-user-fg, #fafafa)",
    alignSelf: "flex-end",
    maxWidth: "min(82%, 100%)",
  },
  chatBubbleAgent: {
    background: "var(--qb-chat-bubble-agent-bg, #18181b)",
    color: "var(--qb-chat-bubble-agent-fg, #e4e4e7)",
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  chatMeta: { fontSize: 11, color: "var(--qb-chat-meta-fg, var(--qb-main-meta, #a1a1aa))", marginBottom: 4 },
  chartCtxBanner: {
    fontSize: 12,
    color: "var(--qb-chat-chart-banner-fg, #a5b4fc)",
    background: "var(--qb-chat-chart-banner-bg, #1e1b4b)",
    border: "1px solid var(--qb-chat-chart-banner-border, #4338ca)",
    borderRadius: 8,
    padding: "8px 12px",
    marginBottom: 10,
  },
  boardCol: {
    border: "1px solid var(--qb-chat-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    background: "var(--qb-board-col-bg, #111114)",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  boardColHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    flexShrink: 0,
    marginBottom: 8,
    minWidth: 0,
  },
  boardColScroll: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
    overflowX: "hidden",
  },
  boardList: { display: "flex", flexDirection: "column", gap: 8 },
  boardCard: {
    background: "var(--qb-board-card-bg, #18181b)",
    border: "1px solid var(--qb-chat-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  boardRoleToggle: {
    display: "block",
    width: "100%",
    margin: 0,
    padding: 0,
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left" as const,
    font: "inherit",
  },
  boardNested: {
    marginTop: 10,
    paddingLeft: 8,
    borderLeft: "2px solid var(--qb-chat-border, #3f3f46)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  boardNestedRow: {
    paddingBottom: 8,
    borderBottom: "1px solid var(--qb-chat-border, #27272a)",
  },
  boardMono: {
    fontSize: 11,
    background: "var(--qb-main-input-bg, #18181b)",
    padding: "1px 4px",
    borderRadius: 4,
  },
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

function extractFencedCodeBlocks(report: string): Array<{ lang: string; code: string }> {
  if (!report?.trim()) return [];
  const re = /```(\w+)?\s*\n([\s\S]*?)```/g;
  const out: Array<{ lang: string; code: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(report)) !== null) {
    const lang = ((m[1] ?? "").trim() || "text").toLowerCase();
    const code = (m[2] ?? "").trim();
    if (!code) continue;
    out.push({ lang, code });
  }
  return out;
}

/** 研究团队中间栏侧栏自上而下：研究画布、成员目录、工具与配置 */
const TEAM_CENTER_VIEWS = ["research", "roles", "run"] as const;
type TeamCenterView = (typeof TEAM_CENTER_VIEWS)[number];
const TEAM_VIEW_TITLE: Record<TeamCenterView, string> = {
  run: "发起分析 · 工具与配置",
  research: "研究画布 · 拓扑 / 实时流 / 结论",
  roles: "成员目录",
};

/** 活动栏图标：Web 端用 Lucide 对齐 SF Symbols 语义（见 `appleUiSymbols.ts` 与 [SF Symbols](https://developer.apple.com/cn/sf-symbols/)）。 */
const TEAM_CENTER_GLYPH: Record<TeamCenterView, LucideIcon> = {
  run: Rocket,
  research: Network,
  roles: Users,
};

/** 画布可多选高亮的团队成员角色（与后端研究团队槽位一致；空集表示不过滤） */
/** 拓扑画布固定视口高度，避免 ResizeObserver↔SVG 高度互相撑开导致无限增高 */
const TEAM_GRAPH_VIEWPORT_HEIGHT = 360;

const TeamDashboardPanel: FC = () => {
  const [ticker, setTicker] = useState("AAPL");
  const [scopeMode, setScopeMode] = useState<ResearchScopeMode>("single");
  const [basketTickers, setBasketTickers] = useState("AAPL,MSFT,NVDA");
  const [sectorName, setSectorName] = useState("半导体");
  const [sectorPeers, setSectorPeers] = useState("NVDA,AMD,AVGO");
  const [researchInstrument, setResearchInstrument] = useState<ResearchInstrumentUi>("equity_long");
  const [optionUnderlying, setOptionUnderlying] = useState("");
  const [optionContract, setOptionContract] = useState("");
  const [optionExpiry, setOptionExpiry] = useState("");
  const [optionStrike, setOptionStrike] = useState("");
  const [optionRight, setOptionRight] = useState<"call" | "put" | "">("call");
  /** 传给后端的分析上下文（对应 runAnalystTeam.context）；空则后端使用默认 */
  const [teamAnalysisContext, setTeamAnalysisContext] = useState("");

  const researchScopePayload = useMemo(
    () =>
      buildResearchScopePayload({
        mode: scopeMode,
        ticker,
        basketTickers,
        sectorName,
        sectorPeers,
        instrument: researchInstrument,
        optionUnderlying,
        optionContract,
        optionExpiry,
        optionStrike,
        optionRight,
      }),
    [
      scopeMode,
      ticker,
      basketTickers,
      sectorName,
      sectorPeers,
      researchInstrument,
      optionUnderlying,
      optionContract,
      optionExpiry,
      optionStrike,
      optionRight,
    ]
  );
  const [workflowRunId, setWorkflowRunId] = useState("");
  const [workflowOptions, setWorkflowOptions] = useState<Array<Record<string, unknown>>>([]);
  const [workflowKindFilter, setWorkflowKindFilter] = useState<WorkflowKind | "all">("all");
  const [analystAgentGroupId, setAnalystAgentGroupId] = useState("");
  const [analystAgentGroupOptions, setAnalystAgentGroupOptions] = useState<AgentGroupRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AnalystTeamResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TeamCenterView>("research");
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
  const [teamGraphView, setTeamGraphView] = useState<"topology" | "office">("topology");
  const [participatingAnalystDefinitionIds, setParticipatingAnalystDefinitionIds] = useState<string[]>([]);
  const [strategyScripts, setStrategyScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [workflowArtifactHint, setWorkflowArtifactHint] = useState<string>("");
  const [teamCodePick, setTeamCodePick] = useState<string>("");
  const [agentDefBundles, setAgentDefBundles] = useState<AgentDefinitionBundle[] | null>(null);
  const [teamResearchProjectId, setTeamResearchProjectId] = useState("");
  const [teamResearchSessionId, setTeamResearchSessionId] = useState("");
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const setCfgSubPage = useAppStore((s) => s.setConfigSubPage);
  const setIdeSignalPythonCode = useAppStore((s) => s.setIdeSignalPythonCode);
  const setIdeStrategySource = useAppStore((s) => s.setIdeStrategySource);
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const toggleIdePanelVisible = useAppStore((s) => s.toggleIdePanelVisible);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const setTraderAgentConfig = useAppStore((s) => s.setTraderAgentConfig);

  const teamTriRef = useRef<HTMLDivElement | null>(null);
  const [teamLeftW, setTeamLeftW] = useState(268);
  const [teamRightW, setTeamRightW] = useState(300);
  const teamColDrag = useRef<{ which: 1 | 2; startX: number; left0: number; right0: number } | null>(null);

  const refreshWorkflowOptions = useCallback(async () => {
    const wfRows = (await listMonitorWorkflows({})) as Array<Record<string, unknown>>;
    const active = wfRows.filter((w) => String(w.status) !== "cancelled");
    setWorkflowOptions(active);
    return active;
  }, []);

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

  const participatingAnalystRoles = useMemo(() => {
    if (!agentDefBundles?.length || participatingAnalystDefinitionIds.length === 0) return [];
    const idSet = new Set(participatingAnalystDefinitionIds);
    const roles: string[] = [];
    for (const b of agentDefBundles) {
      if (!idSet.has(b.definition.id)) continue;
      const r = b.definition.role;
      if (RESEARCH_TEAM_SLOT_ROLE_SET.has(r)) roles.push(r);
    }
    return roles;
  }, [agentDefBundles, participatingAnalystDefinitionIds]);

  const analystDefCatalog = useMemo(() => {
    const rows: { id: string; role: string; displayName: string }[] = [];
    if (!agentDefBundles) return rows;
    for (const b of agentDefBundles) {
      if (!RESEARCH_TEAM_SLOT_ROLE_SET.has(b.definition.role)) continue;
      if (b.definition.enabled === false) continue;
      rows.push({
        id: b.definition.id,
        role: b.definition.role,
        displayName: b.profile?.displayName?.trim() || b.definition.name || b.definition.role,
      });
    }
    return rows;
  }, [agentDefBundles]);

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

  const filteredGraphDisplay = useMemo((): AnalystTeamGraphPayload | null => {
    if (!teamGraph) return null;
    if (!participatingAnalystRoles.length) return teamGraph;
    return buildFilteredTeamGraphDisplay(teamGraph, participatingAnalystRoles);
  }, [teamGraph, participatingAnalystRoles]);

  const graphNodeDetail = useMemo((): {
    inbound: AnalystTeamGraphInteraction[];
    outbound: AnalystTeamGraphInteraction[];
    steps: AnalystTeamGraphAgentStep[];
    tools: AnalystTeamGraphToolCall[];
    mcps: AnalystTeamGraphMcpCall[];
  } => {
    if (!teamGraph || graphSelection?.kind !== "node") {
      return { inbound: [], outbound: [], steps: [], tools: [], mcps: [] };
    }
    const r = graphSelection.role;
    const interactions = filteredGraphDisplay?.interactions ?? teamGraph.interactions;
    const llmRows = interactions.filter((row) => row.kind === "llm_message");
    return {
      inbound: llmRows.filter((row) => row.toRole === r),
      outbound: llmRows.filter((row) => row.fromRole === r),
      steps: (teamGraph.agentSteps ?? []).filter((s) => s.agentRole === r),
      tools: teamGraph.toolCalls.filter((t) => t.agentRole === r),
      mcps: teamGraph.mcpCalls.filter((m) => m.agentRole === r),
    };
  }, [teamGraph, graphSelection, filteredGraphDisplay?.interactions]);

  const graphEdgeDetail = useMemo(() => {
    if (graphSelection?.kind !== "edge" || !filteredGraphDisplay) return null;
    const { a, b } = graphSelection;
    const edge =
      filteredGraphDisplay.edges.find((e) => e.key === teamGraphUndirectedKey(a, b)) ?? null;
    const messages = filterInteractionsForEdge(filteredGraphDisplay.interactions, a, b);
    return {
      a,
      b,
      edge,
      messageCount: edge?.messageCount ?? messages.length,
      toolCount: edge?.toolCount ?? 0,
      messages,
    };
  }, [graphSelection, filteredGraphDisplay]);

  const displayedLiveFeedRows = useMemo(() => {
    if (graphSelection?.kind === "edge" && graphEdgeDetail) {
      return graphEdgeDetail.messages.map((row) => ({
        key: `edge-i-${row.id}`,
        t: new Date(row.createdAt).getTime() || 0,
        kind: "interaction" as const,
        body: `${row.fromRole} → ${row.toRole} · ${row.kind}${row.toolName ? ` · ${row.toolName}` : ""}\n${row.contentText.slice(0, 4000)}`,
      }));
    }
    return mergedLiveFeedRows;
  }, [graphSelection, graphEdgeDetail, mergedLiveFeedRows]);

  /**
   * 结构化版本的对话事件，用于 IM 风格渲染。
   * - 边筛选下：只取该边上的消息。
   * - 全局视图：合并 interactions + 辩论事件，按 ts 排序后取最近 200 条。
   */
  const displayedLiveFeedEvents = useMemo<LiveConversationEvent[]>(() => {
    const events: LiveConversationEvent[] = [];
    if (graphSelection?.kind === "edge" && graphEdgeDetail) {
      for (const row of graphEdgeDetail.messages) {
        events.push({
          kind: "message",
          id: `edge-i-${row.id}`,
          ts: row.createdAt,
          fromRole: row.fromRole,
          toRole: row.toRole,
          messageKind: row.kind,
          toolName: row.toolName,
          contentText: row.contentText,
        });
      }
      return events;
    }
    const allow = participatingAnalystRoles.length > 0 ? new Set(participatingAnalystRoles) : null;
    for (const row of teamGraph?.interactions ?? []) {
      if (allow && !allow.has(row.fromRole) && !allow.has(row.toRole)) continue;
      events.push({
        kind: "message",
        id: `i-${row.id}`,
        ts: row.createdAt,
        fromRole: row.fromRole,
        toRole: row.toRole,
        messageKind: row.kind,
        toolName: row.toolName,
        contentText: row.contentText,
      });
    }
    liveDebateEvents.forEach((ev, i) => {
      const p = (ev.payload ?? {}) as {
        topic?: string;
        maxRounds?: number;
        roundNumber?: number;
        speakerRole?: string;
        statement?: string;
        stance?: string;
        reasoning?: string;
        finalStance?: string;
        verdict?: string;
      };
      let text = "";
      switch (ev.type) {
        case "debate_start":
          text = `${String(p.topic ?? "").slice(0, 200)}（最多 ${p.maxRounds ?? "?"} 轮）`;
          break;
        case "debate_turn":
          text = String(p.statement ?? "").slice(0, 1200);
          break;
        case "debate_verdict":
          text = `${String(p.finalStance ?? "")} / ${String(p.verdict ?? "")}\n${String(
            p.reasoning ?? ""
          ).slice(0, 800)}`;
          break;
        case "debate_end":
          text = "";
          break;
        default:
          text = JSON.stringify(p).slice(0, 400);
      }
      events.push({
        kind: "debate",
        id: `d-${i}-${ev.ts}-${ev.type}`,
        ts: new Date(ev.ts).toISOString(),
        debateType: ev.type,
        speakerRole: p.speakerRole ?? null,
        round: p.roundNumber ?? null,
        stance: p.stance ?? null,
        text,
      });
    });
    return events
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .slice(-200);
  }, [graphSelection, graphEdgeDetail, teamGraph, participatingAnalystRoles, liveDebateEvents]);

  useEffect(() => {
    const el = liveFeedScrollRef.current;
    if (!el || activeTab !== "research") return;
    el.scrollTop = el.scrollHeight;
  }, [displayedLiveFeedRows, running, activeTab]);

  const teamGraphActivity = useMemo((): TeamGraphActivity => {
    const intr = filteredGraphDisplay?.interactions ?? [];
    const hotRoles = new Set<string>();
    const hotEdgeKeys = new Set<string>();
    const windowMs = running ? 14_000 : 90_000;
    const cutoff = Date.now() - windowMs;
    for (let i = intr.length - 1; i >= 0; i--) {
      const row = intr[i];
      if (row.kind === "tool_call") continue;
      const t = new Date(row.createdAt).getTime();
      if (!Number.isFinite(t)) continue;
      if (t < cutoff) break;
      hotRoles.add(row.fromRole);
      hotRoles.add(row.toRole);
      hotEdgeKeys.add(teamGraphUndirectedKey(row.fromRole, row.toRole));
    }
    return { hotRoles, hotEdgeKeys, isRunning: running };
  }, [filteredGraphDisplay?.interactions, running]);

  const enabledResearchAnalystDefCount = useMemo(() => {
    if (agentDefBundles == null) return null;
    return agentDefBundles.filter((b) => {
      if (!RESEARCH_TEAM_SLOT_ROLE_SET.has(b.definition.role)) return false;
      return b.definition.enabled !== false;
    }).length;
  }, [agentDefBundles]);

  const teamRunDisabled = useMemo(() => {
    if (running) return true;
    if (!researchScopePayload || !workflowRunId) return true;
    if (enabledResearchAnalystDefCount === null) return true;
    if (enabledResearchAnalystDefCount === 0) return true;
    if (participatingAnalystDefinitionIds.length === 0) return true;
    return false;
  }, [running, researchScopePayload, workflowRunId, enabledResearchAnalystDefCount, participatingAnalystDefinitionIds]);

  const teamRunDisabledTitle = useMemo(() => {
    if (running) return "分析进行中";
    if (!researchScopePayload) return "请先填写研究范围（标的/篮子/板块）";
    if (!workflowRunId) return "请先选择工作流";
    if (enabledResearchAnalystDefCount === null) return "正在加载 Agent 定义…";
    if (enabledResearchAnalystDefCount === 0)
      return "数据库中暂无已启用的研究团队槽位定义（analyst_* / research / backtest / risk* 等），请先到配置中心启用或执行种子";
    if (participatingAnalystDefinitionIds.length === 0) return "请至少勾选一名参与分析的 Agent 定义";
    return "";
  }, [running, researchScopePayload, workflowRunId, enabledResearchAnalystDefCount, participatingAnalystDefinitionIds]);

  const workflowSessionId = useMemo(() => {
    const row = workflowOptions.find((w) => String(w.id) === workflowRunId);
    const sid = row?.sessionId;
    return typeof sid === "string" && sid ? sid : "";
  }, [workflowRunId, workflowOptions]);

  const selectedWorkflowRow = useMemo(
    () => workflowOptions.find((w) => String(w.id) === workflowRunId) ?? null,
    [workflowOptions, workflowRunId]
  );

  const selectedWorkflowKind = useMemo(
    () => (selectedWorkflowRow ? classifyWorkflow(selectedWorkflowRow) : null),
    [selectedWorkflowRow]
  );

  const filteredWorkflowOptions = useMemo(() => {
    if (workflowKindFilter === "all") return workflowOptions;
    const filtered = workflowOptions.filter((row) => classifyWorkflow(row) === workflowKindFilter);
    if (
      selectedWorkflowRow &&
      classifyWorkflow(selectedWorkflowRow) !== workflowKindFilter &&
      !filtered.some((row) => String(row.id) === workflowRunId)
    ) {
      return [selectedWorkflowRow, ...filtered];
    }
    return filtered;
  }, [workflowOptions, workflowKindFilter, selectedWorkflowRow, workflowRunId]);

  const groupedWorkflowOptions = useMemo(
    () => groupWorkflowOptions(filteredWorkflowOptions),
    [filteredWorkflowOptions]
  );

  useEffect(() => {
    if (agentDefBundles === null) return;
    const ids = agentDefBundles
      .filter((b) => RESEARCH_TEAM_SLOT_ROLE_SET.has(b.definition.role) && b.definition.enabled !== false)
      .map((b) => b.definition.id);
    setParticipatingAnalystDefinitionIds((prev) => (prev.length > 0 ? prev : ids));
  }, [agentDefBundles]);

  /** 切换工作流：加载该工作流绑定的策略脚本、磁盘报告与融合摘要 */
  useEffect(() => {
    const wf = workflowRunId.trim();
    if (!wf) {
      setStrategyScripts([]);
      setWorkflowArtifactHint("");
      setResult(null);
      return;
    }
    const sid = workflowSessionId.trim() || teamResearchSessionId.trim();
    if (sid) {
      void listStrategyScripts(sid, { workflowRunId: wf }).then(setStrategyScripts);
    } else {
      setStrategyScripts([]);
    }
    let cancelled = false;
    void (async () => {
      setResult(null);
      try {
        const artifacts = await getWorkflowArtifacts(wf);
        if (cancelled) return;
        setWorkflowArtifactHint(artifacts.workflowDir);
        const fusion = await getSignalFusion(wf).catch(() => null);
        if (cancelled) return;
        const reportBody =
          fusion?.report?.trim() ||
          artifacts.report?.trim() ||
          "";
        if (fusion) {
          setResult({
            fusionId: fusion.fusionId,
            ticker: fusion.ticker,
            fusedSignal: fusion.fusedSignal,
            fusedConfidence: fusion.fusedConfidence,
            debateTriggered: fusion.debateTriggered,
            breakdown: fusion.breakdown ?? [],
            report:
              reportBody ||
              "（已恢复融合摘要；完整报告见磁盘 report.md 或重新运行团队分析。）",
            debate: fusion.debate,
            risk: fusion.risk,
          });
        } else if (artifacts.report?.trim()) {
          setResult({
            fusionId: "",
            ticker: ticker.trim() || "—",
            fusedSignal: "hold",
            fusedConfidence: 0,
            debateTriggered: false,
            breakdown: [],
            report: artifacts.report,
          });
        }
      } catch {
        if (!cancelled) setWorkflowArtifactHint("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowRunId, workflowSessionId, teamResearchSessionId]);

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
  const [graphSize, setGraphSize] = useState({ w: 720, h: TEAM_GRAPH_VIEWPORT_HEIGHT });

  useLayoutEffect(() => {
    const el = graphWrapRef.current;
    if (!el || activeTab !== "research") return;
    const applyWidth = (width: number) => {
      const w = Math.max(320, Math.floor(width));
      setGraphSize((prev) =>
        prev.w === w && prev.h === TEAM_GRAPH_VIEWPORT_HEIGHT ? prev : { w, h: TEAM_GRAPH_VIEWPORT_HEIGHT }
      );
    };
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) applyWidth(cr.width);
    });
    ro.observe(el);
    applyWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [activeTab]);

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
      void listAgentDefinitions()
        .then(setAgentDefBundles)
        .catch(() => setAgentDefBundles([]));
      void listAgentGroups()
        .then((rows) => {
          setAnalystAgentGroupOptions(rows);
          setAnalystAgentGroupId((cur) => {
            if (cur.trim()) return cur;
            return (
              rows.find((g) => g.id === "grp-full-analyst-team")?.id ??
              rows.find((g) => g.id === "grp-default-analyst-team")?.id ??
              rows[0]?.id ??
              ""
            );
          });
        })
        .catch(() => setAnalystAgentGroupOptions([]));
      try {
        const workspaces = await listWorkspaces();
        let wsId = workspaces[0]?.id;
        if (!wsId) {
          const cr = await createWorkspace({ name: "QUBIT Default Workspace", owner: "local-user" });
          wsId = cr.data.id;
        }
        const projects = await listProjects(wsId);
        let pid = projects[0]?.id;
        if (!pid) {
          const pr = await createProject({
            workspaceId: wsId,
            name: "QUBIT Default Project",
            marketScope: "CN-A",
          });
          pid = pr.data.id;
        }
        setTeamResearchProjectId(pid);
        const session = await getDefaultProjectSession(pid);
        setTeamResearchSessionId(session.id);
      } catch {
        setTeamResearchProjectId("");
        setTeamResearchSessionId("");
      }
      getDebateConfig().then(setDebateConfigState).catch(() => {});
      getRiskConfig().then(setRiskConfigState).catch(() => {});
      getExecutionSafetyConfig().then(setExecutionSafetyConfigState).catch(() => {});
      const wfRows = await refreshWorkflowOptions();
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

  const [runProgress, setRunProgress] = useState<string>("");

  /**
   * 「等待上限（分钟）」：前端轮询多久后停止等待。注意：超时后**后端任务仍在运行**，
   * 只是前端不再等结果；用户可在拓扑/对话流刷新查看，或调大上限重新启动。
   * 0 表示「不超时」，一直轮询直到完成 / 失败 / 用户点击「停止等待」。
   */
  const [pollTimeoutMin, setPollTimeoutMin] = useState<number>(() => {
    if (typeof window === "undefined") return 30;
    const raw = window.localStorage.getItem("qb.analyst-poll-timeout-min");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    return 30;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("qb.analyst-poll-timeout-min", String(pollTimeoutMin));
  }, [pollTimeoutMin]);
  const pollAbortRef = useRef<AbortController | null>(null);
  const handleStopWaiting = () => {
    pollAbortRef.current?.abort();
  };

  /**
   * v2：Orchestrator 规划后 HITL 三档模式（参考 docs/HITL_REDESIGN.md）。
   *   - 'off'：永不主动询问；硬规则（资金/规模/失败重试）仍触发
   *   - 'ai'：默认 — Orchestrator 自评 needed=true 或硬规则命中才触发
   *   - 'always'：每次规划都触发（v1 行为）
   * 兼容：老 key `qb.analyst-team-hitl` = '1' → 映射到 'always'，否则取 'ai' 为默认。
   */
  const [teamHitlMode, setTeamHitlMode] = useState<"off" | "ai" | "always">(() => {
    if (typeof window === "undefined") return "ai";
    const v2 = window.localStorage.getItem("qb.analyst-team-hitl-mode");
    if (v2 === "off" || v2 === "ai" || v2 === "always") return v2;
    const legacy = window.localStorage.getItem("qb.analyst-team-hitl");
    if (legacy === "1") return "always";
    return "ai";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("qb.analyst-team-hitl-mode", teamHitlMode);
  }, [teamHitlMode]);
  /**
   * v2：审批卡片已移到画布下 <TeamHitlBanner />，本组件仅保留触发态用于左侧"↑ 跳到画布"锚点。
   * banner 内部用 resolveWorkflowHitl 提交，提交后通过 onResolved 回调清空本 state。
   */
  const [teamPendingHitl, setTeamPendingHitl] = useState<{
    jobId: string;
    requestId: string;
    title: string;
    summary: string;
  } | null>(null);

  const handleRun = async () => {
    if (!researchScopePayload) return;
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
        setError("请先选择工作流");
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
      const abortCtl = new AbortController();
      pollAbortRef.current = abortCtl;
      const timeoutMs = pollTimeoutMin > 0 ? pollTimeoutMin * 60_000 : 0;
      const res = await runAnalystTeam({
        workflowRunId: wfId,
        ticker: researchScopePayload.symbols?.[0] ?? ticker.trim(),
        scope: researchScopePayload,
        context: teamAnalysisContext.trim() || undefined,
        agentGroupId: analystAgentGroupId.trim() || undefined,
        analystDefinitionIds:
          participatingAnalystDefinitionIds.length > 0 ? participatingAnalystDefinitionIds : undefined,
        timeoutMs,
        signal: abortCtl.signal,
        hitlMode: teamHitlMode,
        hitlTeam: teamHitlMode === "always",
        onAwaitingApproval: (info) => {
          setTeamPendingHitl({
            jobId: info.jobId,
            requestId: info.requestId,
            title: info.title || "Orchestrator 规划完成，待人工确认",
            summary: info.summary || "",
          });
          setRunProgress("Orchestrator 规划已完成，等待人工审批…");
        },
        onResume: () => {
          setTeamPendingHitl(null);
          setRunProgress("已批准，分析师团队继续执行…");
        },
        onProgress: (elapsedMs) => {
          const secs = Math.floor(elapsedMs / 1000);
          const limitText = pollTimeoutMin > 0 ? `（等待上限 ${pollTimeoutMin}m）` : "（不限时）";
          setRunProgress(
            `分析进行中… 已用时 ${secs}s${limitText} · 多 Agent LLM 推理，请耐心等待`
          );
        },
      });
      unsubscribe();
      setResult(res);
      setRunProgress("");
      setActiveTab("research");
      if (wfId && res.report?.trim()) {
        void saveWorkflowReportArtifact(wfId, {
          report: res.report,
          ticker: res.ticker || ticker.trim() || undefined,
        }).catch(() => {});
      }
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
    } catch (e) {
      if (e instanceof AnalystJobPollError && (e.reason === "timeout" || e.reason === "aborted")) {
        // 这两种都不算"任务失败"——后端可能还在跑，只是前端不再等了。
        setError(e.message);
        setRunProgress(
          e.reason === "aborted"
            ? "已停止等待（任务可能仍在后台运行；可在拓扑/对话流刷新查看）"
            : `等待上限 ${pollTimeoutMin}m 已到（任务可能仍在后台运行；可调大上限或刷新查看）`
        );
      } else {
        setError((e as Error).message);
        setRunProgress("");
      }
    } finally {
      pollAbortRef.current = null;
      setRunning(false);
    }
  };

  const reportCodeBlocks = useMemo(() => extractFencedCodeBlocks(result?.report ?? ""), [result?.report]);

  const teamCodeSelectOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const s of strategyScripts) {
      opts.push({ value: `script:${s.id}`, label: `已保存 · ${s.name}` });
    }
    reportCodeBlocks.forEach((b, i) => {
      opts.push({
        value: `snippet:${i}`,
        label: `报告代码块 · ${b.lang} · ${(b.code.length / 1024).toFixed(1)} KB`,
      });
    });
    return opts;
  }, [strategyScripts, reportCodeBlocks]);

  useEffect(() => {
    const opts = teamCodeSelectOptions;
    if (opts.length === 0) {
      setTeamCodePick("");
      return;
    }
    setTeamCodePick((prev) => (prev && opts.some((o) => o.value === prev) ? prev : opts[0].value));
  }, [teamCodeSelectOptions]);

  const getPickedTeamCode = useCallback((): { ide: string; signal: string } | null => {
    if (!teamCodePick) return null;
    if (teamCodePick.startsWith("script:")) {
      const id = teamCodePick.slice("script:".length);
      const s = strategyScripts.find((x) => x.id === id);
      if (!s) return null;
      return { ide: s.ideCode ?? "", signal: s.signalCode ?? "" };
    }
    if (teamCodePick.startsWith("snippet:")) {
      const i = Number(teamCodePick.slice("snippet:".length));
      const b = reportCodeBlocks[i];
      if (!b) return null;
      const isPy = b.lang === "python" || b.lang === "py";
      return isPy ? { ide: "", signal: b.code } : { ide: b.code, signal: "" };
    }
    return null;
  }, [teamCodePick, strategyScripts, reportCodeBlocks]);

  const handleCreateTeamWorkflow = async () => {
    if (!teamResearchProjectId || !teamResearchSessionId) {
      setError("尚未解析到默认项目/会话，无法创建工作流。请检查工作区是否可用。");
      return;
    }
    setError(null);
    try {
      const created = await createWorkflow({
        projectId: teamResearchProjectId,
        goal: `研究团队 · ${scopeModeLabel(scopeMode)} · ${ticker.trim() || sectorName || "标的"} · ${new Date().toLocaleString()}`,
        mode: "research",
        sessionId: teamResearchSessionId,
        source: "manual",
        reuseSessionWorkflow: false,
        skipDispatch: true,
      });
      await refreshWorkflowOptions();
      setWorkflowRunId(String(created.data.id));
      if (!geneProjectId && teamResearchProjectId) setGeneProjectId(teamResearchProjectId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleCancelTeamWorkflow = async () => {
    if (!workflowRunId.trim()) return;
    if (!window.confirm("将当前工作流标记为已取消（软删除，保留记录）。确定？")) return;
    setError(null);
    try {
      await deleteWorkflow(workflowRunId.trim());
      // 立即把"分析中"相关 UI 状态全清，否则用户感觉"按钮没生效"：
      //   - pollAbortRef.abort() 让前端轮询循环退出
      //   - setRunning(false) 让"分析中…"按钮恢复为"启动团队分析"
      //   - 后端 in-memory analyst job 由后端 cancel 路由内 best-effort 标 failed
      pollAbortRef.current?.abort();
      setRunning(false);
      setRunProgress("");
      setTeamPendingHitl(null);
      const rows = await refreshWorkflowOptions();
      setWorkflowRunId(rows[0]?.id ? String(rows[0].id) : "");
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 硬删除当前工作流。
   * 与软删除（取消）的区别是：会级联清理 agent_instance / agent_step / tool_call_log /
   * a2a_message / order_intent / intent_order / langgraph_checkpoint 等所有衍生数据，
   * 并把 audit_log / scheduled_job_run 等保留型反向引用置空。【不可恢复】。
   */
  const handleHardDeleteTeamWorkflow = async () => {
    const id = workflowRunId.trim();
    if (!id) return;
    const row = workflowOptions.find((w) => String(w.id) === id);
    const goal = typeof row?.goal === "string" ? row.goal : id;
    const ok = window.confirm(
      `确认硬删除工作流？\n\n` +
        `ID: ${id}\n目标: ${goal}\n\n` +
        "将连带删除该工作流的所有 agent 实例 / 步骤 / 工具调用 / a2a 消息 / 订单意图 / " +
        "LangGraph checkpoint 等衍生数据，且【不可恢复】。\n\n" +
        "如只是想保留记录、停止执行，请取消并改用「取消当前工作流」。"
    );
    if (!ok) return;
    setError(null);
    try {
      const result = await deleteWorkflow(id, { hard: true });
      // 与 cancel 同样：清掉"分析中"状态 + 让轮询退出，避免轮询打到已删 workflow 拿到 404。
      pollAbortRef.current?.abort();
      setRunning(false);
      setRunProgress("");
      setTeamPendingHitl(null);
      const rows = await refreshWorkflowOptions();
      setWorkflowRunId(rows[0]?.id ? String(rows[0].id) : "");
      setResult(null);
      const affected = Object.values(result.details ?? {}).reduce((a, b) => a + b, 0);
      setError(`已硬删除工作流（共清理 ${affected} 行衍生数据）。`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleLinkWorkflowToDefaultSession = async () => {
    if (!workflowRunId.trim() || !teamResearchSessionId) return;
    setError(null);
    try {
      await patchWorkflow(workflowRunId.trim(), { sessionId: teamResearchSessionId });
      await refreshWorkflowOptions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleTeamOpenIde = () => {
    const p = getPickedTeamCode();
    if (!p) return;
    const code = (p.signal || p.ide).trim();
    if (!code) {
      setError("当前选中项没有可写入 IDE 的代码内容");
      return;
    }
    setError(null);
    setIdeSignalPythonCode(code);
    if (p.ide.trim()) setIdeStrategySource(p.ide);
    setChartSpec({ symbol: ticker.trim() });
    setActiveView("ide");
    const { idePanels } = useAppStore.getState();
    if (!idePanels.backtest) toggleIdePanelVisible("backtest");
  };

  const handleTeamSaveStrategyScript = async () => {
    const sid = (workflowSessionId || teamResearchSessionId).trim();
    const p = getPickedTeamCode();
    if (!sid) {
      setError("需要关联到聊天会话后才能保存策略脚本（请选择带 session 的工作流或先「关联默认会话」）。");
      return;
    }
    if (!p) return;
    setError(null);
    try {
      const wf = workflowRunId.trim() || undefined;
      const created = await createStrategyScript(sid, {
        name: `研究团队 · ${ticker.trim() || "标的"} · ${new Date().toLocaleString()}`,
        ideCode: p.ide || "",
        signalCode: p.signal || p.ide || "",
        workflowRunId: wf,
        purpose: "both",
      });
      const rows = wf
        ? await listStrategyScripts(sid, { workflowRunId: wf })
        : await listStrategyScripts(sid);
      setStrategyScripts(rows);
      if (created.artifactDir) setWorkflowArtifactHint(created.artifactDir);
      setTeamCodePick(`script:${created.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleTeamGoLive = async () => {
    const sid = (workflowSessionId || teamResearchSessionId).trim();
    const p = getPickedTeamCode();
    if (!sid || !p) {
      setError("需要会话与有效代码片段才能入库并跳转实盘页。");
      return;
    }
    setError(null);
    try {
      const wf = workflowRunId.trim() || undefined;
      const created = await createStrategyScript(sid, {
        name: `研究团队实盘 · ${ticker.trim() || "标的"} · ${new Date().toLocaleString()}`,
        ideCode: p.ide || "",
        signalCode: p.signal || p.ide || "",
        workflowRunId: wf,
        purpose: "live_trading",
      });
      setTraderAgentConfig({ strategyScriptIds: [created.id] });
      setSelectedSessionId(sid);
      setActiveView("trader");
    } catch (e) {
      setError((e as Error).message);
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

  return (
    <div style={teamStyles.container}>
      <div data-qb-team-shell style={teamStyles.teamWorkbenchShell}>
        <div ref={teamTriRef} style={teamStyles.teamTriRow}>
        <aside style={{ ...teamStyles.leftRail, width: teamLeftW, flexShrink: 0, alignSelf: "stretch" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-team-section-fg, #e4e4e7)", marginBottom: 10 }}>研究与工作流</div>
          <div style={teamStyles.field}>
            <label style={teamStyles.label}>研究范围</label>
            <select
              style={teamStyles.input}
              value={scopeMode}
              onChange={(e) => setScopeMode(e.target.value as ResearchScopeMode)}
            >
              <option value="single">单标的</option>
              <option value="basket">多标的篮子</option>
              <option value="sector">板块</option>
            </select>
          </div>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>工具类型</label>
            <select
              style={teamStyles.input}
              value={researchInstrument}
              onChange={(e) => setResearchInstrument(e.target.value as ResearchInstrumentUi)}
            >
              <option value="equity_long">股票多头</option>
              <option value="equity_short">股票做空</option>
              <option value="option">期权</option>
            </select>
          </div>
          {scopeMode === "single" ? (
            <div style={{ ...teamStyles.field, marginTop: 8 }}>
              <label style={teamStyles.label}>标的代码</label>
              <input
                style={teamStyles.input}
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder={researchInstrument === "option" ? "标的或 OCC 合约" : "e.g. AAPL / 600519"}
              />
            </div>
          ) : null}
          {scopeMode === "basket" ? (
            <div style={{ ...teamStyles.field, marginTop: 8 }}>
              <label style={teamStyles.label}>篮子标的（逗号分隔）</label>
              <textarea
                style={teamStyles.textarea}
                rows={2}
                value={basketTickers}
                onChange={(e) => setBasketTickers(e.target.value)}
                placeholder="AAPL, MSFT, NVDA"
              />
            </div>
          ) : null}
          {scopeMode === "sector" ? (
            <>
              <div style={{ ...teamStyles.field, marginTop: 8 }}>
                <label style={teamStyles.label}>板块名称</label>
                <input
                  style={teamStyles.input}
                  value={sectorName}
                  onChange={(e) => setSectorName(e.target.value)}
                  placeholder="半导体 / 新能源"
                />
              </div>
              <div style={{ ...teamStyles.field, marginTop: 8 }}>
                <label style={teamStyles.label}>成分股（逗号分隔）</label>
                <textarea
                  style={teamStyles.textarea}
                  rows={2}
                  value={sectorPeers}
                  onChange={(e) => setSectorPeers(e.target.value)}
                  placeholder="NVDA, AMD, AVGO"
                />
              </div>
            </>
          ) : null}
          {researchInstrument === "option" && scopeMode === "single" ? (
            <div style={{ ...teamStyles.field, marginTop: 8 }}>
              <label style={teamStyles.label}>期权（可选）</label>
              <input
                style={teamStyles.input}
                value={optionUnderlying}
                onChange={(e) => setOptionUnderlying(e.target.value)}
                placeholder="标的 NVDA"
              />
              <input
                style={{ ...teamStyles.input, marginTop: 6 }}
                value={optionContract}
                onChange={(e) => setOptionContract(e.target.value)}
                placeholder="合约 OCC"
              />
              <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                <input style={{ ...teamStyles.input, flex: "1 1 90px" }} value={optionExpiry} onChange={(e) => setOptionExpiry(e.target.value)} placeholder="到期" />
                <input style={{ ...teamStyles.input, flex: "1 1 70px" }} value={optionStrike} onChange={(e) => setOptionStrike(e.target.value)} placeholder="行权价" />
                <select style={{ ...teamStyles.input, flex: "0 0 72px" }} value={optionRight} onChange={(e) => setOptionRight(e.target.value as "call" | "put" | "")}>
                  <option value="call">Call</option><option value="put">Put</option>
                </select>
              </div>
            </div>
          ) : null}
          <div style={{ ...teamStyles.field, marginTop: 10 }}>
            <label style={teamStyles.label}>分析提示（可选）</label>
            <textarea
              style={teamStyles.textarea}
              rows={4}
              value={teamAnalysisContext}
              onChange={(e) => setTeamAnalysisContext(e.target.value)}
              placeholder={`留空则使用默认分析提示。当前：${scopeModeLabel(scopeMode)} · ${instrumentLabel(researchInstrument)}`}
            />
          </div>
          <div style={{ ...teamStyles.field, marginTop: 10 }}>
            <label style={teamStyles.label}>工作流</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <select
                style={{ ...teamStyles.input, flex: "1 1 140px", minWidth: 120 }}
                value={workflowKindFilter}
                onChange={(e) => setWorkflowKindFilter(e.target.value as WorkflowKind | "all")}
                aria-label="工作流类型筛选"
              >
                <option value="all">全部类型</option>
                {(Object.keys(WORKFLOW_KIND_LABEL) as WorkflowKind[]).map((k) => (
                  <option key={k} value={k}>
                    {WORKFLOW_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <select style={teamStyles.input} value={workflowRunId} onChange={(e) => setWorkflowRunId(e.target.value)}>
              <option value="">请选择工作流</option>
              {groupedWorkflowOptions.map((group) => (
                <optgroup key={group.kind} label={group.label}>
                  {group.rows.slice(0, 40).map((row) => (
                    <option key={String(row.id)} value={String(row.id)} title={String(row.goal ?? row.id)}>
                      {formatWorkflowOptionLabel(row)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selectedWorkflowRow ? (
              <p style={{ fontSize: 11, color: "#71717a", marginTop: 6, lineHeight: 1.45, wordBreak: "break-all" }}>
                类型：
                <strong style={{ color: "#a1a1aa", marginRight: 6 }}>
                  {selectedWorkflowKind ? WORKFLOW_KIND_LABEL[selectedWorkflowKind] : "—"}
                </strong>
                ID: <code style={{ fontSize: 10 }}>{String(selectedWorkflowRow.id)}</code>
                {typeof selectedWorkflowRow.goal === "string" && selectedWorkflowRow.goal.trim() ? (
                  <>
                    <br />
                    {String(selectedWorkflowRow.goal)}
                  </>
                ) : null}
              </p>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              <button
                type="button"
                className="qb-btn-secondary"
                style={{ fontSize: 12, padding: "6px 10px" }}
                onClick={() => void handleCreateTeamWorkflow()}
                disabled={!teamResearchProjectId || !teamResearchSessionId}
                title={!teamResearchSessionId ? "正在解析默认会话…" : "创建仅用于研究团队的工作流（不触发总控编排）"}
              >
                新建工作流
              </button>
              <button
                type="button"
                className="qb-btn-secondary"
                style={{ fontSize: 12, padding: "6px 10px" }}
                onClick={() => void handleCancelTeamWorkflow()}
                disabled={!workflowRunId.trim()}
              >
                取消当前工作流
              </button>
              <button
                type="button"
                className="qb-btn-secondary"
                style={{
                  fontSize: 12,
                  padding: "6px 10px",
                  color: "#fecaca",
                  borderColor: "#7f1d1d",
                }}
                onClick={() => void handleHardDeleteTeamWorkflow()}
                disabled={!workflowRunId.trim()}
                title="硬删除当前工作流（连同 agent / 步骤 / 消息 / 订单 / checkpoint 等全部衍生数据），不可恢复"
              >
                硬删除工作流
              </button>
              {workflowRunId.trim() && !workflowSessionId && teamResearchSessionId ? (
                <button
                  type="button"
                  className="qb-btn-secondary"
                  style={{ fontSize: 12, padding: "6px 10px" }}
                  onClick={() => void handleLinkWorkflowToDefaultSession()}
                >
                  关联默认会话
                </button>
              ) : null}
            </div>
            {workflowRunId.trim() && !workflowSessionId ? (
              <p style={{ fontSize: 11, color: "#a78bfa", marginTop: 6, lineHeight: 1.45 }}>
                当前工作流未绑定会话：右侧「保存脚本 / 实盘」需会话。可点「关联默认会话」或新建工作流（已自动带会话）。
              </p>
            ) : null}
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
          {enabledResearchAnalystDefCount === 0 && agentDefBundles !== null ? (
            <div className="qb-callout qb-callout--warning" role="status" style={{ marginTop: 12 }}>
              <div>
                当前数据库里没有<strong>已启用</strong>的研究团队槽位定义（<code style={{ fontSize: 11 }}>analyst_fundamental</code>、
                <code style={{ fontSize: 11 }}>research</code>、<code style={{ fontSize: 11 }}>backtest</code>、
                <code style={{ fontSize: 11 }}>risk</code> 等），无法启动分析。请在下方按<strong>Agent 定义</strong>勾选参与成员（与配置中心已发布定义一致）。
              </div>
              <div className="qb-callout__actions">
                <button
                  type="button"
                  className="qb-btn-secondary"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                  onClick={() => {
                    setActiveView("config");
                    setCfgSubPage("agent");
                  }}
                >
                  打开「配置中心 → Agent」
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                  onClick={() => void listAgentDefinitions().then(setAgentDefBundles)}
                >
                  刷新定义列表
                </button>
              </div>
            </div>
          ) : null}
          <div
            style={{
              marginTop: 12,
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              fontSize: 11,
              color: "var(--qb-team-meta, #a1a1aa)",
            }}
          >
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              等待上限
              <input
                type="number"
                min={0}
                max={720}
                step={5}
                value={pollTimeoutMin}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setPollTimeoutMin(Number.isFinite(n) && n >= 0 ? n : 0);
                }}
                style={{
                  width: 56,
                  padding: "2px 6px",
                  background: "transparent",
                  color: "#e4e4e7",
                  border: "1px solid #3f3f46",
                  borderRadius: 4,
                  fontSize: 11,
                }}
                title="前端等多少分钟还没结果就停止轮询。后端任务不受影响，仍会跑完并落库。0 = 不超时。"
              />
              分钟
            </label>
            {[15, 30, 60, 120, 0].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPollTimeoutMin(m)}
                style={{
                  padding: "2px 8px",
                  fontSize: 11,
                  background: pollTimeoutMin === m ? "#27272a" : "transparent",
                  color: pollTimeoutMin === m ? "#f4f4f5" : "#a1a1aa",
                  border: "1px solid #3f3f46",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                {m === 0 ? "不超时" : `${m}m`}
              </button>
            ))}
            <span style={{ marginLeft: "auto", color: "#71717a" }}>
              超时只是不再轮询，后端任务仍会继续
            </span>
          </div>
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              border: "1px solid #3f3f46",
              borderRadius: 6,
              background: teamHitlMode === "off" ? "transparent" : "#1c1917",
              fontSize: 12,
              color: "#d4d4d8",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <span style={{ color: "#fde68a", fontWeight: 500 }}>
              Orchestrator 人工介入（HITL）
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              {(
                [
                  { id: "off", label: "关闭", hint: "仅资金/规模/重试硬规则触发" },
                  { id: "ai", label: "由 AI 决定", hint: "默认 — AI 觉得需要才问" },
                  { id: "always", label: "每次都问", hint: "每次规划都人工确认" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setTeamHitlMode(opt.id)}
                  disabled={running}
                  title={opt.hint}
                  style={{
                    flex: 1,
                    padding: "4px 6px",
                    fontSize: 11,
                    border: "1px solid",
                    borderColor: teamHitlMode === opt.id ? "#fbbf24" : "#3f3f46",
                    background: teamHitlMode === opt.id ? "#3f2d11" : "transparent",
                    color: teamHitlMode === opt.id ? "#fde68a" : "#a1a1aa",
                    borderRadius: 4,
                    cursor: running ? "not-allowed" : "pointer",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <span style={{ color: "#71717a", fontSize: 11 }}>
              {teamHitlMode === "off"
                ? "AI 主动询问已关闭；高风险（交易/大规模/重试）仍会暂停"
                : teamHitlMode === "ai"
                  ? "Orchestrator 自评 + 硬规则共同决定是否暂停"
                  : "每次规划完成都暂停，等你批准/拒绝"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="qb-btn-primary-brand"
              style={{ flex: 1 }}
              onClick={handleRun}
              disabled={teamRunDisabled}
              title={teamRunDisabledTitle}
            >
              {running ? "分析中…" : "启动团队分析"}
            </button>
            {running ? (
              <button
                type="button"
                className="qb-btn-secondary"
                style={{ fontSize: 12, padding: "6px 12px" }}
                onClick={handleStopWaiting}
                title="立即停止前端轮询。后端任务不会被中断；如需中断请用「取消当前工作流」"
              >
                停止等待
              </button>
            ) : null}
          </div>
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
          {teamPendingHitl ? (
            <button
              type="button"
              role="alert"
              onClick={() => {
                if (activeTab !== "research") setActiveTab("research");
                const el = document.querySelector("[data-qb-team-hitl-banner]");
                if (el) (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              style={{
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: 6,
                background: "#1f1d12",
                border: "1px solid #b45309",
                color: "#fde68a",
                fontSize: 12,
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
              title="跳到画布查看完整 HITL 卡片"
            >
              <span aria-hidden>⏸</span>
              <span style={{ flex: 1, minWidth: 0, color: "#fef3c7" }}>
                {teamPendingHitl.title || "Orchestrator 规划待人工确认"}
              </span>
              <span style={{ color: "#fbbf24", fontSize: 11 }}>↑ 跳到画布</span>
            </button>
          ) : null}
          {error ? (
            <div className="qb-callout qb-callout--danger" role="alert" style={{ marginTop: 10 }}>
              <div className="qb-callout__row">
                <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
                <button
                  type="button"
                  className="qb-callout__dismiss"
                  onClick={() => setError(null)}
                  aria-label="关闭提示"
                >
                  ×
                </button>
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 14, borderTop: "1px solid var(--qb-sidebar-border, #27272a)", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--qb-team-section-fg, #cbd5e1)", marginBottom: 6 }}>
              团队成员（画布）
            </div>
            <p style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginBottom: 8 }}>
              勾选配置中心已发布且启用的研究团队槽位（<code style={{ fontSize: 11 }}>analyst_*</code> 参与 MSA 融合；<code style={{ fontSize: 11 }}>research</code> / <code style={{ fontSize: 11 }}>backtest</code> / <code style={{ fontSize: 11 }}>risk*</code> 等产出辅助章节）<strong>Agent 定义</strong>参与本次分析；与上方「分析师编组」取交集（编组决定拓扑与槽位，勾选决定实际出场的定义）。
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {participatingAnalystDefinitionIds.length === 0 ? (
                <span style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)" }}>暂无成员，请从下方添加</span>
              ) : (
                participatingAnalystDefinitionIds.map((defId) => {
                  const meta = analystDefCatalog.find((x) => x.id === defId);
                  return (
                    <div
                      key={defId}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: "1px solid var(--qb-team-input-border, #3f3f46)",
                        fontSize: 11,
                        color: "var(--qb-team-member-tag-fg, #e4e4e7)",
                        background: "var(--qb-team-member-tag-bg, #18181b)",
                      }}
                    >
                      <span>{meta?.displayName ?? defId.slice(0, 8)}</span>
                      <button
                        type="button"
                        className="qb-btn-secondary qb-btn--icon-xs"
                        onClick={() =>
                          setParticipatingAnalystDefinitionIds((prev) => prev.filter((x) => x !== defId))
                        }
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
                setParticipatingAnalystDefinitionIds((prev) => (prev.includes(v) ? prev : [...prev, v]));
                e.target.value = "";
              }}
            >
              <option value="">＋ 添加分析师（按定义）…</option>
              {analystDefCatalog
                .filter((r) => !participatingAnalystDefinitionIds.includes(r.id))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName} ({r.role})
                  </option>
                ))}
            </select>
          </div>

          <div style={{ marginTop: 14, borderTop: "1px solid #27272a", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1", marginBottom: 6 }}>工作流对话拓扑（只读）</div>
            <p style={{ fontSize: 11, color: "#71717a", marginBottom: 8 }}>
              运行期轨迹：含 LLM 交互、Tool/MCP 及编组<strong>通信拓扑</strong>产生的 handoff（见成员目录保存的 relations_json）。
              无数据时请在「研究画布」刷新。
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
                  aria-current={activeTab === t ? "page" : undefined}
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
            <div className="qb-team-main-stage" style={teamStyles.teamMainStage}>
              <header className="qb-team-editor-titlebar" style={teamStyles.teamEditorTitleBar}>
                <span style={{ fontWeight: 600, color: "var(--qb-team-titlebar-fg, #e4e4e7)" }}>{TEAM_VIEW_TITLE[activeTab]}</span>
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
            <button type="button" className="qb-btn-secondary" onClick={() => void saveDebateRuntimeConfig()}>
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
            <button type="button" className="qb-btn-secondary" onClick={() => void saveRiskRuntimeConfig()}>
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
            <button type="button" className="qb-btn-secondary" onClick={() => void runScreenerNow()}>
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
            <button type="button" className="qb-btn-secondary" onClick={() => void initGenePoolNow()}>
              初始化基因池
            </button>
            <button type="button" className="qb-btn-secondary" onClick={() => void evolveNow()}>
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
              className="qb-btn-secondary"
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
            <button type="button" className="qb-btn-secondary" onClick={() => void createIntentNow()}>
              创建意图
            </button>
            <button type="button" className="qb-btn-secondary" onClick={() => void executeIntentNow()}>
              安全确认后执行
            </button>
            <button type="button" className="qb-btn-secondary" onClick={() => void refreshIntentOrders()}>
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
            <button type="button" className="qb-btn-secondary" onClick={() => void saveBrokerAccountNow()}>
              保存 Broker 账号
            </button>
            <button type="button" className="qb-btn-secondary" onClick={() => void checkBrokerNow()}>
              健康检查
            </button>
          </div>
          <div style={teamStyles.configRow}>
            <button type="button" className="qb-btn-secondary" onClick={() => void refreshBrokerAndComp()}>
              刷新补偿与Broker状态
            </button>
            <button type="button" className="qb-btn-secondary" onClick={() => void enqueueRetryNow()}>
              加入失败补偿队列
            </button>
            <button type="button" className="qb-btn-secondary" onClick={() => void processCompNow()}>
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


      {/* Roles Panel — 基于 Agent 定义 + 编组 + 可编辑通信拓扑 */}
      {activeTab === "roles" && (
        <div style={{ ...teamStyles.panel, overflowY: "auto" }}>
          <TeamResearchMemberDirectory
            analystAgentGroupId={analystAgentGroupId}
            setAnalystAgentGroupId={setAnalystAgentGroupId}
            analystAgentGroupOptions={analystAgentGroupOptions}
            setAnalystAgentGroupOptions={setAnalystAgentGroupOptions}
            agentDefBundles={agentDefBundles}
            participatingAnalystDefinitionIds={participatingAnalystDefinitionIds}
            setParticipatingAnalystDefinitionIds={setParticipatingAnalystDefinitionIds}
          />
        </div>
      )}

      {activeTab === "research" && (
        <div
          data-qb-team-research-panel
          style={{ ...teamStyles.panel, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <h3 style={{ ...teamStyles.sectionTitle, marginTop: 0 }}>多 Agent 对话拓扑</h3>
          <p style={{ fontSize: 12, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 12 }}>
            拓扑与实时对话流同屏；虚线/灰边为计划拓扑，实线为已发生对话。Orchestrator 在任务启动时向各成员派发。策略/回测在 MSA 融合后执行。分析进行中自动轮询。
          </p>
          {!workflowRunId.trim() ? (
            <div style={teamStyles.empty}>请先在左侧栏选择工作流 ID</div>
          ) : (
            <>
              <div style={{ ...teamStyles.row, flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  className="qb-btn-primary-brand"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                  disabled={graphLoading}
                  onClick={() => void loadTeamGraph({ preserveSelection: true })}
                >
                  {graphLoading ? "加载中…" : "刷新拓扑"}
                </button>
                <div className="qb-team-graph-view-toggle" role="tablist" aria-label="拓扑视图切换">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={teamGraphView === "topology"}
                    className={teamGraphView === "topology" ? "is-active" : ""}
                    onClick={() => setTeamGraphView("topology")}
                  >
                    拓扑图
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={teamGraphView === "office"}
                    className={teamGraphView === "office" ? "is-active" : ""}
                    onClick={() => setTeamGraphView("office")}
                  >
                    像素办公室
                  </button>
                </div>
                <span style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>
                  {filteredGraphDisplay
                    ? `展示 ${filteredGraphDisplay.nodes.filter((n) => n.role !== "__tools__").length} 个 Agent${
                        participatingAnalystRoles.length > 0 ? "（已按左侧勾选过滤）" : ""
                      }`
                    : ""}
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
                  <div
                    ref={graphWrapRef}
                    data-qb-team-graph-host
                    style={{
                      ...teamStyles.graphCanvasHost,
                      flex: teamGraphView === "office" ? "1 1 auto" : "0 0 auto",
                      height: teamGraphView === "office" ? "min(72vh, 860px)" : TEAM_GRAPH_VIEWPORT_HEIGHT,
                      minHeight: teamGraphView === "office" ? 520 : TEAM_GRAPH_VIEWPORT_HEIGHT,
                      maxHeight: teamGraphView === "office" ? "min(72vh, 860px)" : TEAM_GRAPH_VIEWPORT_HEIGHT,
                      overflow: "hidden",
                      flexDirection: "column",
                      justifyContent: teamGraphView === "office" ? "stretch" : "center",
                      alignItems: teamGraphView === "office" ? "stretch" : "center",
                    }}
                  >
                    {teamGraphView === "topology" ? (
                      <TeamAgentGraph
                        nodes={filteredGraphDisplay.nodes}
                        edges={filteredGraphDisplay.edges}
                        width={graphSize.w}
                        height={graphSize.h}
                        selection={graphSelection}
                        activity={teamGraphActivity}
                        onSelectNode={(role) => setGraphSelection({ kind: "node", role })}
                        onSelectEdge={(a, b) => setGraphSelection({ kind: "edge", a, b })}
                        onClear={() => setGraphSelection(null)}
                      />
                    ) : (
                      <TeamAgentPixelOffice
                        key={workflowRunId}
                        graph={filteredGraphDisplay}
                        nodes={filteredGraphDisplay.nodes}
                        edges={filteredGraphDisplay.edges}
                        selection={graphSelection}
                        activity={teamGraphActivity}
                        isRunning={running}
                        onSelectNode={(role) => setGraphSelection({ kind: "node", role })}
                        onClear={() => setGraphSelection(null)}
                      />
                    )}
                    {teamGraphView === "topology" ? (
                      <p style={{ fontSize: 10, color: "var(--qb-team-meta, #71717a)", marginTop: 6 }}>
                        箭头表示消息方向；双向为两条弧线。工具/MCP 连线：绿色=成功、红色=全失败、琥珀=部分失败。
                      </p>
                    ) : null}
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
              {graphEdgeDetail ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid #3b82f6",
                    background: "rgba(37, 99, 235, 0.08)",
                    fontSize: 12,
                    color: "#cbd5e1",
                  }}
                >
                  已选连线：<strong>{graphEdgeDetail.a}</strong>
                  {graphEdgeDetail.edge && isToolGraphEdge(graphEdgeDetail.edge) ? " → " : " · "}
                  <strong>{graphEdgeDetail.b}</strong>
                  {" · "}
                  {formatEdgeSelectionSummary(
                    graphEdgeDetail.a,
                    graphEdgeDetail.b,
                    graphEdgeDetail.edge,
                    graphEdgeDetail.messageCount
                  )}
                  <button
                    type="button"
                    className="qb-btn-secondary"
                    style={{ fontSize: 11, padding: "2px 8px", marginLeft: 10 }}
                    onClick={() => setGraphSelection(null)}
                  >
                    显示全部对话
                  </button>
                </div>
              ) : null}
              <div style={{ marginTop: 14 }} data-qb-team-hitl-banner>
                {workflowRunId.trim() && teamPendingHitl ? (
                  <TeamHitlBanner
                    workflowRunId={workflowRunId.trim()}
                    triggerKey={teamPendingHitl.requestId}
                    onResolved={(decision) => {
                      setTeamPendingHitl(null);
                      setRunProgress(
                        decision === "approved" ? "已批准，分析师团队继续执行…" : "已拒绝，工作流终止"
                      );
                    }}
                  />
                ) : null}
                <ResizableY
                  defaultHeight={360}
                  minHeight={200}
                  maxHeight={1200}
                  storageKey="qb.live-feed-h"
                  wrapperData={{ "data-qb-team-live-feed-shell": "" }}
                  style={{
                    border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
                    borderRadius: 8,
                    background: "var(--qb-team-live-feed-bg, #08080a)",
                    color: "var(--qb-team-live-feed-fg, #e4e4e7)",
                  }}
                >
                  <div
                    style={{
                      ...teamStyles.sectionTitle,
                      margin: 0,
                      padding: "8px 10px",
                      flexShrink: 0,
                      borderBottom:
                        "1px solid var(--qb-team-live-feed-row-border, var(--qb-team-live-feed-border, #2a2a30))",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    实时对话流
                    {graphSelection?.kind === "edge" ? "（已按连线筛选）" : ""}
                    {running ? " · 自动刷新" : ""}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        color: "var(--qb-team-meta, #71717a)",
                        fontWeight: 400,
                      }}
                    >
                      拖底边调整高度
                    </span>
                  </div>
                  <div
                    ref={liveFeedScrollRef}
                    data-qb-team-live-feed
                    className="qb-team-live-feed-scroll"
                    style={{
                      flex: "1 1 0",
                      minHeight: 0,
                      overflowY: "auto",
                      overflowX: "hidden",
                      padding: 10,
                      paddingBottom: 16,
                    }}
                  >
                    <LiveConversationView
                      events={displayedLiveFeedEvents}
                      selfRole="orchestrator"
                      contentMaxLength={4000}
                      emptyText={
                        graphSelection?.kind === "edge"
                          ? "该连线暂无对话记录。"
                          : running
                            ? "等待各分析师与系统写入交互记录（轮询中）…"
                            : "暂无记录。启动分析后，研究队交互与辩论事件将按时间显示在此。"
                      }
                    />
                  </div>
                </ResizableY>
              </div>
              {graphSelection?.kind === "node" ? (
                <div style={{ marginTop: 14 }}>
                  <ResizableY
                    defaultHeight={420}
                    minHeight={220}
                    maxHeight={1400}
                    storageKey="qb.agent-run-h"
                    wrapperData={{ "data-qb-team-live-feed-shell": "" }}
                    style={{
                      border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
                      borderRadius: 8,
                      background: "var(--qb-team-live-feed-bg, #08080a)",
                      color: "var(--qb-team-live-feed-fg, #e4e4e7)",
                    }}
                  >
                    <AgentRunPanel
                      data={{
                        role: graphSelection.role,
                        inbound: graphNodeDetail.inbound,
                        outbound: graphNodeDetail.outbound,
                        steps: graphNodeDetail.steps,
                        tools: graphNodeDetail.tools,
                        mcps: graphNodeDetail.mcps,
                      }}
                    />
                  </ResizableY>
                </div>
              ) : null}
              <div
                style={{
                  marginTop: 18,
                  borderTop:
                    "1px solid var(--qb-team-live-feed-row-border, var(--qb-sidebar-border, #2a2a30))",
                  paddingTop: 12,
                }}
              >
                <h3 style={{ ...teamStyles.sectionTitle, marginTop: 0 }}>分析结论</h3>
                {!result && (
                  <div style={{ ...teamStyles.empty, marginTop: 8 }}>
                    暂无结论；切换工作流后会自动加载该工作流已落库的融合结果。
                  </div>
                )}
                {result && (
                  <div style={{ marginTop: 10 }}>
                    <div style={teamStyles.heroBox}>
                      <span style={{ ...teamStyles.heroBadge, color: SIGNAL_COLOR[result.fusedSignal] }}>
                        {result.fusedSignal.toUpperCase()}
                      </span>
                      <div style={teamStyles.heroMeta}>
                        <span>置信度：{(result.fusedConfidence * 100).toFixed(0)}%</span>
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
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7", marginBottom: 4 }}>
            研究产出
          </div>
          <p style={{ fontSize: 11, color: "#71717a", marginBottom: 10, lineHeight: 1.45 }}>
            展示当前研究项目下 Agent 生成的<strong>因子 / 策略</strong>，以及当前工作流下保存的代码片段。每块支持折叠，专注当前关注的问题。
          </p>

          <AgentGeneratedFactorsBlock
            projectId={teamResearchProjectId}
            workflowRunId={workflowRunId}
            onOpenInWorkbench={() => {
              setActiveView("quant");
              setQuantTab("factor");
            }}
          />

          <AgentGeneratedStrategiesBlock
            projectId={teamResearchProjectId}
            workflowRunId={workflowRunId}
            onOpenInComposer={() => {
              setActiveView("quant");
              setQuantTab("composer");
            }}
          />

          <details className="qb-mcp-details" style={{ ...teamStyles.codeDetails, flex: 1, minHeight: 0 }}>
            <summary style={teamStyles.codeDetailsSummary}>
              策略与代码{teamCodeSelectOptions.length > 0 ? `（${teamCodeSelectOptions.length}）` : ""}
            </summary>
            <div
              style={{
                padding: "0 12px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
                flex: 1,
                minHeight: 0,
              }}
            >
              <p style={{ fontSize: 11, color: "#71717a", marginBottom: 4, lineHeight: 1.45 }}>
                与<strong>当前工作流</strong>绑定：仅显示该工作流下已保存的脚本，以及本工作流分析报告中的代码块。保存脚本会写入数据库并同步到本机{" "}
                <code>~/.quant-agent/projects/…/workflows/&lt;id&gt;/</code> 目录。
              </p>
              {workflowArtifactHint ? (
                <p style={{ fontSize: 10, color: "#52525b", marginBottom: 4, wordBreak: "break-all" }}>
                  工作流目录: {workflowArtifactHint}
                </p>
              ) : null}
              {teamCodeSelectOptions.length === 0 ? (
                <div style={{ fontSize: 12, color: "#71717a" }}>
                  暂无可用片段：请先运行团队分析（报告含 ``` 代码块时会出现），或在绑定会话的工作流下于 IDE 保存策略脚本。
                </div>
              ) : (
                <>
                  <label style={{ ...teamStyles.label, marginBottom: 4 }}>选择代码来源</label>
                  <select
                    style={{ ...teamStyles.input, width: "100%", marginBottom: 10 }}
                    value={teamCodePick}
                    onChange={(e) => setTeamCodePick(e.target.value)}
                  >
                    {teamCodeSelectOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const p = getPickedTeamCode();
                    if (!p) return null;
                    const hasIde = Boolean(p.ide.trim());
                    const hasSig = Boolean(p.signal.trim());
                    return (
                      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          <button
                            type="button"
                            className="qb-btn-secondary"
                            style={{ fontSize: 12, padding: "6px 10px" }}
                            onClick={() => handleTeamOpenIde()}
                            disabled={!hasSig && !hasIde}
                          >
                            在 IDE 中打开
                          </button>
                          <button
                            type="button"
                            className="qb-btn-secondary"
                            style={{ fontSize: 12, padding: "6px 10px" }}
                            onClick={() => void handleTeamSaveStrategyScript()}
                            disabled={!hasSig && !hasIde}
                          >
                            保存为策略脚本
                          </button>
                          <button
                            type="button"
                            className="qb-btn-primary-brand"
                            style={{ fontSize: 12, padding: "6px 10px" }}
                            onClick={() => void handleTeamGoLive()}
                            disabled={!hasSig && !hasIde}
                          >
                            去实盘页
                          </button>
                        </div>
                        {hasIde ? (
                          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1" }}>IDE / 指标代码</div>
                            <TokyoCodeView
                              code={p.ide}
                              language="python"
                              filename="strategy_ide.py"
                              flex={1}
                              minHeight={80}
                              maxHeight="28vh"
                            />
                          </div>
                        ) : null}
                        {hasSig ? (
                          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1" }}>Python 信号 / 回测代码</div>
                            <TokyoCodeView
                              code={p.signal}
                              language="python"
                              filename="signal.py"
                              flex={1}
                              minHeight={100}
                              maxHeight="36vh"
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </details>
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
  codeDetails: {
    marginBottom: 10,
    border: "1px solid var(--qb-mcp-details-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-mcp-details-bg, #111114)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  codeDetailsSummary: {
    cursor: "pointer",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--qb-main-meta, #e4e4e7)",
    userSelect: "none",
    listStyle: "none",
  } as CSSProperties,
  teamWorkbenchShell: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--qb-team-shell-border, #3f3f46)",
    borderRadius: 10,
    overflow: "hidden",
    background: "var(--qb-team-shell-bg, #070708)",
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
    background: "var(--qb-team-gutter-bg, #27272a)",
    alignSelf: "stretch",
  },
  leftRail: {
    background: "var(--qb-team-left-bg, #0c0c0f)",
    borderRight: "1px solid var(--qb-team-shell-border, #2d2d32)",
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
    background: "var(--qb-team-center-bg, #0e0e12)",
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
    background: "var(--qb-team-activity-bg, #1a1a1f)",
    borderRight: "1px solid var(--qb-team-shell-border, #2d2d32)",
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
    color: "var(--qb-team-act-btn-fg, #a1a1aa)",
  },
  teamActBtnActive: {
    background: "var(--qb-team-act-btn-active-bg, #2d2d36)",
    borderColor: "var(--qb-team-act-btn-active-border, #7c3aed)",
    color: "var(--qb-team-act-btn-active-fg, #f4f4f5)",
  },
  teamMainStage: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--qb-team-stage-bg, #101014)",
  },
  teamEditorTitleBar: {
    height: 38,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d32)",
    fontSize: 12,
    color: "var(--qb-team-titlebar-fg, #d4d4d8)",
    background: "var(--qb-team-titlebar-bg, #141418)",
  },
  teamEditorBody: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: 14,
  },
  rightRail: {
    background: "var(--qb-team-right-bg, #0c0c0f)",
    borderLeft: "1px solid var(--qb-team-shell-border, #2d2d32)",
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
    background: "var(--qb-team-canvas-bg, #0c0c0e)",
    borderRadius: 8,
    border: "1px solid var(--qb-team-table-row-border, #27272a)",
  },
  tabs: { display: "flex", gap: 8, marginBottom: 16 },
  tab: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid var(--qb-team-input-border, #27272a)",
    background: "var(--qb-team-tab-bg, #18181b)",
    color: "var(--qb-team-tab-fg, #a1a1aa)",
    cursor: "pointer",
    fontSize: 13,
  },
  tabActive: {
    background: "var(--qb-team-tab-active-bg, #27272a)",
    color: "var(--qb-team-tab-active-fg, #e4e4e7)",
    borderColor: "var(--qb-team-tab-active-border, #7c3aed)",
  },
  panel: {
    background: "var(--qb-team-panel-bg, #121216)",
    border: "1px solid var(--qb-team-panel-border, #2a2a30)",
    borderRadius: 10,
    padding: 16,
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 88,
    resize: "vertical" as const,
    background: "var(--qb-team-input-bg, #18181b)",
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 6,
    color: "var(--qb-team-input-fg, #e4e4e7)",
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.45,
    outline: "none",
    fontFamily: "inherit",
  },
  row: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 },
  configRow: { display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 14 },
  field: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 160 },
  label: { fontSize: 12, color: "var(--qb-team-meta, #a1a1aa)" },
  input: {
    background: "var(--qb-team-input-bg, #18181b)",
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 6,
    color: "var(--qb-team-input-fg, #e4e4e7)",
    padding: "6px 10px",
    fontSize: 13,
    outline: "none",
  },
  resultBox: { marginTop: 12 },
  heroBox: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    background: "var(--qb-team-hero-bg, #18181b)",
    border: "1px solid var(--qb-team-hero-border, #27272a)",
    borderRadius: 8,
    padding: "12px 16px",
    marginBottom: 16,
  },
  heroBadge: { fontSize: 28, fontWeight: 700 },
  heroMeta: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--qb-team-meta, #a1a1aa)" },
  debateTag: {
    background: "var(--qb-team-debate-tag-bg, #78350f)",
    color: "var(--qb-team-debate-tag-fg, #fde68a)",
    borderRadius: 4,
    padding: "2px 8px",
    fontSize: 12,
    width: "fit-content",
  },
  sectionTitle: { color: "var(--qb-team-section-fg, #e4e4e7)", fontSize: 14, marginBottom: 10 },
  debateBox: {
    background: "var(--qb-team-debate-bg, #1a1424)",
    border: "1px solid var(--qb-team-debate-border, #3b2b63)",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    color: "var(--qb-team-debate-fg, #ddd6fe)",
    fontSize: 12,
    display: "grid",
    gap: 6,
  },
  debateReason: { color: "var(--qb-team-debate-accent, #a78bfa)" },
  riskBox: {
    border: "1px solid",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    color: "var(--qb-team-section-fg, #e4e4e7)",
    fontSize: 12,
    display: "grid",
    gap: 6,
  },
  replayBox: {
    background: "var(--qb-team-replay-bg, #18181b)",
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
    display: "grid",
    gap: 8,
    maxHeight: 260,
    overflow: "auto",
  },
  replayTurn: {
    borderBottom: "1px dashed var(--qb-team-table-row-border, #3f3f46)",
    paddingBottom: 6,
  },
  replayMeta: { fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 4 },
  replayVerdict: {
    background: "var(--qb-team-debate-bg, #1a1424)",
    border: "1px solid var(--qb-team-debate-border, #3b2b63)",
    borderRadius: 6,
    padding: 8,
    color: "var(--qb-team-debate-fg, #ddd6fe)",
    fontSize: 12,
  },
  trendBox: {
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-team-trend-bg, #18181b)",
    padding: 10,
    marginBottom: 16,
  },
  trendTitle: {
    color: "var(--qb-team-section-fg, #e4e4e7)",
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
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-team-screener-bg, #18181b)",
    padding: 8,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxHeight: 220,
    overflow: "auto",
  },
  screenerRunBtn: {
    border: "1px solid var(--qb-team-input-border, #3f3f46)",
    borderRadius: 6,
    background: "var(--qb-team-screener-btn-bg, #111114)",
    color: "var(--qb-team-screener-btn-fg, #d4d4d8)",
    textAlign: "left",
    padding: "6px 8px",
    cursor: "pointer",
    fontSize: 12,
  },
  screenerRunBtnActive: {
    borderColor: "var(--qb-team-screener-btn-active-border, #7c3aed)",
    background: "var(--qb-team-screener-btn-active-bg, #221838)",
  },
  screenerCandidates: {
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-team-screener-bg, #18181b)",
    padding: 8,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 8,
    maxHeight: 280,
    overflow: "auto",
  },
  screenerCard: {
    border: "1px solid var(--qb-team-input-border, #3f3f46)",
    borderRadius: 8,
    background: "var(--qb-team-screener-btn-bg, #111114)",
    padding: 8,
    fontSize: 12,
    color: "var(--qb-team-section-fg, #e4e4e7)",
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
    color: "var(--qb-team-meta, #a1a1aa)",
    marginTop: 4,
    fontSize: 11,
  },
  radarGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 },
  radarCard: {
    background: "var(--qb-team-radar-bg, #18181b)",
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  radarRole: { fontSize: 12, color: "var(--qb-team-meta, #a1a1aa)" },
  radarSignal: { fontSize: 18, fontWeight: 700 },
  radarBar: {
    height: 4,
    background: "var(--qb-team-radar-bar-bg, #27272a)",
    borderRadius: 2,
    overflow: "hidden",
  },
  radarFill: { height: "100%", borderRadius: 2, transition: "width 0.4s" },
  radarConf: { fontSize: 11, color: "var(--qb-team-meta, #71717a)" },
  report: {
    background: "var(--qb-team-report-bg, #18181b)",
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    padding: 12,
    fontSize: 12,
    color: "var(--qb-team-table-cell-fg, #d4d4d8)",
    whiteSpace: "pre-wrap",
    maxHeight: 300,
    overflow: "auto",
  },
  groupBlock: { marginBottom: 16 },
  groupTitle: { fontSize: 14, fontWeight: 600, marginBottom: 8 },
  memberGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 },
  memberCard: {
    background: "var(--qb-team-member-bg, #18181b)",
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  memberRole: { fontSize: 13, color: "var(--qb-team-section-fg, #e4e4e7)", fontWeight: 500 },
  memberDesc: { fontSize: 11, color: "var(--qb-team-meta, #71717a)" },
  memberTag: {
    fontSize: 10,
    color: "var(--qb-team-member-tag-fg, #52525b)",
    fontFamily: "monospace",
    background: "var(--qb-team-member-tag-bg, #27272a)",
    borderRadius: 3,
    padding: "1px 5px",
    width: "fit-content",
  },
  memberEmpty: { color: "var(--qb-team-member-tag-fg, #52525b)", fontSize: 12 },
  empty: { color: "var(--qb-team-member-tag-fg, #52525b)", fontSize: 13, textAlign: "center", padding: 30 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-team-table-row-border, #27272a)",
    fontSize: 12,
    color: "var(--qb-team-table-header-fg, #71717a)",
  },
  td: {
    padding: "8px 10px",
    borderBottom: "1px solid var(--qb-team-table-row-border, #1e1e21)",
    fontSize: 12,
    color: "var(--qb-team-table-cell-fg, #d4d4d8)",
  },
};
