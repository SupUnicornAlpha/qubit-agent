import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { PanelLeft, PanelTop, Plus } from "lucide-react";
import {
  chatHealth,
  createChatSession,
  createConversationTurn,
  getOrCreateDefaultProject,
  createWorkflow,
  getAgentsConfig,
  getDefaultWorkspace,
  getDefaultProjectSession,
  getAnalystTeamGraph,
  getModelConfig,
  getBuiltinConnectorConfig,
  getWindSessionStatus,
  loginWindSession,
  reconnectWindSession,
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
  listChatSessions,
  listMonitorWorkflows,
  listProjects,
  listSessionMessages,
  patchSessionMessage,
  patchWorkflow,
  updateWorkflowGoal,
  reloadAgents,
  saveModelConfig,
  testEmbeddingModelConfig,
  saveBuiltinConnectorConfig,
  testMcpCall,
  testMcpProjectInstall,
  upsertMcpBinding,
  upsertMcpSource,
  upsertMcpServer,
  listPendingWorkflowHitl,
  resolveWorkflowHitl,
  injectWorkflowMessage,
  interruptWorkflow,
  listFactors,
  listStrategyVersions,
  listStrategyScripts,
  subscribeSessionEvents,
  subscribeWorkflowStream,
  subscribeWorkflowEvents,
  installMcpMarket,
  syncMcpSource,
  uninstallMcpProjectInstall,
} from "../../api/backend";
import type {
  AgentDefinitionBundle,
  AgentDefinitionRecord,
  AgentMemoryStatsResponse,
  AgentPackResponse,
  AgentSkillRecord,
  McpServerConfigRecord,
  McpCatalogItemRecord,
  McpProjectInstallRecord,
  McpRegistrySourceRecord,
  McpToolBindingRecord,
  OpenSkillMarketEntryDto,
  SkillMarketInstallRecord,
  SkillMarketStatusDto,
  AnalystTeamGraphPayload,
  AnalystTeamGraphInteraction,
  AnalystTeamGraphAgentStep,
  AnalystTeamGraphToolCall,
  AnalystTeamGraphMcpCall,
  ChatMessage,
  StepStreamEvent,
  BuiltinConnectorConfig,
  AgentControlMode,
  AgentLoopKind,
} from "../../api/types";
import { useAppStore, type ChartContextPayload } from "../../store";
import { MarkdownBubble } from "../chat/MarkdownBubble";
import { IconToolbarButton } from "../ui/IconToolbarButton";
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
import { NewsBriefSection } from "../chart/NewsBriefSection";
import { IdeResearchWorkbench } from "../ide/IdeResearchWorkbench";
import { TeamAgentGraph, teamGraphUndirectedKey, type TeamGraphActivity, type TeamGraphSelection } from "../ide/TeamAgentGraph";
import { TeamAgentPixelOffice } from "../team/TeamAgentPixelOffice";
import { ResearchMultiKlineGrid } from "../team/ResearchMultiKlineGrid";
import { ResearchToolResultsPanel } from "../team/ResearchToolResultsPanel";
import {
  buildResearchCanvasToolHits,
  latestSuccessfulMarketLink,
  type ResearchCanvasToolHit,
} from "../../lib/researchCanvasToolLink";
import { coerceChartMarketExchange, guessChartExchangeFromSymbol } from "../../lib/chartSpec";
import { buildResearchMarketSymbolList } from "../../lib/researchMarketSymbols";
import { chartPatchFromResearchScope } from "../../lib/researchScopeChartLink";
import { formatEdgeSelectionSummary, isToolGraphEdge } from "../../lib/teamGraphEdgeVisual";
import {
  filterPromptTemplates,
  instrumentLabel,
  parseSymbolList,
  scopeModeLabel,
  type ResearchInstrumentUi,
  type ResearchScopeMode,
} from "../../lib/researchScope";
import {
  buildFilteredTeamGraphDisplay,
  describeInteractionRouting,
  filterInteractionsForEdge,
} from "../../lib/teamGraphDisplay";
import { BrokerAccountsPanel } from "../broker/BrokerAccountsPanel";
import { MonitorDashboard } from "../monitor/MonitorDashboard";
import { TraderLivePanel } from "../trader/TraderLivePanel";
import { useTranslation } from "../../i18n";
import { agentDisplayLabel } from "../../lib/agentDisplay";
import { ConfigAgentPanel, parseAgentMcpServerNames, type AgentConfigUiTab } from "../config/ConfigAgentPanel";
import { IntegrationCenterPanel } from "../config/IntegrationCenterPanel";
import { ScheduledJobsPanel } from "../config/ScheduledJobsPanel";
import { ProvidersPanel } from "../config/ProvidersPanel";
import { LlmProvidersList } from "../config/LlmProvidersList";
import { OriginBadge } from "../common/OriginBadge";
import { PythonRuntimeCard } from "../common/PythonRuntimeCard";
import { EnvironmentPanel } from "../environment/EnvironmentPanel";
import { QuantStudioPanel } from "../quant/QuantStudioPanel";
import { ResearchOutputTabs } from "../team/ResearchOutputTabs";
import { AgentRunPanel } from "../team/AgentRunChatView";
import {
  LiveConversationView,
  type LiveConversationEvent,
} from "../team/LiveConversationView";
import { ResizableY } from "../team/ResizableY";
import { TeamHitlBanner } from "../team/TeamHitlBanner";
import type { OrchestratorPlan } from "../team/PlanCard";
import {
  OrchestratorChatPanel,
  type OrchestratorArtifact,
} from "../team/OrchestratorChatPanel";
import { FsWorkspaceExplorer } from "../workspace/FsWorkspaceExplorer";
import { buildSubAgentRunSummaries } from "../../lib/subAgentRuns";
import { ChatHitlPromptControls } from "../chat/ChatHitlPromptControls";
import { ChatExecutionActivity } from "../chat/ChatExecutionActivity";
import { AgentModePicker, getAgentModeOption } from "../chat/AgentModePicker";
import {
  classifyWorkflow,
  groupWorkflowOptions,
  WORKFLOW_KIND_LABEL,
  type WorkflowKind,
} from "../../lib/workflowKind";
import { quantNavigationForArtifact } from "../../lib/quantArtifactNavigation";
import { useAgentDockOptional } from "../../shell/pro/AgentDockContext";

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

const CHAT_SIDEBAR_WIDTH_LS = "qubit:chatSidebarWidthPx";
const CHAT_SESSION_LAYOUT_LS = "qubit:chatSessionLayout";

type ChatSessionLayout = "top" | "left";

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

function readChatSessionLayout(): ChatSessionLayout {
  if (typeof window === "undefined") return "top";
  try {
    return localStorage.getItem(CHAT_SESSION_LAYOUT_LS) === "left" ? "left" : "top";
  } catch {
    return "top";
  }
}

function persistChatSessionLayout(layout: ChatSessionLayout) {
  try {
    localStorage.setItem(CHAT_SESSION_LAYOUT_LS, layout);
  } catch {
    /* ignore */
  }
}

/**
 * 兜底渲染：消息显示 awaiting_approval 但前端 hitlRequestByMessageId 还没收到 requestId。
 *
 * - 挂载即触发一次 listPendingWorkflowHitl；命中后回写到父组件 state，下次渲染会落到
 *   正常的 approve/reject 按钮分支
 * - 找不到时显示一个轻量"加载中…"占位，避免气泡看上去"卡死"
 * - 每 5s 重试一次（典型场景：刷新页 / 切 session 后 SSE 还没追上）
 */
const PendingHitlFetchRow: FC<{
  workflowRunId: string;
  onFound: (requestId: string) => void;
}> = ({ workflowRunId, onFound }) => {
  const [tries, setTries] = useState(0);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const list = await listPendingWorkflowHitl(workflowRunId);
        if (cancelled) return;
        if (list[0]?.id) onFound(list[0].id);
        else if (tries >= 5) setExhausted(true);
      } catch {
        if (!cancelled && tries >= 5) setExhausted(true);
      }
    };
    void probe();
    const t = setInterval(() => {
      if (cancelled) return;
      setTries((n) => n + 1);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowRunId, tries]);

  return (
    <div
      style={{
        marginTop: 6,
        fontSize: 11,
        color: "var(--qb-chat-meta-fg, #71717a)",
        fontStyle: "italic",
      }}
    >
      {exhausted
        ? "⚠️ 未找到待审批请求（可能已被处理或会话已切换）。可重发指令继续。"
        : "⏳ 加载待审批请求…"}
    </div>
  );
};

type ChatStreamTurn =
  | { kind: "user" | "system"; message: ChatMessage }
  | { kind: "assistant"; key: string; messages: ChatMessage[] };

/** Cursor 风格：用户消息单独一块；连续 assistant 合并为一段正文流。 */
function groupChatMessagesIntoStreamTurns(messages: ChatMessage[]): ChatStreamTurn[] {
  const turns: ChatStreamTurn[] = [];
  let assistantBuf: ChatMessage[] = [];

  const flushAssistant = () => {
    if (assistantBuf.length === 0) return;
    turns.push({
      kind: "assistant",
      key: `assist:${assistantBuf[0]!.id}:${assistantBuf[assistantBuf.length - 1]!.id}`,
      messages: assistantBuf,
    });
    assistantBuf = [];
  };

  for (const message of messages) {
    if (message.role === "user" || message.role === "system") {
      flushAssistant();
      turns.push({ kind: message.role, message });
      continue;
    }
    assistantBuf.push(message);
  }
  flushAssistant();
  return turns;
}

export const ChatPanel: FC<{
  ideEmbedded?: boolean;
  displayMode?: "standard" | "simple";
  /** 专业壳：会话列表在左侧 Explorer，Agent 栏内隐藏会话侧栏 */
  hideSessionSidebar?: boolean;
  workflowRunId?: string | null;
  onWorkflowFocusChange?: (workflowRunId: string | null) => void;
}> = ({
  ideEmbedded,
  displayMode = "standard",
  hideSessionSidebar = false,
  workflowRunId = null,
  onWorkflowFocusChange,
}) => {
  const simpleMode = displayMode === "simple";
  const hideSessions = simpleMode || hideSessionSidebar;
  const showSessionChrome = !hideSessions;
  const [sessionLayout, setSessionLayout] = useState<ChatSessionLayout>(readChatSessionLayout);
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
  const chatAgentMode = useAppStore((s) => s.agentControlMode);
  const setChatAgentMode = useAppStore((s) => s.setAgentControlMode);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setMonitorWorkflowFocus = useAppStore((s) => s.setMonitorWorkflowFocus);
  const { t } = useTranslation();

  const [workspaceId, setWorkspaceId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [input, setInput] = useState("");
  const chatDraftPrefill = useAppStore((s) => s.chatDraftPrefill);
  const setChatDraftPrefill = useAppStore((s) => s.setChatDraftPrefill);
  const [errorText, setErrorText] = useState("");
  const [chatLoopKind, setChatLoopKind] = useState<AgentLoopKind>("native");
  /**
   * 对话 HITL 三档触发策略，与后端 LoopOptionsJson.hitlChatMode 对齐：
   *   - 'off'    ：永不主动；仅高危工具（下单 / 写入外部状态）硬规则触发
   *   - 'ai'     ：默认 — 仅高危工具触发，普通调用不打扰
   *   - 'always' ：每次工具调用都问（v1 旧行为，等价老 `qb.chat-hitl='1'`）
   * 兼容：老 key `qb.chat-hitl='1'` → 映射到 'always'；否则取 'ai' 为默认。
   */
  const [chatHitlMode, setChatHitlMode] = useState<"off" | "ai" | "always">(() => {
    if (typeof window === "undefined") return "ai";
    const v2 = window.localStorage.getItem("qb.chat-hitl-mode");
    if (v2 === "off" || v2 === "ai" || v2 === "always") return v2;
    const legacy = window.localStorage.getItem("qb.chat-hitl");
    if (legacy === "1") return "always";
    return "ai";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("qb.chat-hitl-mode", chatHitlMode);
  }, [chatHitlMode]);
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

  const [chatSidebarWidthPx, setChatSidebarWidthPx] = useState(readChatSidebarWidthPx);
  const chatLayoutRef = useRef<HTMLDivElement | null>(null);
  const bindStreamRef = useRef<
    ((workflowId: string, runId: string, assistantMessageId: string) => void) | null
  >(null);
  /**
   * 当前正在为哪些 assistantMessageId 维护着 SSE 订阅。
   *
   * 历史 bug：onSend 里 `bindStream(...)` 之后立刻 `await reloadSessionMessages(...)`，
   * 后者会走 `reconnectActiveChatStreams` 把所有 `status='running' && content==''` 的消息
   * 重新 bind 一次（用来恢复 panel remount 后的 SSE）。而 `bindStream` 进入函数体就
   * `persistChatStreamBinding` 写 sessionStorage，于是刚才那条 assistantMsg 立刻被
   * 二次匹配，**同一条消息上挂了两路 SSE 订阅**。后端 stepStreamBus 对每个新订阅都会
   * replay 已 buffer 的事件 —— 用户感受就是"流式输出突然从头重来一遍"。HITL approve
   * 后再 `bindStream(workflowId, result.runId, messageId)` 会把这个错叠再放大一次，
   * 看起来就像"HITL 死循环 / 一直在流式输出相似内容"。
   *
   * 用 useRef 而不是 useState：纯副作用簿记，避免 setState 触发渲染；也保证 onSend
   * 同步链路内（bindStream → reloadSessionMessages）能立刻读到最新值。
   */
  const activeStreamMessageIdsRef = useRef<Set<string>>(new Set());
  const activeStreamClosersRef = useRef<Map<string, () => void>>(new Map());
  const [streamRunByMessageId, setStreamRunByMessageId] = useState<Record<string, string>>({});

  const chatGridTemplateColumns = useMemo(() => {
    const w = chatSidebarWidthPx;
    const grip = 6;
    return ideEmbedded
      ? `minmax(120px, ${w}px) ${grip}px minmax(0, 1fr)`
      : `minmax(140px, ${w}px) ${grip}px minmax(0, 1fr)`;
  }, [ideEmbedded, chatSidebarWidthPx]);

  const applySessionLayout = (layout: ChatSessionLayout) => {
    setSessionLayout(layout);
    persistChatSessionLayout(layout);
  };

  useLayoutEffect(() => {
    const el = chatLayoutRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const ratioMax = 0.52;
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
  }, [ideEmbedded]);

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
        const ratioMax = 0.52;
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
    [chatSidebarWidthPx, ideEmbedded]
  );

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
      // 单租户兜底 workspace（详见 src/runtime/bootstrap/ensure-default-workspace.ts）。
      // 旧实现 `workspaces[0]?.id + createWorkspace 兜底` 会落到 A2A Pool (system) 上。
      const dft = await getDefaultWorkspace();
      const wsId = dft.id;
      const projects = await listProjects(wsId);
      let pid = projects[0]?.id;
      if (!pid) {
        // 只读 get-or-create：后端写死稳定 ID 幂等，不再前端 createProject 兜底。
        const dftProj = await getOrCreateDefaultProject();
        pid = dftProj.id;
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
        const created = await createChatSession({
          workspaceId: wsId,
          projectId: pid,
          title: t("chat.sidebar.defaultSessionTitle"),
        });
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

  /** 06：对话页订 Session ClientEvent；HITL 走 approval.requested */
  useEffect(() => {
    if (!selectedSessionId) return;
    return subscribeSessionEvents({
      sessionId: selectedSessionId,
      onEvent: (event) => {
        if (event.type === "approval.requested") {
          const requestId = String(
            (event.item?.payload as { requestId?: string } | undefined)?.requestId ??
              event.item?.id ??
              ""
          );
          if (!requestId) return;
          // 绑定到当前 running 的助手消息（若有）
          setChatMessages((prev) => {
            const running = [...prev]
              .reverse()
              .find((m) => m.role === "assistant" && m.status === "running");
            if (running) {
              setHitlRequestByMessageId((map) => ({ ...map, [running.id]: requestId }));
            }
            return prev;
          });
        }
      },
    });
  }, [selectedSessionId]);

  const onSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    onWorkflowFocusChange?.(null);
  };

  const openWorkflowTrace = (workflowId: string) => {
    setMonitorWorkflowFocus(workflowId);
    setActiveView("monitor");
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
      setErrorText(err instanceof Error ? err.message : t("chat.errors.createSession"));
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
    /**
     * 防重订阅：同一 assistantMessageId 已经有 active SSE 时，直接 short-circuit。
     *
     * 这条护栏既挡 onSend → reloadSessionMessages → reconnectActiveChatStreams
     * 在同一次 tick 内的二次 bind（详见 activeStreamMessageIdsRef 上的注释），也挡
     * HITL approve 后用户快速重复点击 / SSE 还没收 final 时 reload 又来一次的并发场景。
     *
     * 注意一定要在 `persistChatStreamBinding` 之前判，否则二次调用仍会刷
     * sessionStorage —— 看起来无害，但会让后续 panel remount 走错的 runId。
     */
    if (activeStreamMessageIdsRef.current.has(assistantMessageId)) {
      return;
    }
    activeStreamMessageIdsRef.current.add(assistantMessageId);
    setStreamRunByMessageId((prev) =>
      prev[assistantMessageId] === runId ? prev : { ...prev, [assistantMessageId]: runId }
    );
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
      /**
       * 释放占位：让后续合法的 re-bind（panel remount / 用户主动重连 / 新一轮
       * HITL approve 起的新 runId）能够正常进入。与 onEvent 内的 final / error /
       * grace-timeout 三个出口共用同一个 stopStream，保证占位永远被释放。
       */
      activeStreamMessageIdsRef.current.delete(assistantMessageId);
      activeStreamClosersRef.current.delete(assistantMessageId);
    };
    activeStreamClosersRef.current.set(assistantMessageId, stopStream);

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
    decision: "approved" | "rejected",
    /**
     * v2：用户在 single_choice / multi_choice / free_form 形态下提交的内容。
     * - approve_only / rejected：保持 null（后端的 response_json 会落空，下一轮
     *   prompt 不注入"用户在第 N 步告诉你"，与旧行为一致）
     * - 其它形态：来自 ChatHitlPromptControls 校验后的 buildHitlResponsePayload
     */
    response: Record<string, unknown> | null = null
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
      /**
       * 统一走 v2 端点 `POST /api/v1/workflows/:id/hitl/:reqId/resolve`：
       *   - 兼容老 approve_only（response = null）
       *   - 支持 single_choice / multi_choice / free_form 把 response 带回后端，
       *     再透传给 Orchestrator 下一轮 prompt（参见 hitl-service.resolveHitlRequest）
       *
       * 老 approveWorkflowHitl/rejectWorkflowHitl 端点保留服务端兼容，前端不再使用。
       */
      const result = await resolveWorkflowHitl(workflowId, requestId, decision, response);
      if (decision === "approved") {
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
            /**
             * 防御：HITL 走完一轮后，理论上前一个 runId 的 SSE 会通过 `final`
             * 事件触发 stopStream → 释放 activeStreamMessageIdsRef 占位。但极端
             * 场景下（网络断流 / final 未抵达 / 用户在 grace timer 触发前快速点了
             * approve）占位可能还卡着，会让接下来的 bindStream 被去重短路，导致
             * "approve 之后界面再也没有新 token 进来"。这里在新 runId bind 前
             * 强制清一次，配合 bindStream 自己的占位重新加上，保证状态一致。
             */
            activeStreamMessageIdsRef.current.delete(messageId);
            bindStream(workflowId, result.runId, messageId);
          }
        }
      } else {
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
      setErrorText(err instanceof Error ? err.message : t("chat.errors.hitlAction"));
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
      const turn = await createConversationTurn({
        sessionId: selectedSessionId,
        projectId,
        message: combinedGoal,
        workflowMode: "research",
        turnMode: workflowRunId ? "continue_goal" : "continue_goal",
        reuseSessionWorkflow: true,
        loopKind: chatLoopKind,
        hitlMode: chatHitlMode,
        agentMode: chatAgentMode,
        ...(workflowRunId ? { workflowRunId } : {}),
      });
      onWorkflowFocusChange?.(turn.runId);
      const streamRunId = turn.agentRunId ?? turn.runId;
      if (streamRunId) {
        bindStream(turn.runId, streamRunId, turn.assistantMessage.id);
      }
      await reloadSessionMessages(selectedSessionId);
      setInput("");
      setChartContext(null);
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "发送失败");
    }
  };

  const visibleChatMessages =
    simpleMode && workflowRunId
      ? chatMessages.filter((message) => message.workflowRunIds?.includes(workflowRunId))
      : chatMessages;

  const chatTurns = useMemo(
    () => groupChatMessagesIntoStreamTurns(visibleChatMessages),
    [visibleChatMessages]
  );

  const activeAssistantMessage = [...visibleChatMessages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        (message.status === "running" || message.status === "queued") &&
        Boolean(message.workflowRunIds?.[0])
    );

  const pendingHitlMessage =
    [...visibleChatMessages]
      .reverse()
      .find(
        (message) =>
          message.status === "awaiting_approval" && Boolean(message.workflowRunIds?.[0])
      ) ?? null;

  const handleStopGeneration = async () => {
    const message = activeAssistantMessage;
    const workflowId = message?.workflowRunIds?.[0];
    if (!message || !workflowId) return;
    const partial = stripToolCallSentinels(message.content).trim();
    const stoppedContent = partial
      ? `${partial}\n\n_已停止生成_`
      : "⏹️ 已停止生成";
    // 先收 UI/SSE，再请求后端取消；即使网络返回慢，按钮也应立即反馈。
    activeStreamClosersRef.current.get(message.id)?.();
    setChatMessages((prev) =>
      prev.map((item) =>
        item.id === message.id
          ? {
              ...item,
              content: stoppedContent,
              status: "failed",
              errorMessage: "stopped by user",
            }
          : item
      )
    );
    try {
      await deleteWorkflow(workflowId);
      await patchSessionMessage({
        messageId: message.id,
        content: stoppedContent,
        status: "failed",
        errorMessage: "stopped by user",
      });
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "停止生成失败");
    }
  };

  return (
    <div
      data-qb-chat-panel
      data-qb-chat-display={displayMode}
      className={`qb-chat-panel${simpleMode ? " qb-chat-panel--simple" : ""}`}
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
        {errorText ? (
          <div className="qb-chat-error" style={styles.errorBox}>
            {simpleMode ? t("simpleMode.connectionError") : errorText}
          </div>
        ) : null}
      </div>
      <div
        ref={chatLayoutRef}
        className={[
          simpleMode ? "qb-simple-chat-layout" : undefined,
          showSessionChrome ? `qb-chat-layout--sessions-${sessionLayout}` : "qb-chat-layout--sessions-hidden",
        ]
          .filter(Boolean)
          .join(" ")}
        data-qb-chat-session-layout={showSessionChrome ? sessionLayout : "hidden"}
        style={{
          ...styles.chatLayout,
          ...(ideEmbedded ? styles.chatLayoutIde : {}),
          ...(showSessionChrome && sessionLayout === "left"
            ? { display: "grid", gridTemplateColumns: chatGridTemplateColumns }
            : {
                display: "flex",
                flexDirection: "column",
                gridTemplateColumns: "none",
              }),
        }}
      >
        {showSessionChrome ? (
          <div
            className={`qb-chat-sidebar qb-chat-sessions qb-chat-sessions--${sessionLayout}`}
            style={{
              ...styles.chatSidebar,
              ...(sessionLayout === "top" ? styles.chatSessionsTop : null),
            }}
          >
            <div
              className="qb-chat-sessions__toolbar"
              style={{
                ...styles.chatSessionsToolbar,
                ...(sessionLayout === "top" ? styles.chatSessionsToolbarTop : null),
              }}
            >
              {sessionLayout === "top" ? (
                <div
                  className={`qb-chat-session-list qb-chat-session-list--top`}
                  style={{
                    ...styles.chatSessionList,
                    ...styles.chatSessionListTop,
                    ...styles.chatSessionListTopInline,
                  }}
                >
                  {chatSessions.map((session) => (
                    <div
                      key={session.id}
                      className="qb-chat-session-item qb-chat-session-item--top"
                      style={{
                        ...styles.chatSessionItem,
                        ...(selectedSessionId === session.id ? styles.chatSessionItemActive : {}),
                        display: "flex",
                        alignItems: "stretch",
                        gap: 4,
                        padding: 0,
                        ...styles.chatSessionItemTop,
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
                          padding: "6px 10px",
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
                            fontSize: 12,
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
                            ? t("chat.sidebar.confirmDeletePending", { title: session.title })
                            : t("chat.sidebar.deleteSession", { title: session.title })
                        }
                        title={
                          pendingDeleteSessionId === session.id
                            ? t("chat.sidebar.confirmDeleteTitle")
                            : t("chat.sidebar.deleteSessionTitle")
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
                        {pendingDeleteSessionId === session.id
                          ? t("common.action.confirmAgain")
                          : "×"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div
                className="qb-chat-sessions__actions"
                style={styles.chatSessionActions}
                role="toolbar"
                aria-label={t("chat.sidebar.actionsAria")}
              >
                <IconToolbarButton
                  Icon={Plus}
                  label={t("chat.sidebar.newSession")}
                  onClick={() => void onCreateSession()}
                />
                <span style={styles.chatSessionActionDivider} aria-hidden />
                <div
                  className="qb-chat-sessions__layout-toggle"
                  style={styles.chatSessionLayoutToggle}
                  role="group"
                  aria-label={t("chat.sidebar.layoutGroupAria")}
                >
                  <IconToolbarButton
                    Icon={PanelTop}
                    label={t("chat.sidebar.layoutTopTitle")}
                    active={sessionLayout === "top"}
                    onClick={() => applySessionLayout("top")}
                  />
                  <IconToolbarButton
                    Icon={PanelLeft}
                    label={t("chat.sidebar.layoutLeftTitle")}
                    active={sessionLayout === "left"}
                    onClick={() => applySessionLayout("left")}
                  />
                </div>
              </div>
            </div>
            {sessionLayout === "left" ? (
              <div
                className="qb-chat-session-list qb-chat-session-list--left"
                style={styles.chatSessionList}
              >
                {chatSessions.map((session) => (
                  <div
                    key={session.id}
                    className="qb-chat-session-item qb-chat-session-item--left"
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
                          ? t("chat.sidebar.confirmDeletePending", { title: session.title })
                          : t("chat.sidebar.deleteSession", { title: session.title })
                      }
                      title={
                        pendingDeleteSessionId === session.id
                          ? t("chat.sidebar.confirmDeleteTitle")
                          : t("chat.sidebar.deleteSessionTitle")
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
                      {pendingDeleteSessionId === session.id
                        ? t("common.action.confirmAgain")
                        : "×"}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {showSessionChrome && sessionLayout === "left" ? (
          <button
            type="button"
            aria-label={t("chat.sidebar.resizerAria")}
            title={t("chat.sidebar.resizerTitle")}
            onMouseDown={onChatSidebarResizeMouseDown}
            style={styles.chatColResizer}
          />
        ) : null}

        <div className="qb-chat-main" style={styles.chatMain}>
          {simpleMode ? (
            <div className="qb-simple-chat-context">
              <label className="qb-simple-session-picker">
                <span>{t("simpleMode.sessionPicker")}</span>
                <select
                  value={selectedSessionId ?? ""}
                  aria-label={t("simpleMode.sessionPickerAria")}
                  onChange={(event) => onSelectSession(event.target.value)}
                  disabled={chatSessions.length === 0}
                >
                  {chatSessions.map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.title}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => void onCreateSession()}>
                {t("simpleMode.newChat")}
              </button>
              {workflowRunId ? (
                <button type="button" onClick={() => onWorkflowFocusChange?.(null)}>
                  {t("simpleMode.workflowScope.showConversation")}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="qb-chat-messages" style={styles.chatMessages}>
            {simpleMode && visibleChatMessages.length === 0 ? (
              <div className="qb-simple-chat-welcome">
                <span className="qb-simple-chat-welcome__eyebrow">QUBIT RESEARCH</span>
                <h1>{t("simpleMode.heroTitle")}</h1>
                <p>{t("simpleMode.heroDescription")}</p>
                <div className="qb-simple-chat-prompts">
                  {["market", "stock", "factor", "strategy"].map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setInput(t(`simpleMode.prompts.${key}`))}
                    >
                      {t(`simpleMode.prompts.${key}`)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {chatTurns.map((turn) => {
              if (turn.kind === "assistant") {
                const msgs = turn.messages;
                const last = msgs[msgs.length - 1]!;
                const combined = msgs
                  .map((m) => m.content.trim())
                  .filter(Boolean)
                  .join("\n\n");
                const running = msgs.some(
                  (m) => m.status === "running" || m.status === "queued"
                );
              const streamMsg =
                [...msgs].reverse().find((m) => streamRunByMessageId[m.id]) ?? last;
              const streamRunId = streamRunByMessageId[streamMsg.id];
              const workflowIds: string[] = [
                ...new Set(msgs.flatMap((m) => m.workflowRunIds ?? [])),
              ];

              return (
                  <div
                    key={turn.key}
                    className="qb-chat-turn qb-chat-turn--assistant qb-chat-bubble qb-chat-bubble--agent"
                    data-qb-chat-stream="assistant"
                  >
                    <div className="qb-chat-bubble__meta">
                      {simpleMode
                        ? "Qubit"
                        : `assistant · ${last.status}${
                            msgs.length > 1 ? ` · ${msgs.length} segments` : ""
                          }`}
                    </div>
                    <div className="qb-chat-markdown">
                      {combined ? (
                        <MarkdownBubble text={combined} />
                      ) : running ? (
                        <span style={{ color: "var(--qb-chat-meta-fg)" }}>
                          {t("chat.bubble.streaming")}
                        </span>
                      ) : (
                        <span style={{ color: "var(--qb-chat-meta-fg)" }}>
                          {t("chat.bubble.empty")}
                        </span>
                      )}
                    </div>
                  {streamRunId ? (
                    <ChatExecutionActivity
                      events={streamEvents.filter((event) => event.runId === streamRunId)}
                      running={running}
                    />
                  ) : null}
                  {workflowIds.length ? (
                    <div className="qb-chat-bubble__meta">
                      {simpleMode
                        ? workflowIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              className="qb-simple-chat-workflow-link"
                              onClick={() => onWorkflowFocusChange?.(id)}
                            >
                              workflow {id.slice(0, 8)}
                            </button>
                          ))
                        : workflowIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              onClick={() => openWorkflowTrace(id)}
                              title={`在运行监控中查看 workflow ${id} 的完整 Trace`}
                            >
                              查看 Trace · {id.slice(0, 8)}
                            </button>
                          ))}
                    </div>
                  ) : null}
                  </div>
                );
              }

              const msg = turn.message;
              return (
                <div
                  key={msg.id}
                  className={`qb-chat-turn qb-chat-turn--${msg.role} qb-chat-bubble qb-chat-bubble--${msg.role === "user" ? "user" : "agent"}`}
                  data-qb-chat-stream={msg.role}
                >
                  <div className="qb-chat-bubble__meta">
                    {simpleMode
                      ? msg.role === "user"
                        ? t("simpleMode.you")
                        : "Qubit"
                      : `${msg.role} · ${msg.status}`}
                  </div>
                  <div className="qb-chat-markdown">
                    {msg.content ? (
                      <MarkdownBubble text={msg.content} />
                    ) : (
                      <span style={{ color: "var(--qb-chat-meta-fg)" }}>
                        {t("chat.bubble.empty")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {pendingHitlMessage && pendingHitlMessage.workflowRunIds?.[0] ? (
            <div className="qb-chat-hitl-dock" style={{ padding: "0 0 8px", flexShrink: 0 }}>
              {!hitlRequestByMessageId[pendingHitlMessage.id] ? (
                <PendingHitlFetchRow
                  workflowRunId={pendingHitlMessage.workflowRunIds[0]!}
                  onFound={(requestId) =>
                    setHitlRequestByMessageId((prev) => ({
                      ...prev,
                      [pendingHitlMessage.id]: requestId,
                    }))
                  }
                />
              ) : (
                (() => {
                  const reqId = hitlRequestByMessageId[pendingHitlMessage.id]!;
                  const workflowId = pendingHitlMessage.workflowRunIds![0]!;
                  const inflight = hitlInflightRequestIds.has(reqId);
                  return (
                    <ChatHitlPromptControls
                      workflowRunId={workflowId}
                      requestId={reqId}
                      inflight={inflight}
                      onDecision={(decision, response) =>
                        void handleHitlDecision(
                          pendingHitlMessage.id,
                          workflowId,
                          reqId,
                          decision,
                          response
                        )
                      }
                    />
                  );
                })()
              )}
            </div>
          ) : null}
          <form
            className={simpleMode ? "qb-simple-composer" : undefined}
            data-qb-simple-composer={simpleMode ? "true" : undefined}
            style={styles.chatForm}
            onSubmit={
              activeAssistantMessage
                ? (event) => {
                    event.preventDefault();
                    void handleStopGeneration();
                  }
                : onSend
            }
          >
            {!simpleMode ? (
              <AgentModePicker value={chatAgentMode} onChange={setChatAgentMode} />
            ) : null}
            {!simpleMode ? <label style={{ ...styles.chatMeta, display: "flex", alignItems: "center", gap: 6 }}>
              {t("chat.form.loopLabel")}
              <select
                value={chatLoopKind}
                onChange={(e) => setChatLoopKind(e.target.value as AgentLoopKind)}
                style={{ ...styles.input, maxWidth: 160 }}
              >
                <option value="native">{t("chat.form.loopOptions.native")}</option>
                <option value="claude_cli">{t("chat.form.loopOptions.claude")}</option>
                <option value="codex_cli">{t("chat.form.loopOptions.codex")}</option>
              </select>
            </label> : null}
            {!simpleMode ? <label
              style={{ ...styles.chatMeta, display: "flex", alignItems: "center", gap: 6 }}
              title={t("chat.form.hitlTitle")}
            >
              {t("chat.form.hitlLabel")}
              <select
                value={chatHitlMode}
                onChange={(e) => setChatHitlMode(e.target.value as "off" | "ai" | "always")}
                style={{ ...styles.input, maxWidth: 110 }}
              >
                <option value="ai">{t("chat.form.hitlOptions.ai")}</option>
                <option value="off">{t("chat.form.hitlOptions.off")}</option>
                <option value="always">{t("chat.form.hitlOptions.always")}</option>
              </select>
            </label> : null}
            {simpleMode ? (
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={t("simpleMode.composerPlaceholder")}
                rows={3}
              />
            ) : (
              <input
                style={{ ...styles.input, flex: 1 }}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t("chat.form.placeholder")}
              />
            )}
            {simpleMode ? (
              <div className="qb-simple-composer__footer">
                <AgentModePicker
                  value={chatAgentMode}
                  onChange={setChatAgentMode}
                  variant="simple"
                />
                <span className="qb-simple-composer__mode-hint">
                  {getAgentModeOption(chatAgentMode).hint}
                </span>
                <button
                  className="qb-simple-composer__send"
                  type={activeAssistantMessage ? "button" : "submit"}
                  disabled={!activeAssistantMessage && !input.trim()}
                  onClick={activeAssistantMessage ? () => void handleStopGeneration() : undefined}
                  title={
                    activeAssistantMessage
                      ? "停止生成"
                      : `使用 ${getAgentModeOption(chatAgentMode).label} 模式发送`
                  }
                  aria-label={activeAssistantMessage ? "停止生成" : "发送消息"}
                >
                  {activeAssistantMessage ? "■" : "↑"}
                </button>
              </div>
            ) : (
              <button
                className={activeAssistantMessage ? "qb-btn-danger" : "qb-btn-primary-brand"}
                type={activeAssistantMessage ? "button" : "submit"}
                disabled={!activeAssistantMessage && !input.trim()}
                onClick={activeAssistantMessage ? () => void handleStopGeneration() : undefined}
              >
                {activeAssistantMessage ? "停止" : t("common.action.send")}
              </button>
            )}
          </form>
        </div>

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
  const [draftLlmProvider, setDraftLlmProvider] = useState("");
  const [provider, setProvider] = useState<
    "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock"
  >("mock");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelApiKeyConfigured, setModelApiKeyConfigured] = useState(false);
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [embeddingEnabled, setEmbeddingEnabled] = useState(true);
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [embeddingApiKeyConfigured, setEmbeddingApiKeyConfigured] = useState(false);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState("");
  const [embeddingRuntimeHint, setEmbeddingRuntimeHint] = useState("");
  const [embeddingTestMsg, setEmbeddingTestMsg] = useState<string | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [tushareToken, setTushareToken] = useState("");
  const [windUsername, setWindUsername] = useState("");
  const [windPassword, setWindPassword] = useState("");
  const [windStartWaitSec, setWindStartWaitSec] = useState(60);
  const [windAutoLogin, setWindAutoLogin] = useState(true);
  const [windSession, setWindSession] = useState<{
    connected: boolean;
    userId: string | null;
    message: string;
    lastLoginAt: string | null;
  } | null>(null);
  const [windSessionBusy, setWindSessionBusy] = useState(false);
  const [windSessionError, setWindSessionError] = useState("");
  const [klinesDataSource, setKlinesDataSource] = useState<
    | "auto"
    | "tushare_daily"
    | "yahoo_chart"
    | "eastmoney"
    | "akshare"
    | "akshare_tencent"
    | "yfinance"
    | "binance_crypto"
    | "wind"
    | "synthetic"
  >("auto");
  const [cryptoUseTestnet, setCryptoUseTestnet] = useState(false);
  const [marketDataNetworkMode, setMarketDataNetworkMode] = useState<"auto" | "direct" | "proxy">("auto");
  const [marketDataProxyUrl, setMarketDataProxyUrl] = useState("");
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
    setWindUsername(typeof d.windUsername === "string" ? d.windUsername : "");
    setWindPassword(typeof d.windPassword === "string" ? d.windPassword : "");
    const wsw = d["windStartWaitSec"];
    setWindStartWaitSec(
      typeof wsw === "number" && Number.isFinite(wsw)
        ? wsw
        : typeof wsw === "string" && Number.isFinite(Number(wsw))
          ? Number(wsw)
          : 60
    );
    setWindAutoLogin(d.windAutoLogin === false ? false : true);
    const kds = d["klinesDataSource"];
    setKlinesDataSource(
      kds === "tushare_daily" ||
      kds === "yahoo_chart" ||
      kds === "eastmoney" ||
      kds === "akshare" ||
      kds === "akshare_tencent" ||
      kds === "yfinance" ||
      kds === "binance_crypto" ||
      kds === "wind" ||
      kds === "synthetic" ||
      kds === "auto"
        ? kds
        : "auto"
    );
    const testnet = d["cryptoUseTestnet"];
    setCryptoUseTestnet(testnet === true || testnet === "true");
    const networkMode = d["marketDataNetworkMode"];
    setMarketDataNetworkMode(networkMode === "direct" || networkMode === "proxy" ? networkMode : "auto");
    setMarketDataProxyUrl(typeof d.marketDataProxyUrl === "string" ? d.marketDataProxyUrl : "");
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
    // 用 default workspace（不再用 workspaces[0]，避免被 A2A Pool 抢走）。
    const dft = await getDefaultWorkspace();
    const projects = await listProjects(dft.id);
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
    setCurrentWorkspaceId(dft.id);
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
        setDraftLlmProvider(b.draft?.llmProvider ?? b.definition.llmProvider ?? "");
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
      setModelApiKeyConfigured(Boolean(cfg.apiKeyConfigured));
      setModelBaseUrl(cfg.baseUrl ?? "");
      const emb = cfg.embedding;
      setEmbeddingEnabled(emb?.enabled ?? true);
      setEmbeddingModel(emb?.model ?? "text-embedding-3-small");
      setEmbeddingApiKey("");
      setEmbeddingApiKeyConfigured(Boolean(emb?.apiKeyConfigured));
      setEmbeddingBaseUrl(emb?.baseUrl ?? "");
      setEmbeddingDimensions(
        emb?.dimensions != null && Number.isFinite(emb.dimensions) ? String(emb.dimensions) : ""
      );
      if (emb?.runtime) {
        setEmbeddingRuntimeHint(
          emb.runtime.configured
            ? `就绪 · ${emb.runtime.model ?? "?"} · dim=${emb.runtime.dimension ?? "?"} · source=${emb.runtime.source}`
            : `未就绪 · source=${emb.runtime.source}（将降级为 keyword-only）`
        );
      } else {
        setEmbeddingRuntimeHint("");
      }
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
    setDraftLlmProvider(b.draft?.llmProvider ?? b.definition.llmProvider ?? "");
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

  /** 探测用真实工具名：通配 `*` 不能直接 RPC，回退到 capabilities / ping。 */
  const resolveMcpProbeToolName = (
    row: McpServerConfigRecord,
    binding?: McpToolBindingRecord
  ): string => {
    const fromBind = binding?.toolName?.trim();
    if (fromBind && fromBind !== "*") return fromBind;
    const caps = row.capabilitiesJson;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      const tools = (caps as { tools?: unknown }).tools;
      if (Array.isArray(tools)) {
        for (const item of tools) {
          if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
            const name = (item as { name: string }).name.trim();
            if (name && name !== "*") return name;
          }
        }
      }
    }
    return "ping";
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
    const toolName = resolveMcpProbeToolName(row, bind);
    setMcpProbeByServer((prev) => ({
      ...prev,
      [key]: { status: "checking", checkedAt: new Date().toISOString() },
    }));
    try {
      const out = await testMcpCall({
        projectId: currentProjectId || undefined,
        serverName: row.name,
        toolName,
        arguments: { ping: true, ts: Date.now() },
      });
      setMcpTestOutput(JSON.stringify(out, null, 2));
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "ok",
          message: out.accepted ? `工具「${toolName}」调用成功` : `工具「${toolName}」返回未接受`,
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
    const serverName = item.slug.replace(/[^a-z0-9_-]/gi, "-");
    const toolRaw = item.defaultToolName;
    const toolName = typeof toolRaw === "string" && toolRaw.trim() ? toolRaw.trim() : undefined;
    const toRaw = item.defaultTimeoutMs;
    const timeoutMs =
      typeof toRaw === "number" && Number.isFinite(toRaw)
        ? toRaw
        : typeof toRaw === "string" && Number.isFinite(Number(toRaw))
          ? Number(toRaw)
          : mcpTimeoutMs;
    const cmd = typeof item.command === "string" ? item.command.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
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
            ["env", "环境管理"],
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
              <input
                style={styles.input}
                type="password"
                autoComplete="new-password"
                value={modelApiKey}
                placeholder={modelApiKeyConfigured ? "已配置；输入新值可替换" : "输入 API Key"}
                onChange={(e) => setModelApiKey(e.target.value)}
              />
              <input style={styles.input} value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} />
              <button
                className="qb-btn-primary-brand"
                onClick={() => {
                  void saveModelConfig({
                    provider,
                    model: modelName,
                    ...(modelApiKey.trim() ? { apiKey: modelApiKey.trim() } : {}),
                    baseUrl: modelBaseUrl || undefined,
                  }).then((saved) => {
                    setModelApiKey("");
                    setModelApiKeyConfigured(Boolean(saved.apiKeyConfigured));
                  });
                }}
              >
                保存默认配置
              </button>
            </div>

            <h3 style={{ ...styles.subTitle, marginTop: 24 }}>Embedding 模型（向量化）</h3>
            <p className="qb-config-hint">
              用于 Experience / Memory 等落库前的文本向量化。默认走 OpenAI-compatible
              Embeddings API（如 <code>text-embedding-3-small</code>）。API Key / Base URL
              留空时复用上方默认 LLM 凭证，再回退 <code>OPENAI_API_KEY</code>。
            </p>
            <div style={styles.form}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--qb-body-fg)",
                }}
              >
                <input
                  type="checkbox"
                  checked={embeddingEnabled}
                  onChange={(e) => setEmbeddingEnabled(e.target.checked)}
                />
                启用 Embedding（关闭后召回降级为 keyword-only）
              </label>
              <input
                style={styles.input}
                value={embeddingModel}
                placeholder="模型名，如 text-embedding-3-small"
                onChange={(e) => setEmbeddingModel(e.target.value)}
              />
              <input
                style={styles.input}
                type="password"
                autoComplete="new-password"
                value={embeddingApiKey}
                placeholder={
                  embeddingApiKeyConfigured
                    ? "Embedding API Key 已配置；输入新值可替换（留空则复用默认 LLM Key）"
                    : "Embedding API Key（可选；留空复用默认 LLM / OPENAI_API_KEY）"
                }
                onChange={(e) => setEmbeddingApiKey(e.target.value)}
              />
              <input
                style={styles.input}
                value={embeddingBaseUrl}
                placeholder="Embedding Base URL（可选；留空复用默认 LLM）"
                onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
              />
              <input
                style={styles.input}
                value={embeddingDimensions}
                placeholder="输出维度（可选，如 1536；仅部分模型支持）"
                onChange={(e) => setEmbeddingDimensions(e.target.value)}
              />
              {embeddingRuntimeHint ? (
                <p className="qb-config-hint qb-config-hint--tight" style={{ margin: 0 }}>
                  运行时：{embeddingRuntimeHint}
                </p>
              ) : null}
              {embeddingTestMsg ? (
                <p className="qb-config-hint qb-config-hint--tight" style={{ margin: 0 }}>
                  {embeddingTestMsg}
                </p>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="qb-btn-primary-brand"
                  disabled={embeddingBusy}
                  onClick={() => {
                    const dimRaw = embeddingDimensions.trim();
                    const dimParsed = dimRaw ? Number(dimRaw) : null;
                    if (dimRaw && (!Number.isFinite(dimParsed) || (dimParsed ?? 0) <= 0)) {
                      setEmbeddingTestMsg("维度必须是正整数");
                      return;
                    }
                    setEmbeddingBusy(true);
                    setEmbeddingTestMsg(null);
                    void saveModelConfig({
                      embedding: {
                        enabled: embeddingEnabled,
                        model: embeddingModel.trim() || "text-embedding-3-small",
                        ...(embeddingApiKey.trim()
                          ? { apiKey: embeddingApiKey.trim() }
                          : {}),
                        baseUrl: embeddingBaseUrl.trim() || undefined,
                        dimensions: dimParsed,
                      },
                    })
                      .then((saved) => {
                        setEmbeddingApiKey("");
                        setEmbeddingApiKeyConfigured(Boolean(saved.embedding?.apiKeyConfigured));
                        setEmbeddingEnabled(saved.embedding?.enabled ?? true);
                        setEmbeddingModel(saved.embedding?.model ?? "text-embedding-3-small");
                        setEmbeddingBaseUrl(saved.embedding?.baseUrl ?? "");
                        setEmbeddingDimensions(
                          saved.embedding?.dimensions != null
                            ? String(saved.embedding.dimensions)
                            : ""
                        );
                        const rt = saved.embedding?.runtime;
                        setEmbeddingRuntimeHint(
                          rt
                            ? rt.configured
                              ? `就绪 · ${rt.model ?? "?"} · dim=${rt.dimension ?? "?"} · source=${rt.source}`
                              : `未就绪 · source=${rt.source}`
                            : "已保存"
                        );
                        setEmbeddingTestMsg("Embedding 配置已保存");
                      })
                      .catch((err: unknown) => {
                        setEmbeddingTestMsg(
                          `保存失败：${err instanceof Error ? err.message : String(err)}`
                        );
                      })
                      .finally(() => setEmbeddingBusy(false));
                  }}
                >
                  保存 Embedding 配置
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={embeddingBusy}
                  onClick={() => {
                    setEmbeddingBusy(true);
                    setEmbeddingTestMsg(null);
                    void testEmbeddingModelConfig()
                      .then((res) => {
                        if (res.ok && res.data) {
                          setEmbeddingTestMsg(
                            `探测成功：${res.data.model} · dim=${res.data.dimension} · ${res.data.latencyMs}ms · tokens=${res.data.tokensUsed}`
                          );
                        } else {
                          setEmbeddingTestMsg(`探测失败：${res.error ?? "unknown"}`);
                        }
                      })
                      .catch((err: unknown) => {
                        setEmbeddingTestMsg(
                          `探测失败：${err instanceof Error ? err.message : String(err)}`
                        );
                      })
                      .finally(() => setEmbeddingBusy(false));
                  }}
                >
                  测试 Embedding
                </button>
              </div>
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
              <strong>东方财富</strong>；配置 Wind 账号后 A 股可走 <strong>Wind</strong>；加密货币走 <strong>Binance</strong>；
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
                        | "akshare_tencent"
                        | "yfinance"
                        | "binance_crypto"
                        | "wind"
                        | "synthetic"
                    )
                  }
                >
                  <option value="auto">自动（A 股 → 东方财富 / 有 Wind 账号 → Wind；加密 → Binance；有 Tushare → 日线；其它 → Yahoo）</option>
                  <option value="eastmoney">东方财富（A 股日线 + 分钟/小时，免费）</option>
                  <option value="wind">Wind 万得（需本地终端 + WindPy）</option>
                  <option value="binance_crypto">Binance（加密货币 K 线 / 报价，公开 API）</option>
                  <option value="akshare">AKShare（A 股，需 Python: pip install akshare pandas）</option>
                  <option value="akshare_tencent">腾讯证券 / AKShare（日线独立备用源）</option>
                  <option value="yahoo_chart">Yahoo Finance Chart（TS 直连，免依赖）</option>
                  <option value="yfinance">yfinance（Python，含分红/财报/资产信息；pip install yfinance pandas）</option>
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
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <span style={{ whiteSpace: "nowrap" }}>行情网络</span>
                <select
                  style={styles.select}
                  value={marketDataNetworkMode}
                  onChange={(e) => setMarketDataNetworkMode(e.target.value as "auto" | "direct" | "proxy")}
                >
                  <option value="auto">自动（配置代理 → 环境代理 → 直连）</option>
                  <option value="direct">强制直连</option>
                  <option value="proxy">强制代理</option>
                </select>
              </label>
              <input
                style={{ ...styles.input, minWidth: 240 }}
                value={marketDataProxyUrl}
                onChange={(e) => setMarketDataProxyUrl(e.target.value)}
                placeholder="代理 URL，例如 http://127.0.0.1:7896"
              />
            </div>
            {(klinesDataSource === "wind" || klinesDataSource === "auto") ? (
              <div style={{ ...styles.form, flexWrap: "wrap", alignItems: "flex-end" }}>
                <input
                  style={{ ...styles.input, minWidth: 160 }}
                  value={windUsername}
                  onChange={(e) => setWindUsername(e.target.value)}
                  placeholder="Wind 账号（可选，终端已登录可留空）"
                  autoComplete="username"
                />
                <input
                  style={{ ...styles.input, minWidth: 160 }}
                  type="password"
                  value={windPassword}
                  onChange={(e) => setWindPassword(e.target.value)}
                  placeholder="Wind 密码（可选）"
                  autoComplete="current-password"
                />
                <input
                  style={{ ...styles.input, width: 100 }}
                  type="number"
                  min={10}
                  max={300}
                  value={windStartWaitSec}
                  onChange={(e) => setWindStartWaitSec(Number(e.target.value))}
                  placeholder="等待秒"
                  title="w.start 等待 Wind 终端响应的最长时间（秒）"
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--qb-body-fg)" }}>
                  <input
                    type="checkbox"
                    checked={windAutoLogin}
                    onChange={(e) => setWindAutoLogin(e.target.checked)}
                  />
                  凭据自动登录
                </label>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={windSessionBusy}
                  onClick={() => {
                    setWindSessionBusy(true);
                    setWindSessionError("");
                    void getWindSessionStatus()
                      .then((res) => {
                        if (res.ok && res.data) {
                          setWindSession(res.data);
                        } else {
                          setWindSessionError(res.error ?? "查询 Wind 登录态失败");
                        }
                      })
                      .catch((e) => setWindSessionError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setWindSessionBusy(false));
                  }}
                >
                  {windSessionBusy ? "查询中…" : "查询登录态"}
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={windSessionBusy}
                  onClick={() => {
                    setWindSessionBusy(true);
                    setWindSessionError("");
                    void loginWindSession({
                      username: windUsername.trim() || undefined,
                      password: windPassword.trim() || undefined,
                      startWaitSec: windStartWaitSec,
                    })
                      .then((res) => {
                        if (res.ok && res.data) {
                          setWindSession(res.data);
                        } else {
                          setWindSessionError(res.error ?? "Wind 登录失败");
                        }
                      })
                      .catch((e) => setWindSessionError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setWindSessionBusy(false));
                  }}
                >
                  登录 Wind
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={windSessionBusy}
                  onClick={() => {
                    setWindSessionBusy(true);
                    setWindSessionError("");
                    void reconnectWindSession()
                      .then((res) => {
                        if (res.ok && res.data) {
                          setWindSession(res.data);
                        } else {
                          setWindSessionError(res.error ?? "Wind 重连失败");
                        }
                      })
                      .catch((e) => setWindSessionError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setWindSessionBusy(false));
                  }}
                >
                  重新连接
                </button>
                {windSession ? (
                  <span style={{ fontSize: 12, color: windSession.connected ? "var(--qb-success-fg, #0a0)" : "var(--qb-warn-fg, #a60)" }}>
                    {windSession.connected
                      ? `已连接${windSession.userId ? ` · ${windSession.userId}` : ""}`
                      : `未连接 · ${windSession.message}`}
                  </span>
                ) : null}
                {windSessionError ? (
                  <span style={{ fontSize: 12, color: "var(--qb-danger-fg, #c00)" }}>{windSessionError}</span>
                ) : null}
              </div>
            ) : null}
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
                      windUsername: windUsername.trim() || undefined,
                      windPassword: windPassword.trim() || undefined,
                      windStartWaitSec,
                      windAutoLogin: windAutoLogin || undefined,
                      cryptoUseTestnet: cryptoUseTestnet || undefined,
                      marketDataNetworkMode,
                      marketDataProxyUrl: marketDataProxyUrl.trim() || undefined,
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
              保存并启用 Server 即可使用；默认自动覆盖全部工具（通配策略）。点击卡片打开<strong>高级 JSON 编辑</strong>，打开时会尝试探测连通性。
            </p>
            <div style={styles.meta}>
              <span>Server: {mcpServers.length}</span>
              <span>策略行: {mcpBindings.length}</span>
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
                        : specOk
                          ? { bg: "var(--qb-pill-muted-bg)", color: "var(--qb-pill-muted-fg)", text: "连通：打开卡片以检测" }
                          : { bg: "var(--qb-pill-muted-bg)", color: "var(--qb-pill-muted-fg)", text: "连通：待检测" };
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
                          {row.transport} · {row.enabled ? "启用" : "禁用"}
                          {bindCount > 0 ? ` · ${bindCount} 条策略` : ""}
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
              <summary style={styles.mcpDetailsSummary}>高级：超时 / 重试策略与快速测试（可选）</summary>
              <p className="qb-config-hint" style={{ marginTop: 0 }}>
                保存 Server 已自动启用全部工具。此处仅在需要按工具覆盖 timeout、或手动探测某个工具时使用；tool name 填 <code>*</code> 表示整 server 默认策略。
              </p>
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
                  placeholder="tool name 或 *"
                />
                <input
                  style={styles.input}
                  type="number"
                  value={mcpTimeoutMs}
                  onChange={(e) => setMcpTimeoutMs(Number(e.target.value))}
                  placeholder="timeout ms"
                />
                <button className="qb-btn-secondary" type="button" onClick={() => void saveMcpBindingNow()}>
                  保存策略
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
                const caps = Array.isArray(item.defaultCapabilitiesJson)
                  ? item.defaultCapabilitiesJson.filter((x): x is string => typeof x === "string")
                  : [];
                const defaultTool = item.defaultToolName;
                const cmdPreview = item.command ?? "";
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
                      const to = item.defaultTimeoutMs;
                      if (typeof to === "number" && Number.isFinite(to)) setMcpTimeoutMs(to);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedCatalogId(item.id);
                        setCatalogServerName(item.slug.replace(/[^a-z0-9_-]/gi, "-"));
                        if (defaultTool) setMcpToolName(defaultTool);
                        if (Number.isFinite(item.defaultTimeoutMs)) setMcpTimeoutMs(item.defaultTimeoutMs);
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
                  <summary style={styles.mcpDetailsSummarySmall}>策略列表（含默认 *）</summary>
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
        {activeConfigSubPage === "env" ? <EnvironmentPanel /> : null}
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
            draftLlmProvider={draftLlmProvider}
            setDraftLlmProvider={setDraftLlmProvider}
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
    /** 列宽由 ChatPanel 内联 gridTemplateColumns 控制（会话列表 px + 拖拽条 + 主对话区） */
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
  chatSessionsTop: {
    flexShrink: 0,
    maxHeight: 120,
    width: "100%",
    flex: "0 0 auto",
    padding: "6px 8px",
  },
  chatSessionsToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    marginBottom: 8,
    flexWrap: "nowrap",
  },
  chatSessionsToolbarTop: {
    marginBottom: 0,
    gap: 8,
    minWidth: 0,
  },
  chatSessionActions: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    marginLeft: "auto",
  },
  chatSessionActionDivider: {
    width: 1,
    height: 16,
    margin: "0 4px",
    background: "var(--qb-chat-border, #3f3f46)",
    opacity: 0.85,
  },
  chatSessionLayoutToggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
  },
  chatSessionList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflowY: "auto",
    overflowX: "hidden",
    minHeight: 0,
    flex: 1,
  },
  chatSessionListTop: {
    flexDirection: "row",
    overflowX: "auto",
    overflowY: "hidden",
    flex: "0 0 auto",
    paddingBottom: 2,
  },
  chatSessionListTopInline: {
    flex: "1 1 auto",
    minWidth: 0,
    marginBottom: 0,
  },
  chatSessionItemTop: {
    minWidth: 132,
    maxWidth: 200,
    flex: "0 0 auto",
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
    width: "100%",
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
  errorText: { fontSize: 12, color: "#fca5a5", marginTop: 6 },
};

// ─── TeamDashboardPanel ───────────────────────────────────────────────────────

/** 团队页大三栏 key —— 用于显隐控制 / localStorage 序列化 */
type TeamPaneKey = "left" | "center" | "right";
const TEAM_PANES: readonly TeamPaneKey[] = ["left", "center", "right"];
const TEAM_PANE_LABEL: Record<TeamPaneKey, string> = {
  left: "研究与工作流",
  center: "研究画布",
  right: "Orchestrator 对话",
};
const TEAM_PANES_LS_KEY = "qubit-agent.teamPanes.hidden.v1";
/** 画布可多选高亮的团队成员角色（与后端研究团队槽位一致；空集表示不过滤） */
/** 拓扑画布固定视口高度，避免 ResizeObserver↔SVG 高度互相撑开导致无限增高 */
/**
 * topology 视图最小 / 最大高度。原来死扣在 360px，11+ 个 Agent 节点 dagre
 * 布局后纵向压扁、节点和边线挤成一坨（产品截图反馈过）。
 *
 * 现在改成"按节点数 + 视口高度"动态计算的方式：
 *   - 起步 360（少节点时不浪费空间）
 *   - 每多 1 个节点加 ~36px
 *   - 不超过当前视口的 58%（避免画布把下方实时对话流挤光）
 *   - 也不超过硬上限 720
 *
 * 计算逻辑封装在 `computeTopologyHeight()` 里。
 */
const TEAM_GRAPH_VIEWPORT_MIN_HEIGHT = 360;
const TEAM_GRAPH_VIEWPORT_MAX_HEIGHT = 720;
const TEAM_GRAPH_VIEWPORT_PER_NODE = 36;

function computeTopologyHeight(nodeCount: number, viewportHeight: number): number {
  const byCount = TEAM_GRAPH_VIEWPORT_MIN_HEIGHT + Math.max(0, nodeCount - 6) * TEAM_GRAPH_VIEWPORT_PER_NODE;
  const byViewport = Math.floor(viewportHeight * 0.58);
  return Math.max(
    TEAM_GRAPH_VIEWPORT_MIN_HEIGHT,
    Math.min(TEAM_GRAPH_VIEWPORT_MAX_HEIGHT, byViewport, byCount),
  );
}

const TeamDashboardPanel: FC = () => {
  const [ticker, setTicker] = useState("");
  const [scopeMode, setScopeMode] = useState<ResearchScopeMode>("single");
  const [basketTickers, setBasketTickers] = useState("");
  const [sectorName, setSectorName] = useState("");
  const [sectorPeers, setSectorPeers] = useState("");
  /**
   * 2026-05-26 修复：scope 模式各自独立 state，**不再用预填默认值**（旧实现把
   * sectorPeers 默认为 "NVDA,AMD,AVGO" 导致 goal=板块·AAPL 时实际跑 NVDA 系列）。
   * 用户在每个模式下都得自己输入，避免跨模式数据残留。
   */
  const [exploreTheme, setExploreTheme] = useState("");
  const [exploreCandidates, setExploreCandidates] = useState("");
  const [researchInstrument, setResearchInstrument] = useState<ResearchInstrumentUi>("equity_long");
  const [optionUnderlying, setOptionUnderlying] = useState("");
  const [optionContract, setOptionContract] = useState("");
  const [optionExpiry, setOptionExpiry] = useState("");
  const [optionStrike, setOptionStrike] = useState("");
  const [optionRight, setOptionRight] = useState<"call" | "put" | "">("call");
  /** 右侧 Orchestrator 输入框的研究上下文。 */
  const [teamAnalysisContext, setTeamAnalysisContext] = useState("");
  const [promptTemplateId, setPromptTemplateId] = useState("");
  /**
   * Agent 底座/引擎：团队里每个角色单轮 reason 用哪个引擎
   * （docs/CLI_AGENT_PROJECTION_DESIGN.md 模型 B）。写入 loopOptions.roleReasoner，
   * 与 loop_kind 正交——仍走 MSA 编排，仅替换角色 reason 引擎。
   */
  const [roleReasoner, setRoleReasoner] = useState<AgentLoopKind>("native");
  /** Agent / Plan / Goal 工作模式；与上面的推理引擎选择正交。 */
  const teamAgentMode = useAppStore((s) => s.agentControlMode);
  const setTeamAgentMode = useAppStore((s) => s.setAgentControlMode);
  const selectedConversationSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedConversationSessionId = useAppStore((s) => s.setSelectedSessionId);

  /**
   * 切换 scope 模式时清空"上一模式特有"的输入，避免数据串台到下一次提交。
   * 这是用户在 Q3 抱怨"goal 是 AAPL 实际跑 NVDA" 的另一道防线。
   *
   * 2026-05-27 P0-2 加固：之前实现只清 promptTemplateId，导致 `instrument='option'
   * + optionContract='ASTSCall 2026.5.29'` 残留到下一次"单标的 RKLB"提交，
   * `buildResearchScopePayload` 看到 `instrument==='option'` 直接用 optionContract
   * 当 ticker，结果 workflow_run.goal=RKLB 但 analyst_research_job.ticker=
   * "期权·ASTSCall 2026.5.29" —— Orchestrator kickoff 标的也错（WF 9adf5d91 实测）。
   *
   * 现在切 mode 时一并：
   *   - basket → 切到非 basket 时清空 basketTickers
   *   - sector → 切到非 sector 时清空 sectorName / sectorPeers
   *   - explore → 切到非 explore 时清空 exploreTheme / exploreCandidates
   *   - instrument: 切到 basket / sector / explore 时强制回 equity_long，
   *     避免"篮子 + 期权"这种非法组合穿透
   *   - 期权字段：所有非 single 模式都清空（option 模式只在 single 下有意义）
   */
  const handleScopeModeChange = (next: ResearchScopeMode) => {
    if (next === scopeMode) return;
    setPromptTemplateId("");
    if (scopeMode === "basket" && next !== "basket") setBasketTickers("");
    if (scopeMode === "sector" && next !== "sector") {
      setSectorName("");
      setSectorPeers("");
    }
    if (scopeMode === "explore" && next !== "explore") {
      setExploreTheme("");
      setExploreCandidates("");
    }
    if (next !== "single") {
      setResearchInstrument("equity_long");
      setOptionUnderlying("");
      setOptionContract("");
      setOptionExpiry("");
      setOptionStrike("");
      setOptionRight("call");
    }
    setScopeMode(next);
  };

  /**
   * 工具类型切换：从 option 切回 equity_long / equity_short 时清空 option_* 残留，
   * 同样为防止跨次提交污染 scope payload。
   */
  const handleResearchInstrumentChange = (next: ResearchInstrumentUi) => {
    if (next === researchInstrument) return;
    if (researchInstrument === "option" && next !== "option") {
      setOptionUnderlying("");
      setOptionContract("");
      setOptionExpiry("");
      setOptionStrike("");
      setOptionRight("call");
    }
    setResearchInstrument(next);
  };

  const availablePromptTemplates = useMemo(
    () => filterPromptTemplates(scopeMode, researchInstrument),
    [scopeMode, researchInstrument]
  );
  const applyPromptTemplate = (id: string) => {
    setPromptTemplateId(id);
    if (!id) return;
    const tpl = availablePromptTemplates.find((t) => t.id === id);
    if (tpl) setTeamAnalysisContext(tpl.prompt);
  };

  const [workflowRunId, setWorkflowRunId] = useState("");
  const [workflowOptions, setWorkflowOptions] = useState<Array<Record<string, unknown>>>([]);
  const [workflowKindFilter, setWorkflowKindFilter] = useState<WorkflowKind | "all">("all");
  const [running, setRunning] = useState(false);
  /** 右侧 composer 对话走 Orchestrator ReAct；与团队运行态分离。 */
  const [orchestratorChatInFlight, setOrchestratorChatInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 工作流面板的成功/中性提示（区别于上方红色 error callout）。 */
  const [workflowNotice, setWorkflowNotice] = useState<string | null>(null);

  /**
   * Agent 心跳：把当前选中 workflow 下所有 agent instance 的活跃度暴露给前端，
   * 解决"无法看到 Agent 是否还在 loop 中"的问题。
   *
   * 心跳数据走 SSE 推流（GET /agent-heartbeats/stream），替代原来的 4s polling。
   *   - 多 tab 订阅同一 workflow 时后端只跑一份 4s tick（共享 controller）
   *   - workflow 终态时服务端主动 close，前端不需要再 polling 已结束的工作流
   *   - 跟 debate stream / step stream 风格一致，便于以后做实时拓扑高亮
   * SSE 连接失败时降级到一次性 polling，保证至少能展示静态快照。
   *
   * 注意：这块必须放在 `workflowRunId` 的 useState 之后，因为 useEffect 依赖
   * 该变量；之前一次重构把 useState 放到了下方导致 TDZ 错误（TS2448/TS2454）。
   */
  const [agentHeartbeats, setAgentHeartbeats] =
    useState<import("../../api/backend").WorkflowAgentHeartbeatsResponse | null>(null);
  useEffect(() => {
    if (!workflowRunId.trim()) {
      setAgentHeartbeats(null);
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let didFallbackToPoll = false;

    void (async () => {
      const {
        subscribeWorkflowHeartbeatStream,
        getWorkflowAgentHeartbeats,
      } = await import("../../api/backend");
      if (cancelled) return;

      unsubscribe = subscribeWorkflowHeartbeatStream({
        workflowId: workflowRunId,
        callbacks: {
          onSnapshot: (snap) => {
            if (cancelled) return;
            setAgentHeartbeats(snap);
          },
          onEnd: () => {
            /** 服务端会在 onEnd 后再延迟关流；这里不主动 abort，让最后一帧到位。 */
          },
          onError: async () => {
            if (cancelled || didFallbackToPoll) return;
            didFallbackToPoll = true;
            /** SSE 失败 → 单次 polling 兜底（不再继续轮询，避免回到老的浪费节奏）。 */
            try {
              const fallback = await getWorkflowAgentHeartbeats(workflowRunId);
              if (!cancelled) setAgentHeartbeats(fallback);
            } catch {
              if (!cancelled) setAgentHeartbeats(null);
            }
          },
        },
      });
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [workflowRunId]);
  /**
   * 行内"硬删除"双击确认状态：第一次点变 pending，3 秒内再点才真正执行；
   * 避免 window.confirm 在某些 webview / 浏览器下被静默拦截、用户误以为按钮失效。
   */
  const [pendingHardDeleteWfId, setPendingHardDeleteWfId] = useState<string | null>(null);
  /** 左侧会话列表仅按关键字检索；执行状态留给后台监控。 */
  const [workflowListQuery, setWorkflowListQuery] = useState("");
  /** 研究画布行情区：多标的网格 vs 单图焦点 */
  const [marketKlineLayout, setMarketKlineLayout] = useState<"grid" | "single">("grid");
  /** 左栏：FS 课题树 vs 原工作流配置 */
  const [leftRailMode, setLeftRailMode] = useState<"workspace" | "workflow">(() => {
    try {
      return window.localStorage.getItem("qb.team.leftRailMode") === "workflow"
        ? "workflow"
        : "workspace";
    } catch {
      return "workspace";
    }
  });
  const [runStripExpanded, setRunStripExpanded] = useState(() => {
    try {
      return window.localStorage.getItem("qb.team.runStripExpanded") !== "0";
    } catch {
      return true;
    }
  });
  const [creatingTeamWorkflow, setCreatingTeamWorkflow] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem("qb.team.leftRailMode", leftRailMode);
    } catch {
      /* ignore */
    }
  }, [leftRailMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem("qb.team.runStripExpanded", runStripExpanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [runStripExpanded]);

  const fsWorkspaceCreateDefaults = useMemo(() => {
    const symbolsRaw =
      scopeMode === "basket"
        ? parseSymbolList(basketTickers || ticker)
        : scopeMode === "sector"
          ? [...parseSymbolList(sectorPeers), ...parseSymbolList(ticker)]
          : scopeMode === "explore"
            ? parseSymbolList(exploreCandidates)
            : researchInstrument === "option"
              ? parseSymbolList(optionUnderlying || ticker)
              : parseSymbolList(ticker);
    const symbols = [...new Set(symbolsRaw)].slice(0, 32).map((symbol) => ({
      symbol,
      exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(symbol)),
    }));
    const focusSym = symbols[0]?.symbol || ticker.trim().toUpperCase();
    return {
      name:
        `${scopeModeLabel(scopeMode)} · ${focusSym || sectorName || exploreTheme || "课题"}`.slice(
          0,
          80
        ),
      mode: scopeMode,
      symbols,
      focus: focusSym
        ? {
            symbol: focusSym,
            exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(focusSym)),
          }
        : undefined,
    };
  }, [
    scopeMode,
    basketTickers,
    ticker,
    sectorPeers,
    exploreCandidates,
    researchInstrument,
    optionUnderlying,
    sectorName,
    exploreTheme,
  ]);

  /**
   * 团队页大三栏（左：研究与工作流 / 中：研究画布 / 右：研究产出）的显隐控制。
   *
   * - state 用 Set<TeamPaneKey> 表示**被隐藏**的栏（默认空 = 三栏全显）
   * - localStorage 持久化，刷新后保持
   * - 至少保留一栏可见，避免空白工作台无法操作
   * - 隐藏的栏对应的 gutter（resize 把手）也一起 unmount，否则中间会出现孤儿手柄
   *
   * `TEAM_PANES` / `TEAM_PANE_LABEL` 提到组件外为模块常量，避免每次 render 重建
   * 触发 useCallback / useEffect 的依赖数组警告。
   */
  const [hiddenTeamPanes, setHiddenTeamPanes] = useState<Set<TeamPaneKey>>(() => {
    try {
      const raw = localStorage.getItem(TEAM_PANES_LS_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return new Set();
      const allowed = new Set<TeamPaneKey>(TEAM_PANES);
      return new Set(arr.filter((v): v is TeamPaneKey => allowed.has(v as TeamPaneKey)));
    } catch {
      return new Set();
    }
  });
  const persistHiddenTeamPanes = useCallback((next: Set<TeamPaneKey>) => {
    try {
      localStorage.setItem(TEAM_PANES_LS_KEY, JSON.stringify([...next]));
    } catch {
      /* localStorage 不可用 / quota exceeded 时静默；UI 状态本地仍然生效 */
    }
  }, []);
  const toggleTeamPane = useCallback(
    (pane: TeamPaneKey) => {
      setHiddenTeamPanes((prev) => {
        const next = new Set(prev);
        if (next.has(pane)) {
          next.delete(pane);
        } else {
          /** 至少保留一栏可见 */
          if (TEAM_PANES.length - next.size <= 1) return prev;
          next.add(pane);
        }
        persistHiddenTeamPanes(next);
        return next;
      });
    },
    [persistHiddenTeamPanes],
  );
  const teamPaneVisible = useCallback(
    (pane: TeamPaneKey) => !hiddenTeamPanes.has(pane),
    [hiddenTeamPanes],
  );

  /** 专业壳：Orchestrator 右栏外挂到 ProAgentPanel，避免双右栏 */
  const interfaceMode = useAppStore((s) => s.interfaceMode);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const agentDock = useAgentDockOptional();
  const proDockAgent = interfaceMode === "advanced" && Boolean(agentDock);
  const showInlineTeamRight = teamPaneVisible("right") && !proDockAgent;
  const rightEffectivelyPresent = teamPaneVisible("right") || proDockAgent;

  useEffect(() => {
    if (!agentDock) return;
    if (!proDockAgent) {
      if (agentDock.source === "team") agentDock.setSource(null);
      return;
    }
    agentDock.setSource("team");
    setAgentPanelOpen(true);
    return () => {
      agentDock.setSource(null);
    };
  }, [agentDock, proDockAgent, setAgentPanelOpen]);

  /**
   * Token 级流式：workflow firehose 推来的、尚未落库的「在飞」LLM 输出，按 role 累积。
   * 每条在 displayedLiveFeedEvents 里合成一个 `streaming:${role}` 气泡逐字显示。
   *
   * 这里故意只保存该 role 当前一轮的 buffer；已经收口的轮次由 agent_step.reason
   * 回填为「过程说明」事件（见 displayedLiveFeedEvents），这样既逐字流式，又不会在
   * 工具调用后丢失前一轮文字。
   */
  const [streamingByRole, setStreamingByRole] = useState<
    Record<string, { text: string; ts: string }>
  >({});
  /**
   * 已「收口」的 role 集合：某 role 的当前流式段已收到 observe/step_persisted/final，
   * 文本不再追加、等待持久化消息接管。下一轮首个 token 到来时据此重置该 role 文本
   * （避免多轮 ReAct 文本无限拼接），teamGraph 带出对应 reason step 后被清空。
   */
  const settledRolesRef = useRef<Set<string>>(new Set());
  /** 收口事件防抖回拉 teamGraph 的 timer（chat 路径无 2.5s 轮询，靠它带出最终答复）。 */
  const settleRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Coding-Agent 体验 P1：Orchestrator 分步计划/TODO + 当前「正在调用什么、为何」活动行。 */
  const [teamPlan, setTeamPlan] = useState<OrchestratorPlan | null>(null);
  const [activeRationale, setActiveRationale] = useState<{
    tool: string;
    why: string;
    ts: number;
  } | null>(null);
  /**
   * Orchestrator 右栏：缓存 firehose 近时 step 事件（工具起止 / A2A），
   * 供 Cursor 风格运行态条与 ChatExecutionActivity 使用。
   * 切换 workflow 时清空；容量上限避免内存膨胀。
   */
  const [orchestratorStreamEvents, setOrchestratorStreamEvents] = useState<StepStreamEvent[]>(
    []
  );
  /**
   * 用户在右侧 Orchestrator 对话框发出的提示词回显（启动指令 / 运行中插话）。
   * 合成成 fromRole="user" 的消息事件并入实时流，让用户看到自己说过什么。
   */
  const [userEchoes, setUserEchoes] = useState<Array<{ id: string; content: string; ts: string }>>(
    []
  );
  const pushUserEcho = useCallback((content: string) => {
    const text = content.trim();
    if (!text) return;
    setUserEchoes((prev) =>
      [...prev, { id: `ue-${Date.now()}-${prev.length}`, content: text, ts: new Date().toISOString() }].slice(-50)
    );
  }, []);
  /** 本工作流已生成的产物（内联在右栏对话框顶部，点击可打开到量化工坊）。 */
  const [teamArtifacts, setTeamArtifacts] = useState<OrchestratorArtifact[]>([]);
  const [teamArtifactsLoading, setTeamArtifactsLoading] = useState(false);
  const [teamArtifactsError, setTeamArtifactsError] = useState<string | null>(null);

  const [teamGraph, setTeamGraph] = useState<AnalystTeamGraphPayload | null>(null);
  const [graphSelection, setGraphSelection] = useState<TeamGraphSelection>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [teamGraphView, setTeamGraphView] = useState<"topology" | "office">("topology");
  /** 研究中栏画布：拓扑 / 行情 / 新闻 / 工具结果 */
  const [researchCanvasTab, setResearchCanvasTab] = useState<
    "topology" | "market" | "news" | "tools"
  >("topology");
  const lastLinkedToolIdRef = useRef<string | null>(null);
  /**
   * 注：原 `strategyScripts` / `workflowArtifactHint` / `teamCodePick` / 多个 store
   * setter 服务于已删除的「策略与代码」details 块；state / handler / setter 全部
   * 清理。需要把 Agent 产出的代码片段拉到 IDE / 实盘页时，请走量化工坊（onOpenStrategyInComposer）。
   */
  const [teamResearchProjectId, setTeamResearchProjectId] = useState("");
  const [teamResearchSessionId, setTeamResearchSessionId] = useState("");
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  const setQuantContext = useAppStore((s) => s.setQuantContext);
  const chartSpec = useAppStore((s) => s.chartSpec);
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const chartReloadNonce = useAppStore((s) => s.chartReloadNonce);
  const requestChartReload = useAppStore((s) => s.requestChartReload);

  const teamTriRef = useRef<HTMLDivElement | null>(null);
  const [teamLeftW, setTeamLeftW] = useState(268);
  const [teamRightW, setTeamRightW] = useState(400);
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
      setTeamPlan(g?.plan ?? null);
      if (!opts?.preserveSelection) setGraphSelection(null);
    } finally {
      setGraphLoading(false);
    }
  }, [workflowRunId]);

  /**
   * 稳定 ref 持有最新 loadTeamGraph，供 SSE 订阅里的收口回拉调用，
   * 避免把 loadTeamGraph 加进订阅 effect 依赖而频繁重订阅（保持 firehose 连接稳定）。
   */
  const loadTeamGraphRef = useRef(loadTeamGraph);
  useEffect(() => {
    loadTeamGraphRef.current = loadTeamGraph;
  }, [loadTeamGraph]);

  const refreshWorkflowOptionsRef = useRef(refreshWorkflowOptions);
  useEffect(() => {
    refreshWorkflowOptionsRef.current = refreshWorkflowOptions;
  }, [refreshWorkflowOptions]);

  useEffect(() => {
    const refreshVisibleList = () => {
      if (document.visibilityState === "visible") {
        void refreshWorkflowOptionsRef.current();
      }
    };
    window.addEventListener("focus", refreshVisibleList);
    document.addEventListener("visibilitychange", refreshVisibleList);
    const timer = window.setInterval(refreshVisibleList, 15_000);
    return () => {
      window.removeEventListener("focus", refreshVisibleList);
      document.removeEventListener("visibilitychange", refreshVisibleList);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void loadTeamGraph();
  }, [loadTeamGraph]);

  /** 分析 / orchestrator-chat 进行中轮询拓扑与台账，便于右栏对话实时更新 */
  useEffect(() => {
    if ((!running && !orchestratorChatInFlight) || !workflowRunId.trim()) return;
    void loadTeamGraph({ preserveSelection: true });
    const id = window.setInterval(() => {
      void loadTeamGraph({ preserveSelection: true });
    }, 2500);
    return () => window.clearInterval(id);
  }, [running, orchestratorChatInFlight, workflowRunId, loadTeamGraph]);

  const mergedLiveFeedRows = useMemo(() => {
    type Row = { key: string; t: number; kind: "interaction" | "debate"; body: string };
    const rows: Row[] = [];
    // 实时流跟随活动拓扑：不按固定槽位白名单裁剪，任意被调用的 Agent 交互都可见
    for (const row of teamGraph?.interactions ?? []) {
      rows.push({
        key: `i-${row.id}`,
        t: new Date(row.createdAt).getTime() || 0,
        kind: "interaction",
        body: `${describeInteractionRouting(row)} · ${row.kind}${row.toolName ? ` · ${row.toolName}` : ""}\n${row.contentText.slice(0, 1200)}`,
      });
    }
    return rows.sort((a, b) => a.t - b.t).slice(-200);
  }, [teamGraph]);

  const liveFeedScrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 实时对话流的自动跟随开关：
   * - 默认开启，新消息进来时滚到底；
   * - 用户主动往上滚（离底部 > 64px）会自动暂停，便于回看上方对话；
   * - 用户再滚回底部附近自动恢复；
   * - 标题栏也提供显式 checkbox 控制。
   * `liveFeedAtBottom` 仅用于决定是否显示"↓ 跳到最新"浮按钮。
   */
  const [liveFeedAutoFollow, setLiveFeedAutoFollow] = useState(true);
  const [liveFeedAtBottom, setLiveFeedAtBottom] = useState(true);
  const liveFeedAutoFollowRef = useRef(true);
  useEffect(() => {
    liveFeedAutoFollowRef.current = liveFeedAutoFollow;
  }, [liveFeedAutoFollow]);

  /**
   * 实时对话流 / Agent 运行对话流各自的"折叠"开关（持久化到 localStorage）：
   * - 折叠态：ResizableY 的高度退化为 `auto`，只剩顶部 header + 统计行；
   * - 展开态：恢复用户上次记忆的拖拽高度；
   * - 两个窗口独立控制，方便屏幕空间紧张时只折叠不关心的那一个。
   */
  const LIVE_FEED_COLLAPSED_LS = "qb.live-feed-collapsed";
  const AGENT_RUN_COLLAPSED_LS = "qb.agent-run-collapsed";
  const [liveFeedCollapsed, setLiveFeedCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(LIVE_FEED_COLLAPSED_LS) === "1";
  });
  const [agentRunCollapsed, setAgentRunCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AGENT_RUN_COLLAPSED_LS) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LIVE_FEED_COLLAPSED_LS, liveFeedCollapsed ? "1" : "0");
  }, [liveFeedCollapsed]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AGENT_RUN_COLLAPSED_LS, agentRunCollapsed ? "1" : "0");
  }, [agentRunCollapsed]);
  const scrollLiveFeedToBottom = useCallback(() => {
    const el = liveFeedScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setLiveFeedAtBottom(true);
    setLiveFeedAutoFollow(true);
  }, []);
  const handleLiveFeedScroll = useCallback(() => {
    const el = liveFeedScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 24;
    setLiveFeedAtBottom(atBottom);
    if (atBottom) {
      if (!liveFeedAutoFollowRef.current) setLiveFeedAutoFollow(true);
    } else if (distanceFromBottom > 64 && liveFeedAutoFollowRef.current) {
      setLiveFeedAutoFollow(false);
    }
  }, []);

  const filteredGraphDisplay = useMemo((): AnalystTeamGraphPayload | null => {
    if (!teamGraph) return null;
    // 默认只展示 user + orchestrator；任意其他 Agent 在被调用后才入图（不钉死角色类型）
    return buildFilteredTeamGraphDisplay(teamGraph);
  }, [teamGraph]);

  const researchCanvasToolHits = useMemo(
    () =>
      buildResearchCanvasToolHits({
        toolCalls: teamGraph?.toolCalls,
        mcpCalls: teamGraph?.mcpCalls,
        limit: 100,
      }),
    [teamGraph]
  );

  /** 行情 Tab：焦点 + 研究范围 + 工具联动标的 → 多标的网格 */
  const researchMarketSymbols = useMemo(
    () =>
      buildResearchMarketSymbolList({
        focusSymbol: chartSpec.symbol,
        focusExchange: chartSpec.exchange,
        scope: {
          mode: scopeMode,
          ticker,
          basketTickers,
          sectorPeers,
          exploreCandidates,
          instrument: researchInstrument,
          optionUnderlying,
        },
        toolHits: researchCanvasToolHits,
        limit: 8,
      }),
    [
      chartSpec.symbol,
      chartSpec.exchange,
      scopeMode,
      ticker,
      basketTickers,
      sectorPeers,
      exploreCandidates,
      researchInstrument,
      optionUnderlying,
      researchCanvasToolHits,
    ]
  );

  const applyCanvasMarketLink = useCallback(
    (hit: ResearchCanvasToolHit, tab: "market" | "news") => {
      if (hit.symbol) {
        setChartSpec({
          symbol: hit.symbol,
          ...(hit.exchange
            ? { exchange: coerceChartMarketExchange(hit.exchange) }
            : {}),
        });
        requestChartReload();
      }
      setResearchCanvasTab(tab);
    },
    [requestChartReload, setChartSpec]
  );

  // 工具联动：新的成功行情/新闻调用自动同步标的；每个 workflow 首次命中时切到对应画布。
  useEffect(() => {
    const link = latestSuccessfulMarketLink(researchCanvasToolHits);
    if (!link?.symbol) return;
    if (lastLinkedToolIdRef.current === link.id) return;
    const isFirst = lastLinkedToolIdRef.current == null;
    lastLinkedToolIdRef.current = link.id;
    setChartSpec({
      symbol: link.symbol,
      ...(link.exchange ? { exchange: coerceChartMarketExchange(link.exchange) } : {}),
    });
    requestChartReload();
    if (isFirst) {
      setResearchCanvasTab(link.kind === "news" ? "news" : "market");
    }
  }, [researchCanvasToolHits, requestChartReload, setChartSpec]);

  useEffect(() => {
    lastLinkedToolIdRef.current = null;
  }, [workflowRunId]);

  // 左栏研究范围 → 画布标的联动（单标的/篮子首标/板块成分首标/期权标的）
  useEffect(() => {
    const patch = chartPatchFromResearchScope({
      mode: scopeMode,
      ticker,
      basketTickers,
      sectorPeers,
      exploreCandidates,
      instrument: researchInstrument,
      optionUnderlying,
    });
    if (!patch) return;
    if (
      chartSpec.symbol.toUpperCase() === patch.symbol &&
      chartSpec.exchange.toUpperCase() === patch.exchange
    ) {
      return;
    }
    setChartSpec(patch);
    requestChartReload();
    // 仅在用户改左栏研究范围时写入；不把 chartSpec 放进依赖，避免工具联动后回写互踢
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [
    scopeMode,
    ticker,
    basketTickers,
    sectorPeers,
    exploreCandidates,
    researchInstrument,
    optionUnderlying,
    requestChartReload,
    setChartSpec,
  ]);

  /** 右栏「专家进度」：从 graph + 流式态 + 心跳推导已派发子 Agent。 */
  const subAgentRuns = useMemo(() => {
    const heartbeatsByRole: Record<string, { alive: boolean; lastPhase?: string | null }> = {};
    for (const hb of agentHeartbeats?.heartbeats ?? []) {
      if (!hb.role) continue;
      heartbeatsByRole[hb.role] = { alive: hb.alive, lastPhase: hb.lastPhase };
    }
    return buildSubAgentRunSummaries({
      graph: teamGraph,
      streamingByRole,
      workflowRunning: running || orchestratorChatInFlight,
      heartbeatsByRole,
    });
  }, [teamGraph, streamingByRole, running, orchestratorChatInFlight, agentHeartbeats]);

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
        body: `${describeInteractionRouting(row)} · ${row.kind}${row.toolName ? ` · ${row.toolName}` : ""}\n${row.contentText.slice(0, 4000)}`,
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
          payloadJson: row.payloadJson,
        });
      }
      return events;
    }
    const persistedUserContents = new Set<string>();
    for (const row of teamGraph?.interactions ?? []) {
      if (row.fromRole === "user") persistedUserContents.add(row.contentText.trim());
      events.push({
        kind: "message",
        id: `i-${row.id}`,
        ts: row.createdAt,
        fromRole: row.fromRole,
        toRole: row.toRole,
        messageKind: row.kind,
        toolName: row.toolName,
        contentText: row.contentText,
        payloadJson: row.payloadJson,
      });
    }
    // 用户提示词回显：合成 fromRole="user" 的消息事件，让用户即时看到自己发过的指令/插话。
    // 后端已把同样的提示词落库为 user→orchestrator 交互（约 2.5s 后随轮询出现）；这里对已
    // 落库的同内容回显去重，避免乐观回显与持久化交互并列成两条。
    for (const e of userEchoes) {
      if (persistedUserContents.has(e.content.trim())) continue;
      events.push({
        kind: "message",
        id: e.id,
        ts: e.ts,
        fromRole: "user",
        toRole: "orchestrator",
        messageKind: "llm_message",
        contentText: e.content,
      });
    }
    /**
     * ReAct 的 reason step 是模型本轮的可见过程说明（例如调用理由），不是供应商的
     * 隐藏思维链。原来右栏只读取 interaction：中间轮次只存在 agent_step，因而在
     * 工具调用后看起来只剩最后一段终态答复。把 Orchestrator 的已收口 reason step
     * 并入同一时间线，令每一轮可回看；终态正文相同的那一段交由正式消息呈现，避免重影。
     */
    const finalAnswerTexts = new Set(
      (teamGraph?.interactions ?? [])
        .filter(
          (row) =>
            row.fromRole === "orchestrator" &&
            row.toRole === "user" &&
            row.kind === "llm_message" &&
            row.payloadJson &&
            typeof row.payloadJson === "object" &&
            (row.payloadJson as Record<string, unknown>).phase === "workflow_final_answer"
        )
        .map((row) => row.contentText.trim())
        .filter(Boolean)
    );
    for (const step of teamGraph?.agentSteps ?? []) {
      if (step.agentRole !== "orchestrator" || step.phase !== "reason") continue;
      const text = stripToolCallSentinels(step.thought).trim();
      if (!text || text === "Reasoning with LLM provider" || finalAnswerTexts.has(text)) continue;
      events.push({
        kind: "message",
        id: `reason-step:${step.id}`,
        ts: step.createdAt,
        fromRole: "orchestrator",
        toRole: "user",
        messageKind: "reasoning_progress",
        contentText: text,
        payloadJson: { phase: "reasoning_progress", stepIndex: step.stepIndex },
      });
    }
    // 合成 token 级「在飞」流式气泡：每个有累积文本的 role 一个，置于队尾（ts=now 兜底）。
    for (const [role, s] of Object.entries(streamingByRole)) {
      const text = stripToolCallSentinels(s.text).trim();
      if (!text) continue;
      // agent_step 已拿到同一份完整 reason 文本时，用持久化的「过程说明」接管，
      // 而非任意同 role 的工具记录。旧逻辑在 tool_call 写库后就删流，正是右栏只剩
      // 最后一段文本的原因。
      const covered = events.some(
        (ev) =>
          ev.kind === "message" &&
          ev.fromRole === role &&
          ev.messageKind === "reasoning_progress" &&
          ev.contentText.trim() === text
      );
      if (covered) continue;
      events.push({
        kind: "message",
        id: `streaming:${role}`,
        ts: s.ts,
        fromRole: role,
        toRole: role === "orchestrator" ? "user" : "orchestrator",
        messageKind: "reasoning_progress",
        contentText: `${text} ▌`,
        payloadJson: { phase: "reasoning_progress", streaming: true },
      });
    }
    return events
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .slice(-200);
  }, [graphSelection, graphEdgeDetail, teamGraph, streamingByRole, userEchoes]);

  /**
   * Token 级流式订阅：研究团队 tab + 有 workflow 时，连 workflow firehose，把各 agent 的
   * token 逐字累积到 streamingByRole。整条工作流共用一条 SSE（不按 run 数翻倍）。
   *
   * 收口（step_persisted/final/observe/error）不再立即删在飞气泡——那会让流式文本「闪一下
   * 变空白」、且 chat 路径没有 2.5s 轮询去接管。改为：标记该 role 已收口，让气泡留在屏上
   * 直到 teamGraph 带出对应 agent_step.reason 再平滑替换（见下方 prune effect + displayedLiveFeed 去重）。
   * 终态事件（final/error）额外防抖回拉一次 teamGraph，带出 orchestrator 跑完后才落库的最终答复。
   */
  useEffect(() => {
    const wf = workflowRunId.trim();
    if (!wf) return;
    setStreamingByRole({});
    setUserEchoes([]);
    setTeamPlan(null);
    setActiveRationale(null);
    setOrchestratorStreamEvents([]);
    settledRolesRef.current = new Set();
    const ORCHESTRATOR_STREAM_CAP = 120;
    const unsubscribe = subscribeWorkflowEvents({
      workflowId: wf,
      onEvent: (event) => {
        const role = event.role || "unknown";
        if (
          event.type === "tool_call_start" ||
          event.type === "tool_call_end" ||
          (event.source === "a2a" && event.type !== "token")
        ) {
          setOrchestratorStreamEvents((prev) => [...prev, event].slice(-ORCHESTRATOR_STREAM_CAP));
        }
        if (event.type === "plan") {
          // Coding-Agent 体验 P1：分步计划/TODO 快照 → 右栏计划卡片。
          const steps = Array.isArray(event.payload?.["steps"])
            ? (event.payload["steps"] as OrchestratorPlan["steps"])
            : [];
          const mode = event.payload?.["mode"];
          const goal = event.payload?.["goal"];
          setTeamPlan({
            steps,
            updatedAt: String(event.payload?.["updatedAt"] ?? ""),
            ...(mode === "agent" || mode === "plan" || mode === "goal" ? { mode } : {}),
            ...(goal && typeof goal === "object"
              ? { goal: goal as NonNullable<OrchestratorPlan["goal"]> }
              : {}),
          });
          return;
        }
        if (event.type === "tool_rationale") {
          // 当前正在做什么 + 为什么（露给用户）；下个理由替换，终态清空。
          setActiveRationale({
            tool: String(event.payload?.["targetName"] ?? event.payload?.["toolName"] ?? ""),
            why: String(event.payload?.["why"] ?? ""),
            ts: event.ts,
          });
          return;
        }
        if (event.type === "token") {
          const piece = String(event.payload?.["token"] ?? event.payload?.["text"] ?? "");
          if (!piece) return;
          // 上一段已收口 → 新轮首个 token 重置该 role 文本（否则多轮 ReAct 会无限拼接）。
          const resetting = settledRolesRef.current.delete(role);
          setStreamingByRole((prev) => ({
            ...prev,
            [role]: {
              text: (resetting ? "" : (prev[role]?.text ?? "")) + piece,
              ts: new Date(event.ts).toISOString(),
            },
          }));
        } else if (
          event.type === "step_persisted" ||
          event.type === "final" ||
          event.type === "observe" ||
          event.type === "error"
        ) {
          // 该 role 的一步已收口：标记（不删），保留流式文本等持久化消息接管。
          settledRolesRef.current.add(role);
          if (event.type === "final" || event.type === "error") {
            setActiveRationale(null); // 终态：清掉「正在调用」活动行
            setOrchestratorChatInFlight(false);
            setRunProgress("");
            // chat 路径：终态后 orchestrator→user 答复才落库，防抖回拉 + 刷新工作流状态。
            if (settleRefetchTimerRef.current) clearTimeout(settleRefetchTimerRef.current);
            settleRefetchTimerRef.current = setTimeout(() => {
              void loadTeamGraphRef.current({ preserveSelection: true });
              void refreshWorkflowOptionsRef.current();
              setTimeout(() => {
                void loadTeamGraphRef.current({ preserveSelection: true });
              }, 1500);
            }, 700);
          }
        }
      },
      onError: () => {
        /** firehose 断开：忽略，轮询仍在兜底；下次 effect 依赖变化会重连 */
      },
    });
    return () => {
      unsubscribe();
      if (settleRefetchTimerRef.current) {
        clearTimeout(settleRefetchTimerRef.current);
        settleRefetchTimerRef.current = null;
      }
    };
  }, [workflowRunId]);

  /**
   * 沉淀式交接：仅在同 role 的 reason step 已保存了**相同完整文本**时才删在飞缓冲。
   * 绝不能以 tool_call 作为接管信号：工具记录先于下一轮 reason 落库，会把右栏的
   * 过程输出过早清掉。
   */
  useEffect(() => {
    const steps = teamGraph?.agentSteps;
    if (!steps?.length) return;
    const persistedTextsByRole = new Map<string, Set<string>>();
    for (const step of steps) {
      if (step.phase !== "reason") continue;
      const text = stripToolCallSentinels(step.thought).trim();
      if (!text || text === "Reasoning with LLM provider") continue;
      const texts = persistedTextsByRole.get(step.agentRole) ?? new Set<string>();
      texts.add(text);
      persistedTextsByRole.set(step.agentRole, texts);
    }
    setStreamingByRole((prev) => {
      const roles = Object.keys(prev);
      if (!roles.length) return prev;
      let changed = false;
      const next = { ...prev };
      for (const role of roles) {
        const text = stripToolCallSentinels(prev[role]?.text).trim();
        const covered = Boolean(text && persistedTextsByRole.get(role)?.has(text));
        if (covered) {
          delete next[role];
          settledRolesRef.current.delete(role);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [teamGraph]);

  /**
   * 内联产物轮询：按 workflow 聚合因子、策略版本和 Python 脚本。
   * 单一类型同步失败不遮蔽其他可用产物；workflow 变化时立即清空旧卡片。
   */
  useEffect(() => {
    const wf = workflowRunId.trim();
    if (!wf) {
      setTeamArtifacts([]);
      setTeamArtifactsLoading(false);
      setTeamArtifactsError(null);
      return;
    }
    let alive = true;
    let initial = true;
    setTeamArtifacts([]);
    setTeamArtifactsLoading(true);
    setTeamArtifactsError(null);
    const load = async () => {
      const workflowRow = workflowOptions.find((row) => String(row.id) === wf);
      const workflowLinkedSessionId =
        typeof workflowRow?.sessionId === "string" ? workflowRow.sessionId : "";
      const artifactSessionId = workflowLinkedSessionId || teamResearchSessionId;
      const scriptsRequest = artifactSessionId
        ? listStrategyScripts(artifactSessionId, { workflowRunId: wf })
        : Promise.resolve([]);
      const [factorResult, strategyResult, scriptResult] = await Promise.allSettled([
        listFactors({ workflowRunId: wf }),
        listStrategyVersions({ workflowRunId: wf }),
        scriptsRequest,
      ]);
      if (!alive) return;

      const next: OrchestratorArtifact[] = [];
      const failures: string[] = [];
      if (factorResult.status === "fulfilled") {
        next.push(
          ...factorResult.value.map((f) => ({
            id: f.id,
            kind: "factor" as const,
            title: f.name,
            subtitle: f.status === "draft" ? "草稿" : f.category,
            projectId: f.projectId,
            workflowRunId: f.workflowRunId,
            createdAt: f.createdAt,
          }))
        );
      } else {
        failures.push("因子");
      }
      if (strategyResult.status === "fulfilled") {
        next.push(
          ...strategyResult.value.map((v) => ({
            id: v.id,
            kind: "strategy" as const,
            title: v.strategyName,
            subtitle: v.versionTag,
            projectId: v.projectId,
            workflowRunId: v.workflowRunId,
            createdAt: v.createdAt,
          }))
        );
      } else {
        failures.push("策略");
      }
      if (scriptResult.status === "fulfilled") {
        next.push(
          ...scriptResult.value.map((s) => ({
            id: s.id,
            kind: "script" as const,
            title: s.name,
            subtitle: s.purpose,
            workflowRunId: s.workflowRunId ?? wf,
            createdAt: s.createdAt,
          }))
        );
      } else {
        failures.push("脚本");
      }

      setTeamArtifacts(next);
      setTeamArtifactsError(
        failures.length > 0
          ? `${failures.join("、")} 产物暂时同步失败，已保留其他可用产物。`
          : null
      );
      if (initial) {
        initial = false;
        setTeamArtifactsLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workflowRunId, teamResearchSessionId, workflowOptions]);

  useEffect(() => {
    const el = liveFeedScrollRef.current;
    if (!el) return;
    /**
     * 关闭自动跟随时不再强制滚到底，否则用户翻回去看上方对话立刻又被
     * 新事件挤回最底部，体验非常差。仅当 autoFollow=true 时执行滚动。
     */
    if (!liveFeedAutoFollowRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [displayedLiveFeedRows, running, liveFeedAutoFollow]);

  const teamGraphActivity = useMemo((): TeamGraphActivity => {
    /**
     * 终态短路（修：completed 工作流拓扑仍显示「运行中」）：若选中工作流已是终态
     * （completed/failed/cancelled）且本会话没有正在主动跑它（running=false），则一律
     * 视为静止——不点亮任何 hot role/edge、isRunning=false。否则后端未及时回收的「存活」
     * 心跳会让已完成的图持续脉冲，误导用户以为 agent 还在跑。重跑时 running=true 会放行。
     */
    const wfRow = workflowOptions.find((w) => String(w.id) === workflowRunId);
    const wfStatus = typeof wfRow?.status === "string" ? wfRow.status : "";
    const wfTerminal =
      wfStatus === "completed" ||
      wfStatus === "partial" ||
      wfStatus === "failed" ||
      wfStatus === "cancelled";
    if (wfTerminal && !running) {
      return { hotRoles: new Set<string>(), hotEdgeKeys: new Set<string>(), isRunning: false };
    }
    const intr = filteredGraphDisplay?.interactions ?? [];
    const hotRoles = new Set<string>();
    const hotEdgeKeys = new Set<string>();
    const windowMs = running ? 14_000 : 90_000;
    const cutoff = Date.now() - windowMs;
    for (let i = intr.length - 1; i >= 0; i--) {
      const row = intr[i];
      if (!row) continue;
      if (row.kind === "tool_call") continue;
      const t = new Date(row.createdAt).getTime();
      if (!Number.isFinite(t)) continue;
      if (t < cutoff) break;
      hotRoles.add(row.fromRole);
      /**
       * fan-out 广播 (toRole=__team__) 不画"orchestrator → __team__"高亮 —— 而是
       * 展开 payloadJson.targetRoles 为多个真实 role 的高亮边，跟拓扑画布
       * `aggregateEdgesFromInteractions` 的 fan-out 行为保持一致。
       */
      if (row.toRole === "__team__") {
        const payload = row.payloadJson;
        const targets =
          payload && typeof payload === "object" && Array.isArray((payload as { targetRoles?: unknown }).targetRoles)
            ? ((payload as { targetRoles?: unknown }).targetRoles as unknown[])
                .filter((v): v is string => typeof v === "string" && v.length > 0)
            : [];
        for (const t of targets) {
          hotRoles.add(t);
          hotEdgeKeys.add(teamGraphUndirectedKey(row.fromRole, t));
        }
        continue;
      }
      hotRoles.add(row.toRole);
      hotEdgeKeys.add(teamGraphUndirectedKey(row.fromRole, row.toRole));
    }
    /**
     * 心跳信号也并入 hotRoles：
     *   alive=true 且 silenceMs < 60s 的 role 视为活跃（节点会脉冲高亮）。
     * 这样删除左栏「Agent 心跳」展示之后，活跃状态直接由拓扑节点呈现。
     * isRunning 也合并：只要有任何 alive heartbeat 就视为运行中（前端 `running`
     * flag 在 polling 超时后会变 false，但 backend 实际还在跑，这时心跳能托底）。
     */
    let hasAliveHeartbeat = false;
    if (agentHeartbeats?.heartbeats?.length) {
      for (const hb of agentHeartbeats.heartbeats) {
        if (!hb.alive) continue;
        const silent = hb.silenceMs;
        if (silent != null && silent > 60_000) continue;
        if (hb.role) hotRoles.add(hb.role);
        hasAliveHeartbeat = true;
      }
    }
    return { hotRoles, hotEdgeKeys, isRunning: running || hasAliveHeartbeat };
  }, [filteredGraphDisplay?.interactions, running, agentHeartbeats, workflowOptions, workflowRunId]);

  const workflowSessionId = useMemo(() => {
    const row = workflowOptions.find((w) => String(w.id) === workflowRunId);
    const sid = row?.sessionId;
    return typeof sid === "string" && sid ? sid : "";
  }, [workflowRunId, workflowOptions]);

  const selectedWorkflowRow = useMemo(
    () => workflowOptions.find((w) => String(w.id) === workflowRunId) ?? null,
    [workflowOptions, workflowRunId]
  );

  useEffect(() => {
    if (
      workflowSessionId &&
      workflowSessionId !== selectedConversationSessionId
    ) {
      setSelectedConversationSessionId(workflowSessionId);
    }
  }, [
    workflowSessionId,
    selectedConversationSessionId,
    setSelectedConversationSessionId,
  ]);

  /**
   * 选中工作流是否已结束（completed/failed/cancelled）。用于右栏「继续研究」模式：
   * 已结束时 composer 允许基于已有研究续跑（后端用上次 ticker 兜底，无需重填研究范围）。
   * running 时不算（那是注入模式）。
   */
  const selectedWorkflowCompleted = useMemo(() => {
    if (running) return false;
    const st = selectedWorkflowRow?.status;
    return st === "completed" || st === "partial" || st === "failed" || st === "cancelled";
  }, [selectedWorkflowRow, running]);

  const selectedWorkflowKind = useMemo(
    () => (selectedWorkflowRow ? classifyWorkflow(selectedWorkflowRow) : null),
    [selectedWorkflowRow]
  );

  /**
   * 「研究产出」侧栏使用的有效 projectId：优先跟随当前选中工作流的 project_id，
   * 兜底回退到 teamResearchProjectId（启动时锁定的"默认 project"）。
   *
   * 背景：teamResearchProjectId 由启动时 `listProjects(defaultWs)[0]` 锁定，
   * 但用户切到其他 project 下产生的 workflow（如 round8/9 评测 / FSI 流水线）时，
   * 该锁定值与 workflow.project_id 不一致，会让侧栏内任何"按 project 维度联动"
   * 的组件产生状态错位。研究产出本身已在子组件层只按 workflow_run_id 过滤
   * （见 AgentGeneratedFactorsBlock 注释），这里再让 projectId 自动跟随，
   * 主要是为了状态自洽（例如未来 add-on：点击因子打开量化工坊时按 workflow
   * 实际 project 跳转）。
   *
   * 不影响 `handleCreateTeamWorkflow`：那里仍用 teamResearchProjectId 作为
   * 「新建工作流的归属 project」，保持用户在 UI 当前上下文新建的语义。
   */
  const effectiveResearchProjectId = useMemo(() => {
    const wfPid = selectedWorkflowRow?.projectId
      ? String(selectedWorkflowRow.projectId)
      : "";
    return wfPid || teamResearchProjectId;
  }, [selectedWorkflowRow, teamResearchProjectId]);

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

  /**
   * 列表视图实际渲染用的分组结果：在 `groupedWorkflowOptions` 之上再叠加
   *   - 关键字搜索（在 goal / id 上 includes）
   * 空组会被丢掉，避免列表里出现一堆空标题。
   */
  const filteredGroupedWorkflowList = useMemo(() => {
    const query = workflowListQuery.trim().toLowerCase();
    return groupedWorkflowOptions
      .map((group) => {
        const rows = group.rows.filter((row) => {
          if (!query) return true;
          const goal = typeof row.goal === "string" ? row.goal.toLowerCase() : "";
          const id = String(row.id ?? "").toLowerCase();
          return goal.includes(query) || id.includes(query);
        });
        return { ...group, rows };
      })
      .filter((group) => group.rows.length > 0);
  }, [groupedWorkflowOptions, workflowListQuery]);

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
  /**
   * graphSize.h 现在跟着「节点数 + 视口高度」联动：
   *   - 同一组件实例切换 workflow 造成节点数变化 → 动态把高度顶起来
   *   - 用户调整窗口大小（resize 事件）→ 画布跟随重算
   * `viewportH` 单独 state 是因为我们没有现成的 ResizeObserver 去观测 window，
   * 用 window.innerHeight + resize 监听简单直接。
   */
  const [viewportH, setViewportH] = useState(() =>
    typeof window === "undefined" ? 900 : window.innerHeight,
  );
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const graphHeight = useMemo(
    () => computeTopologyHeight(filteredGraphDisplay?.nodes?.length ?? 0, viewportH),
    [filteredGraphDisplay?.nodes?.length, viewportH],
  );
  const [graphSize, setGraphSize] = useState({ w: 720, h: graphHeight });

  useLayoutEffect(() => {
    const el = graphWrapRef.current;
    if (!el) return;
    const applyWidth = (width: number) => {
      const w = Math.max(320, Math.floor(width));
      setGraphSize((prev) => (prev.w === w && prev.h === graphHeight ? prev : { w, h: graphHeight }));
    };
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) applyWidth(cr.width);
    });
    ro.observe(el);
    applyWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [graphHeight]);

  useEffect(() => {
    setGraphSelection(null);
  }, [workflowRunId]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void loadTeamGraph();
    }, 400);
    return () => window.clearTimeout(t);
  }, [workflowRunId, loadTeamGraph]);

  useEffect(() => {
    void (async () => {
      try {
        // 单租户兜底 workspace；详见 src/runtime/bootstrap/ensure-default-workspace.ts。
        const dft = await getDefaultWorkspace();
        const wsId = dft.id;
        const projects = await listProjects(wsId);
        let pid = projects[0]?.id;
        if (!pid) {
          // 只读 get-or-create：后端写死稳定 ID 幂等，不再前端 createProject 兜底。
          const pr = await getOrCreateDefaultProject();
          pid = pr.id;
        }
        setTeamResearchProjectId(pid);
        const session = await getDefaultProjectSession(pid);
        setTeamResearchSessionId(session.id);
      } catch {
        setTeamResearchProjectId("");
        setTeamResearchSessionId("");
      }
      const wfRows = await refreshWorkflowOptions();
      if (!workflowRunId) {
        const activeSessionId = useAppStore.getState().selectedSessionId;
        const sessionWorkflow = activeSessionId
          ? wfRows.find((row) => String(row.sessionId ?? "") === activeSessionId)
          : null;
        const initialWorkflow = sessionWorkflow ?? wfRows[0];
        if (initialWorkflow?.id) {
          setWorkflowRunId(String(initialWorkflow.id));
        }
      }
    })().catch(() => {});
  }, []);

  const [runProgress, setRunProgress] = useState<string>("");

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

  /**
   * 中栏底部「研究产出」抽屉的折叠态（因子/策略/脚本/草稿）。
   * 从右栏迁移而来：右栏现在是 Orchestrator 主对话框，产物下移到中栏底部，可隐去。
   * 持久化到 localStorage，默认折叠（不挤占对话/拓扑）。
   */
  const OUTPUTS_DRAWER_LS_KEY = "qb.team-outputs-drawer-open";
  const [outputsDrawerOpen, setOutputsDrawerOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OUTPUTS_DRAWER_LS_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(OUTPUTS_DRAWER_LS_KEY, outputsDrawerOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [outputsDrawerOpen]);

  /**
   * 唯一研究执行入口：右侧 composer 交给 Orchestrator 自主判断
   * （直接答 / assign_task 派单 / run_analyst_team 全队）。
   */
  const handleOrchestratorChat = async (options?: {
    message?: string;
    agentMode?: AgentControlMode;
    preserveGoal?: boolean;
  }) => {
    const wf = workflowRunId.trim();
    const msg = (options?.message ?? teamAnalysisContext).trim();
    if (!wf) {
      setError("请先选择工作流");
      return;
    }
    if (!msg) return;
    const sessionId = workflowSessionId || teamResearchSessionId;
    const projectId = effectiveResearchProjectId || teamResearchProjectId;
    if (!sessionId || !projectId) {
      setError("当前工作流尚未关联有效项目/会话，无法发送消息。");
      return;
    }
    setError(null);
    pushUserEcho(msg);
    if (!options?.message) setTeamAnalysisContext("");
    setOrchestratorChatInFlight(true);
    setRunProgress("Orchestrator 处理中…（自主判断是否调度团队）");
    try {
      const turn = await createConversationTurn({
        sessionId,
        projectId,
        workflowRunId: wf,
        message: msg,
        turnMode: "continue_goal",
        hitlMode: teamHitlMode,
        roleReasoner,
        agentMode: options?.agentMode ?? teamAgentMode,
        ...(options?.preserveGoal ? { preserveGoal: true } : {}),
      });
      setSelectedConversationSessionId(turn.sessionId);
      void refreshWorkflowOptions();
      void loadTeamGraph({ preserveSelection: true });
    } catch (e) {
      setOrchestratorChatInFlight(false);
      setError((e as Error).message);
      setRunProgress("");
    }
  };

  const handleCreateTeamWorkflow = async () => {
    if (!teamResearchProjectId || !teamResearchSessionId) {
      setError("尚未解析到默认项目/会话，无法创建工作流。请检查工作区是否可用。");
      return;
    }
    setError(null);
    setCreatingTeamWorkflow(true);
    try {
      const created = await createWorkflow({
        projectId: teamResearchProjectId,
        goal: `研究团队 · ${scopeModeLabel(scopeMode)} · ${ticker.trim() || sectorName || "标的"} · ${new Date().toLocaleString()}`,
        mode: "research",
        sessionId: teamResearchSessionId,
        source: "manual",
        reuseSessionWorkflow: false,
        skipDispatch: true,
        loopOptionsJson: {
          agentMode: teamAgentMode,
          hitlMode: teamHitlMode,
          roleReasoner,
        },
      });
      await refreshWorkflowOptions();
      setWorkflowRunId(String(created.data.id));
      setSelectedConversationSessionId(teamResearchSessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingTeamWorkflow(false);
    }
  };

  /**
   * 软删除（取消）任意工作流。被取消的工作流会从列表（默认隐藏 cancelled）中消失。
   *
   * 旧实现依赖 window.confirm() 二次确认，但 Tauri/WebView 下可能被静默拦截，体感"按钮没反应"。
   * 改成列表行内直接调用 —— 取消是软删除可恢复，无需再加 confirm；硬删除则在按钮处用双击确认。
   */
  const handleCancelOneWorkflow = async (id: string) => {
    const target = id.trim();
    if (!target) return;
    setError(null);
    setWorkflowNotice(null);
    try {
      await deleteWorkflow(target);
      if (target === workflowRunId.trim()) {
        setRunning(false);
        setRunProgress("");
        setTeamPendingHitl(null);
      }
      const rows = await refreshWorkflowOptions();
      if (target === workflowRunId.trim()) {
        setWorkflowRunId(rows[0]?.id ? String(rows[0].id) : "");
      }
      setWorkflowNotice(`已取消工作流 ${target.slice(0, 8)}…（软删除，记录仍保留）。`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 真正执行硬删除（已通过二次点击确认）。
   * 会级联清理 agent_instance / agent_step / tool_call_log / a2a_message /
   * order_intent / intent_order / langgraph_checkpoint 等所有衍生数据，
   * 并把 audit_log / scheduled_job_run 等保留型反向引用置空。【不可恢复】。
   */
  const performHardDeleteWorkflow = async (id: string) => {
    setPendingHardDeleteWfId(null);
    setError(null);
    setWorkflowNotice(null);
    try {
      const result = await deleteWorkflow(id, { hard: true });
      if (id === workflowRunId.trim()) {
        setRunning(false);
        setRunProgress("");
        setTeamPendingHitl(null);
      }
      const rows = await refreshWorkflowOptions();
      if (id === workflowRunId.trim()) {
        setWorkflowRunId(rows[0]?.id ? String(rows[0].id) : "");
      }
      const affected = Object.values(result.details ?? {}).reduce((a, b) => a + b, 0);
      setWorkflowNotice(`已硬删除工作流 ${id.slice(0, 8)}…（共清理 ${affected} 行衍生数据）。`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * 行内"硬删除"按钮点击：第一次进入 pending（按钮文案变成"再次点击确认"），
   * 3 秒内再点才真正执行；3 秒未点击自动撤销。
   *
   * 旧实现用 `window.confirm()` 阻塞弹窗，但部分 Tauri/WebView 环境下 confirm 会被静默
   * 拒绝（直接返回 false），用户外观上就是"硬删除按钮没反应"。改成行内确认状态后
   * 完全在 React 状态机内闭环，不依赖宿主的弹窗能力。
   */
  const handleClickHardDeleteWorkflow = (id: string) => {
    const target = id.trim();
    if (!target) return;
    if (pendingHardDeleteWfId === target) {
      void performHardDeleteWorkflow(target);
      return;
    }
    setError(null);
    setWorkflowNotice(null);
    setPendingHardDeleteWfId(target);
    setTimeout(() => {
      setPendingHardDeleteWfId((cur) => (cur === target ? null : cur));
    }, 3000);
  };


  const handleLinkWorkflowToDefaultSession = async () => {
    if (!workflowRunId.trim() || !teamResearchSessionId) return;
    setError(null);
    try {
      await patchWorkflow(workflowRunId.trim(), { sessionId: teamResearchSessionId });
      await refreshWorkflowOptions();
      setSelectedConversationSessionId(teamResearchSessionId);
    } catch (e) {
      setError((e as Error).message);
    }
  };


  return (
    <div style={teamStyles.container}>
      <div data-qb-team-shell style={teamStyles.teamWorkbenchShell}>
        {/**
         * 三栏显隐工具条：研究与工作流 / 研究画布 / 研究产出 各一颗 toggle。
         * 至少保留一栏可见；隐藏的栏对应 gutter 也一起 unmount。
         * 状态持久化到 localStorage（TEAM_PANES_LS_KEY）。
         */}
        <div style={teamStyles.paneToggleBar} role="toolbar" aria-label="三栏显示控制">
          <span style={teamStyles.paneToggleHint}>显示栏目</span>
          {TEAM_PANES.map((pane) => {
            const visible = teamPaneVisible(pane);
            const onlyOne = TEAM_PANES.length - hiddenTeamPanes.size <= 1;
            const disabled = visible && onlyOne;
            return (
              <button
                key={pane}
                type="button"
                onClick={() => toggleTeamPane(pane)}
                disabled={disabled}
                style={{
                  ...teamStyles.paneToggleBtn,
                  ...(visible ? teamStyles.paneToggleBtnActive : teamStyles.paneToggleBtnHidden),
                  ...(disabled ? teamStyles.paneToggleBtnDisabled : null),
                }}
                title={
                  disabled
                    ? "至少保留一栏可见"
                    : visible
                      ? `隐藏「${TEAM_PANE_LABEL[pane]}」`
                      : `显示「${TEAM_PANE_LABEL[pane]}」`
                }
                aria-pressed={visible}
              >
                <span style={teamStyles.paneToggleDot} aria-hidden>
                  {visible ? "●" : "○"}
                </span>
                {TEAM_PANE_LABEL[pane]}
              </button>
            );
          })}
        </div>
        {/**
         * 弹性宽度策略（在两个 aside 内联生效）：
         *   - 三栏全显 / 中栏在场：left 与 right 保持用户拖拽设定的固定宽度，center 吃剩余。
         *   - 中栏被隐藏：right 改成 flex:1 自动铺满（否则 left 固定 + right 固定 → 中间黑屏空洞）。
         *   - 仅 left 唯一可见：left 改成 flex:1 撑满整个工作台。
         *   - 仅 right 唯一可见：right 改成 flex:1 撑满（截图反馈过：300px 右栏 + 大片留白）。
         */}
        <div ref={teamTriRef} style={teamStyles.teamTriRow}>
        {teamPaneVisible("left") ? (
        <aside
          style={{
            ...teamStyles.leftRail,
            ...(!teamPaneVisible("center") && !teamPaneVisible("right")
              ? { flex: 1, minWidth: 0, width: "auto" }
              : { width: teamLeftW, flexShrink: 0 }),
            alignSelf: "stretch",
          }}
        >
          {/**
           * 左栏顶：视图切换。工作区 = FS 课题树；工作流 = 原研究设置 + 列表。
           */}
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-team-section-fg, #e4e4e7)", marginBottom: 8 }}>
            研究
          </div>
          <div
            className="qb-team-graph-view-toggle"
            role="tablist"
            aria-label="左栏视图"
            style={{ marginBottom: 10, alignSelf: "flex-start" }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={leftRailMode === "workspace"}
              className={leftRailMode === "workspace" ? "is-active" : ""}
              onClick={() => setLeftRailMode("workspace")}
            >
              工作区
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={leftRailMode === "workflow"}
              className={leftRailMode === "workflow" ? "is-active" : ""}
              onClick={() => setLeftRailMode("workflow")}
            >
              工作流
            </button>
          </div>
          {leftRailMode === "workspace" ? (
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <FsWorkspaceExplorer
                createDefaults={fsWorkspaceCreateDefaults}
                onOpenWorkflowSettings={() => setLeftRailMode("workflow")}
              />
            </div>
          ) : (
            <>
          <div style={teamStyles.leftRailSettings}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 10 }}>
            研究与工作流
          </div>
          <div style={teamStyles.field}>
            <label style={teamStyles.label}>研究范围</label>
            <select
              style={teamStyles.input}
              value={scopeMode}
              onChange={(e) => handleScopeModeChange(e.target.value as ResearchScopeMode)}
            >
              <option value="single">单标的</option>
              <option value="basket">多标的篮子</option>
              <option value="sector">板块</option>
              <option value="explore">自由探索（无固定标的）</option>
            </select>
          </div>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>工具类型</label>
            <select
              style={teamStyles.input}
              value={researchInstrument}
              onChange={(e) => handleResearchInstrumentChange(e.target.value as ResearchInstrumentUi)}
            >
              <option value="equity_long">股票多头</option>
              <option value="equity_short">股票做空</option>
              <option value="option">期权</option>
            </select>
          </div>
          <div style={{ ...teamStyles.field, marginTop: 8 }}>
            <label style={teamStyles.label}>Agent 底座</label>
            <select
              style={teamStyles.input}
              value={roleReasoner}
              onChange={(e) => setRoleReasoner(e.target.value as AgentLoopKind)}
            >
              <option value="native">自研（进程内 ReAct）</option>
              <option value="claude_cli">Claude CLI</option>
              <option value="codex_cli">Codex CLI</option>
            </select>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
              每个角色单轮推理用的引擎；Orchestrator 按需派发专家，CLI 不可用时自动回退自研。
            </div>
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
              <label style={teamStyles.label}>篮子标的（逗号分隔，至少 2 个）</label>
              <textarea
                style={teamStyles.textarea}
                rows={2}
                value={basketTickers}
                onChange={(e) => setBasketTickers(e.target.value)}
                placeholder="e.g. AAPL, MSFT, NVDA"
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
                  placeholder="e.g. 半导体 / 新能源"
                />
              </div>
              <div style={{ ...teamStyles.field, marginTop: 8 }}>
                <label style={teamStyles.label}>成分股（逗号分隔，必填）</label>
                <textarea
                  style={teamStyles.textarea}
                  rows={2}
                  value={sectorPeers}
                  onChange={(e) => setSectorPeers(e.target.value)}
                  placeholder="e.g. NVDA, AMD, AVGO"
                />
              </div>
            </>
          ) : null}
          {scopeMode === "explore" ? (
            <>
              <div style={{ ...teamStyles.field, marginTop: 8 }}>
                <label style={teamStyles.label}>研究主题（必填，越具体越好）</label>
                <textarea
                  style={teamStyles.textarea}
                  rows={2}
                  value={exploreTheme}
                  onChange={(e) => setExploreTheme(e.target.value)}
                  placeholder="e.g. AI 推理芯片的轮动机会 / 美联储会议前后的避险标的"
                />
              </div>
              <div style={{ ...teamStyles.field, marginTop: 8 }}>
                <label style={teamStyles.label}>候选标的（可选，留空则由 Orchestrator 自主筛选）</label>
                <textarea
                  style={teamStyles.textarea}
                  rows={2}
                  value={exploreCandidates}
                  onChange={(e) => setExploreCandidates(e.target.value)}
                  placeholder="可写也可留空，e.g. NVDA, AMD, AVGO, TSM"
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
            <label style={teamStyles.label}>分析提示模板（可选，选中后自动填入下方文本框）</label>
            <select
              style={teamStyles.input}
              value={promptTemplateId}
              onChange={(e) => applyPromptTemplate(e.target.value)}
            >
              <option value="">— 不使用模板 —</option>
              {availablePromptTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} · {t.summary}
                </option>
              ))}
            </select>
            {availablePromptTemplates.length === 0 ? (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--qb-team-muted-fg, #71717a)",
                  marginTop: 4,
                }}
              >
                当前 {scopeModeLabel(scopeMode)} + {instrumentLabel(researchInstrument)} 组合暂无内置模板，可自行填写下方提示。
              </div>
            ) : null}
          </div>
          <div style={{ ...teamStyles.field, marginTop: 10 }}>
            <label style={teamStyles.label}>分析提示（可选，覆盖默认）</label>
            <textarea
              style={teamStyles.textarea}
              rows={6}
              value={teamAnalysisContext}
              onChange={(e) => {
                setTeamAnalysisContext(e.target.value);
                if (promptTemplateId) setPromptTemplateId("");
              }}
              placeholder={`留空则使用默认分析提示。当前：${scopeModeLabel(scopeMode)} · ${instrumentLabel(researchInstrument)}`}
            />
          </div>
          </div>
          {/**
           * 下半工作流区独立滚动容器：工作流筛选 + 列表 + 新建按钮 + 拓扑。
           * flex: 1 占据余高。
           * 子组件 workflow list / 拓扑 ul 取消了自身 maxHeight —— 让本容器作为唯一滚动条。
           */}
          <div style={teamStyles.leftRailWorkflows}>
          <div style={{ ...teamStyles.field }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <label style={teamStyles.label}>工作流</label>
              <button
                type="button"
                className="qb-btn-secondary"
                style={{ fontSize: 11, padding: "3px 8px" }}
                onClick={() => void refreshWorkflowOptions()}
                title="刷新工作流列表"
              >
                刷新
              </button>
            </div>
            {/* 会话检索：类型 + 关键字。执行状态仅用于后台监控与失败诊断。 */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <select
                style={{ ...teamStyles.input, flex: "1 1 110px", minWidth: 110, fontSize: 12 }}
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
              <input
                type="search"
                style={{ ...teamStyles.input, flex: "2 1 140px", minWidth: 120, fontSize: 12 }}
                value={workflowListQuery}
                onChange={(e) => setWorkflowListQuery(e.target.value)}
                placeholder="搜索 goal / ID…"
                aria-label="工作流关键字搜索"
              />
            </div>
            {/*
              二级操作（新建 / 关联默认会话）放在列表**上方**，与筛选条同区。
              原因：之前放在列表下方时，用户要先把列表滚到底才能点到「新建工作流」，
              非常反直觉。抬到上方后按钮一直可见，无需依赖列表滚动位置。
              "取消 / 硬删除"仍下放到每个 list 行内，按工作流即可操作。
            */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
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
            {/* 滚动 list，按 kind 分组（沿用既有 groupedWorkflowOptions），但每组用关键字进一步过滤。 */}
            <div
              role="listbox"
              aria-label="工作流列表"
              style={workflowListStyles.list}
            >
              {filteredGroupedWorkflowList.length === 0 ? (
                <div style={workflowListStyles.empty}>
                  {workflowOptions.length === 0
                    ? "暂无工作流。点击上方「新建工作流」开始一次研究团队任务。"
                    : "没有匹配的工作流。试试清空搜索 / 切换筛选条件。"}
                </div>
              ) : (
                filteredGroupedWorkflowList.map((group) => (
                  <div key={group.kind} style={workflowListStyles.group}>
                    <div style={workflowListStyles.groupHeader}>
                      <span>{group.label}</span>
                      <span style={workflowListStyles.groupCount}>{group.rows.length}</span>
                    </div>
                    {group.rows.map((row) => {
                      const id = String(row.id ?? "");
                      const goal = typeof row.goal === "string" ? row.goal.trim() : "";
                      const status = String(row.status ?? "—");
                      const sid = typeof row.sessionId === "string" ? row.sessionId.trim() : "";
                      const startedAt =
                        typeof row.startedAt === "string" && row.startedAt
                          ? new Date(row.startedAt).toLocaleString()
                          : "";
                      const selected = id === workflowRunId;
                      const pendingDel = pendingHardDeleteWfId === id;
                      return (
                        <div
                          key={id}
                          style={{
                            ...workflowListStyles.item,
                            ...(selected ? workflowListStyles.itemSelected : null),
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setWorkflowRunId(id);
                              if (sid) setSelectedConversationSessionId(sid);
                              setWorkflowNotice(null);
                            }}
                            style={workflowListStyles.itemMain}
                            title={goal || id}
                            aria-pressed={selected}
                          >
                            {status === "failed" ? (
                              <span style={{ color: "#fca5a5", fontSize: 11, marginBottom: 4 }} role="status">
                                本次执行未能完成，可在下方继续补充问题
                              </span>
                            ) : null}
                            <div style={workflowListStyles.itemTitleRow}>
                              <span style={workflowListStyles.itemTitle}>
                                {goal || `(no goal) ${id.slice(0, 8)}`}
                              </span>
                            </div>
                            <div style={workflowListStyles.itemMeta}>
                              <code style={workflowListStyles.itemId}>{id.slice(0, 8)}…</code>
                              {startedAt ? <span>{startedAt}</span> : null}
                              {!sid ? (
                                <span style={{ color: "#a78bfa" }} title="该工作流尚未关联会话">
                                  no-session
                                </span>
                              ) : null}
                            </div>
                          </button>
                          <div style={workflowListStyles.itemActions}>
                            <button
                              type="button"
                              className="qb-btn-secondary"
                              style={workflowListStyles.actionBtn}
                              onClick={() => void handleCancelOneWorkflow(id)}
                              disabled={status === "cancelled"}
                              title="软删除：标记 cancelled，保留审计数据"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="qb-btn-secondary"
                              style={{
                                ...workflowListStyles.actionBtn,
                                color: pendingDel ? "#fff" : "#fecaca",
                                background: pendingDel ? "#7f1d1d" : "transparent",
                                borderColor: "#7f1d1d",
                              }}
                              onClick={() => handleClickHardDeleteWorkflow(id)}
                              title={
                                pendingDel
                                  ? "再次点击执行硬删除（3 秒内未点击自动撤销）"
                                  : "硬删除：连同 agent / 步骤 / a2a / 订单 / checkpoint 等衍生数据一并清理，不可恢复"
                              }
                            >
                              {pendingDel ? "再次点击确认" : "硬删除"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            {/*
              新建 / 关联默认会话按钮已上移到筛选条下方（list 上方），
              避免用户必须把 list 滚到底才能点到。这里只保留 notice / 当前选中 / 提示文案。
            */}
            {workflowNotice ? (
              <div
                className="qb-callout qb-callout--success"
                role="status"
                style={{ marginTop: 10 }}
              >
                <div className="qb-callout__row">
                  <span style={{ flex: 1, minWidth: 0 }}>{workflowNotice}</span>
                  <button
                    type="button"
                    className="qb-callout__dismiss"
                    onClick={() => setWorkflowNotice(null)}
                    aria-label="关闭提示"
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : null}
            {selectedWorkflowRow ? (
              <p style={{ fontSize: 11, color: "#71717a", marginTop: 6, lineHeight: 1.45, wordBreak: "break-all" }}>
                当前选中：
                <strong style={{ color: "#a1a1aa", marginRight: 6 }}>
                  {selectedWorkflowKind ? WORKFLOW_KIND_LABEL[selectedWorkflowKind] : "—"}
                </strong>
                <code style={{ fontSize: 10 }}>{String(selectedWorkflowRow.id)}</code>
              </p>
            ) : null}
            {/**
             * 注：原「Agent 心跳」明细列表已删除。
             * 心跳数据 `agentHeartbeats` 仍由 SSE 推流维持，已合并进
             * `teamGraphActivity.hotRoles` —— 拓扑画布上 alive 且 silenceMs<60s
             * 的 Agent 节点会高亮 + 脉冲，作为活跃可视化的唯一信号源。
             */}
            {agentHeartbeats && agentHeartbeats.summary.aliveAgents > 0 && running ? (
              <div
                style={{
                  marginTop: 8,
                  padding: "5px 10px",
                  borderRadius: 6,
                  background: "rgba(34, 197, 94, 0.08)",
                  border: "1px solid rgba(34, 197, 94, 0.25)",
                  fontSize: 10,
                  color: "#86efac",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
                title="拓扑画布节点会脉冲高亮显示活跃 Agent"
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#22c55e",
                    boxShadow: "0 0 6px rgba(34, 197, 94, 0.65)",
                  }}
                />
                {agentHeartbeats.summary.aliveAgents}/{agentHeartbeats.summary.totalAgents} Agent
                活跃中（详见画布脉冲节点）
              </div>
            ) : null}
            {workflowRunId.trim() && !workflowSessionId ? (
              <p
                style={{
                  fontSize: 11,
                  color: "var(--qb-hint-accent-fg, #a78bfa)",
                  marginTop: 6,
                  lineHeight: 1.45,
                }}
              >
                当前工作流未绑定会话：右侧「保存脚本 / 实盘」需会话。可点「关联默认会话」或新建工作流（已自动带会话）。
              </p>
            ) : null}
          </div>

          {/** 左栏只保留工作流选择与拓扑只读视图。 */}
          <div style={{ marginTop: 14, borderTop: "1px solid #27272a", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#cbd5e1", marginBottom: 6 }}>工作流对话拓扑（只读）</div>
            <p style={{ fontSize: 11, color: "#71717a", marginBottom: 8 }}>
              运行期轨迹：含 LLM 交互、Tool/MCP 及 Agent <strong>通信拓扑</strong>产生的 handoff。
              无数据时请在「研究画布」刷新。
            </p>
            {!teamGraph?.edges?.length ? (
              <div style={{ fontSize: 11, color: "#52525b" }}>暂无边记录</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "#d4d4d8" }}>
                {teamGraph.edges.slice(0, 24).map((ed) => (
                  <li key={ed.key} style={{ marginBottom: 4 }}>
                    {ed.a} ↔ {ed.b} · 消息 {ed.messageCount} · 工具 {ed.toolCount}
                  </li>
                ))}
              </ul>
            )}
          </div>
          </div>
            </>
          )}
        </aside>
        ) : null}
        {/**
         * gutter1：左栏存在且其右侧至少还有一栏可见（center 或 right）。
         * 当 center 被隐藏只剩 left + right 时，gutter1 仍承担 left/right 分隔 —— 它绑定的
         * onMouseDown(1) 调整的是 teamLeftW，拖动左栏宽度本来就符合直觉。
         */}
        {teamPaneVisible("left") && (teamPaneVisible("center") || teamPaneVisible("right")) ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整左侧栏宽度"
            onMouseDown={onTeamColGutterDown(1)}
            style={teamStyles.teamColGutter}
          />
        ) : null}

        {teamPaneVisible("center") ? (
        <div style={teamStyles.centerCol}>
          <div style={teamStyles.ideCenterWrap}>
            <div className="qb-team-main-stage" style={teamStyles.teamMainStage}>
              <header className="qb-team-editor-titlebar" style={teamStyles.teamEditorTitleBar}>
                <span style={{ fontWeight: 600, color: "var(--qb-team-titlebar-fg, #e4e4e7)" }}>
                  研究画布 · 拓扑 / 行情 / 新闻 / 工具
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {researchMarketSymbols.length > 0 ? (
                    <span style={{ color: "#94a3b8", fontSize: 11 }}>
                      {researchMarketSymbols.length > 1
                        ? `${researchMarketSymbols.length} 个标的 · 焦点 ${chartSpec.symbol || "—"}${
                            chartSpec.exchange ? `.${chartSpec.exchange}` : ""
                          }`
                        : `联动标的 ${chartSpec.symbol || researchMarketSymbols[0]?.symbol}${
                            chartSpec.exchange || researchMarketSymbols[0]?.exchange
                              ? `.${chartSpec.exchange || researchMarketSymbols[0]?.exchange}`
                              : ""
                          }`}
                    </span>
                  ) : null}
                  {running ? (
                    <span style={{ color: "#38bdf8", fontSize: 11 }}>
                      ● 分析进行中 · 拓扑与工具每 2.5s 刷新
                    </span>
                  ) : null}
                  {graphLoading ? (
                    <span style={{ color: "#a1a1aa", fontSize: 11 }}>加载图数据…</span>
                  ) : null}
                </span>
              </header>
              <div style={teamStyles.teamEditorBody}>
        <div
          data-qb-team-research-panel
          style={{ ...teamStyles.panel, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <div
            className="qb-team-graph-view-toggle"
            role="tablist"
            aria-label="研究画布视图"
            style={{ marginBottom: 10, alignSelf: "flex-start" }}
          >
            {(
              [
                ["topology", "对话拓扑"],
                ["market", "行情 K 线"],
                ["news", "新闻资讯"],
                ["tools", `工具结果${researchCanvasToolHits.length ? ` (${researchCanvasToolHits.length})` : ""}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={researchCanvasTab === id}
                className={researchCanvasTab === id ? "is-active" : ""}
                onClick={() => setResearchCanvasTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {researchCanvasTab === "market" ? (
            <div
              style={{
                flex: 1,
                minHeight: 420,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 10,
                border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--qb-team-live-feed-bg, #08080a)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexShrink: 0,
                }}
              >
                <div
                  className="qb-team-graph-view-toggle"
                  role="group"
                  aria-label="K 线布局"
                >
                  <button
                    type="button"
                    className={marketKlineLayout === "grid" ? "is-active" : ""}
                    onClick={() => setMarketKlineLayout("grid")}
                  >
                    多标的网格
                    {researchMarketSymbols.length > 1
                      ? ` (${researchMarketSymbols.length})`
                      : ""}
                  </button>
                  <button
                    type="button"
                    className={marketKlineLayout === "single" ? "is-active" : ""}
                    onClick={() => setMarketKlineLayout("single")}
                  >
                    单图焦点
                  </button>
                </div>
                <span style={{ fontSize: 11, color: "#71717a" }}>
                  {chartSpec.timeframe} · {chartSpec.limit} 根
                </span>
              </div>
              {marketKlineLayout === "grid" ? (
                <ResearchMultiKlineGrid
                  symbols={researchMarketSymbols}
                  timeframe={chartSpec.timeframe}
                  limit={chartSpec.limit}
                  reloadNonce={chartReloadNonce}
                  focusKey={
                    chartSpec.symbol
                      ? `${chartSpec.symbol.toUpperCase()}@@${coerceChartMarketExchange(
                          chartSpec.exchange || ""
                        ).toUpperCase()}`
                      : null
                  }
                  onFocus={(row) => {
                    setChartSpec({
                      symbol: row.symbol,
                      exchange: coerceChartMarketExchange(row.exchange),
                    });
                    requestChartReload();
                  }}
                />
              ) : (
                <div
                  style={{
                    flex: 1,
                    minHeight: 360,
                    display: "flex",
                    flexDirection: "column",
                    overflow: "hidden",
                    borderRadius: 8,
                  }}
                >
                  <KlinePanel embedded />
                </div>
              )}
            </div>
          ) : null}

          {researchCanvasTab === "news" ? (
            <div
              style={{
                flex: 1,
                minHeight: 360,
                display: "flex",
                flexDirection: "column",
                border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <NewsBriefSection
                symbol={chartSpec.symbol}
                exchange={chartSpec.exchange}
                reloadNonce={chartReloadNonce}
              />
            </div>
          ) : null}

          {researchCanvasTab === "tools" ? (
            <ResearchToolResultsPanel
              hits={researchCanvasToolHits}
              onOpenMarket={(hit) => applyCanvasMarketLink(hit, "market")}
              onOpenNews={(hit) => applyCanvasMarketLink(hit, "news")}
            />
          ) : null}

          {researchCanvasTab === "topology" ? (
            <>
          <h3 style={{ ...teamStyles.sectionTitle, marginTop: 0 }}>多 Agent 对话拓扑</h3>
          <p style={{ fontSize: 12, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 12 }}>
            默认只显示用户与编排器，其它 Agent 被调用后才入图。工具调用会联动到「行情 / 新闻 / 工具结果」视图。
          </p>
          {!workflowRunId.trim() ? (
            <div style={teamStyles.empty}>请先在左侧栏选择或新建工作流</div>
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
                    ? `展示 ${filteredGraphDisplay.nodes.filter((n) => n.role !== "__tools__").length} 个 Agent`
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
                      height: teamGraphView === "office" ? "min(72vh, 860px)" : graphHeight,
                      minHeight: teamGraphView === "office" ? 520 : graphHeight,
                      maxHeight: teamGraphView === "office" ? "min(72vh, 860px)" : graphHeight,
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
                {/**
                 * HITL 主入口已迁到右栏 Orchestrator 对话框（内联卡片）。
                 * 这里仅在右栏被隐藏时作为兜底，避免同一询问出现两张卡片。
                 */}
                {!rightEffectivelyPresent && workflowRunId.trim() ? (
                  /**
                   * v2 修复：Banner 只要 workflowRunId 有效就常驻挂载，由 banner 内部用
                   * listPendingWorkflowHitl 自动发现 pending。这样即使 `teamPendingHitl`
                   * state 还没被 onAwaitingApproval 回调填充（例如刷新页面 / 切换工作流 /
                   * 自动触发的硬规则 HITL 尚未回填本地 state），
                   * 红框位置也能看到询问卡片，而不是"看不到按钮只能再输一句继续"。
                   *
                   * triggerKey 用 workflowRunId 兜底；当 onAwaitingApproval 回调发生时
                   * 优先用 requestId 触发 banner 内部 refresh，拿到最新 pending 内容。
                   */
                  <TeamHitlBanner
                    workflowRunId={workflowRunId.trim()}
                    triggerKey={teamPendingHitl?.requestId ?? workflowRunId.trim()}
                    onResolved={(decision) => {
                      setTeamPendingHitl(null);
                      setRunProgress(
                        decision === "approved" ? "已批准，分析师团队继续执行…" : "已拒绝，工作流终止"
                      );
                    }}
                  />
                ) : null}
                {!rightEffectivelyPresent ? (
                  <ResizableY
                  defaultHeight={360}
                  minHeight={200}
                  maxHeight={1200}
                  storageKey="qb.live-feed-h"
                  collapsed={liveFeedCollapsed}
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
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    实时对话流
                    {graphSelection?.kind === "edge" ? "（已按连线筛选）" : ""}
                    {running ? (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 999,
                          border: "1px solid rgba(34,197,94,0.45)",
                          background: "rgba(34,197,94,0.12)",
                          color: "#86efac",
                          fontWeight: 600,
                          letterSpacing: 0.2,
                        }}
                      >
                        正在轮询
                      </span>
                    ) : null}
                    <label
                      title="关闭后新消息进来不会再自动滚到底，便于回看上方对话"
                      style={{
                        marginLeft: "auto",
                        display: liveFeedCollapsed ? "none" : "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        fontSize: 11,
                        fontWeight: 400,
                        color: "var(--qb-team-meta, #a1a1aa)",
                        cursor: "pointer",
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={liveFeedAutoFollow}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setLiveFeedAutoFollow(next);
                          if (next) scrollLiveFeedToBottom();
                        }}
                        style={{ accentColor: "#3b82f6", cursor: "pointer" }}
                      />
                      自动跟随{liveFeedAutoFollow ? "" : "（已暂停）"}
                    </label>
                    {liveFeedCollapsed ? <span style={{ marginLeft: "auto" }} /> : null}
                    <button
                      type="button"
                      onClick={() => setLiveFeedCollapsed((v) => !v)}
                      title={liveFeedCollapsed ? "展开实时对话流窗口" : "折叠实时对话流窗口"}
                      aria-label={liveFeedCollapsed ? "展开实时对话流窗口" : "折叠实时对话流窗口"}
                      aria-expanded={!liveFeedCollapsed}
                      style={{
                        padding: "2px 8px",
                        background: "transparent",
                        color: "var(--qb-team-meta, #a1a1aa)",
                        border:
                          "1px solid var(--qb-team-live-feed-row-border, var(--qb-team-live-feed-border, #3f3f46))",
                        borderRadius: 6,
                        cursor: "pointer",
                        fontSize: 11,
                        lineHeight: 1.4,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <span aria-hidden style={{ fontSize: 10 }}>
                        {liveFeedCollapsed ? "▸" : "▾"}
                      </span>
                      {liveFeedCollapsed ? "展开" : "折叠"}
                    </button>
                    {liveFeedCollapsed ? null : (
                      <span
                        style={{
                          fontSize: 10,
                          color: "var(--qb-team-meta, #71717a)",
                          fontWeight: 400,
                        }}
                      >
                        拖底边调整高度
                      </span>
                    )}
                  </div>
                  {liveFeedCollapsed ? null : (
                    <div
                      style={{
                        position: "relative",
                        flex: "1 1 0",
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <div
                        ref={liveFeedScrollRef}
                        onScroll={handleLiveFeedScroll}
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
                      {!liveFeedAtBottom ? (
                        <button
                          type="button"
                          onClick={scrollLiveFeedToBottom}
                          title="跳到最新消息并恢复自动跟随"
                          style={{
                            position: "absolute",
                            right: 16,
                            bottom: 14,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            padding: "5px 11px",
                            borderRadius: 999,
                            border: "1px solid rgba(59,130,246,0.55)",
                            background: "rgba(15,23,42,0.85)",
                            color: "#bfdbfe",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
                            backdropFilter: "blur(4px)",
                          }}
                        >
                          <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>
                            ↓
                          </span>
                          跳到最新
                        </button>
                      ) : null}
                    </div>
                  )}
                  </ResizableY>
                ) : null}
              </div>
              {graphSelection?.kind === "node" ? (
                <div style={{ marginTop: 14 }} data-qb-team-agent-dialogue-shell>
                  <ResizableY
                    defaultHeight={420}
                    minHeight={220}
                    maxHeight={1400}
                    storageKey="qb.agent-run-h"
                    collapsed={agentRunCollapsed}
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
                      collapsed={agentRunCollapsed}
                      onToggleCollapsed={() => setAgentRunCollapsed((v) => !v)}
                      onOpenInCanvas={(target) => {
                        if (target.symbol) {
                          setChartSpec({
                            symbol: target.symbol,
                            ...(target.exchange
                              ? { exchange: coerceChartMarketExchange(target.exchange) }
                              : {}),
                          });
                          requestChartReload();
                        }
                        setResearchCanvasTab(target.kind === "news" ? "news" : "market");
                      }}
                    />
                  </ResizableY>
                </div>
              ) : (
                <div
                  style={{
                    marginTop: 14,
                    padding: "14px 16px",
                    border: "1px dashed var(--qb-team-live-feed-row-border, var(--qb-sidebar-border, #3f3f46))",
                    borderRadius: 8,
                    color: "var(--qb-team-meta, #a1a1aa)",
                    fontSize: 12,
                  }}
                >
                  点击研究画布中的 Agent 节点，查看该 Agent 的对话、工具调用与执行轨迹。
                </div>
              )}
            </>
          )}
            </>
          ) : null}
        </div>
              </div>
            </div>
          </div>
          {/**
           * 中栏底部「研究产出」抽屉（从右栏迁移）：因子 / 策略 / 脚本 / 草稿。
           * 可折叠隐去；flexShrink:0 贴在中栏底部，不参与主区滚动。
           */}
          <details
            className="qb-mcp-details"
            style={teamStyles.runControlsFooter}
            open={outputsDrawerOpen}
            onToggle={(e) => {
              const isOpen = (e.currentTarget as HTMLDetailsElement).open;
              if (isOpen !== outputsDrawerOpen) setOutputsDrawerOpen(isOpen);
            }}
          >
            <summary style={teamStyles.runControlsSummary}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#93c5fd" }}>
                  📦 研究产出 · 因子 / 策略 / 脚本 / 草稿
                </span>
              </span>
              <span style={{ fontSize: 11, color: "#a1a1aa" }}>点击折叠/展开</span>
            </summary>
            <div style={{ padding: "10px 16px 14px" }}>
              <p style={{ fontSize: 11, color: "#71717a", marginTop: 0, marginBottom: 10, lineHeight: 1.45 }}>
                展示当前研究项目下 Agent 生成的<strong>草稿 / 因子 / 策略 / 脚本</strong>。注意「策略」读 strategy_version（需 Agent 调 version_strategy 或真单触发），research 流水线吐出的 Python on_bar 脚本会落在「脚本」tab。
              </p>
              <ResearchOutputTabs
                projectId={effectiveResearchProjectId}
                workflowRunId={workflowRunId}
                sessionId={workflowSessionId || teamResearchSessionId}
                onOpenFactorInWorkbench={(factor) => {
                  setQuantContext({
                    projectId: factor.projectId,
                    workflowRunId: factor.workflowRunId ?? workflowRunId,
                    sourceLabel: factor.name,
                  });
                  setQuantHandoff({
                    kind: "factor-to-workbench",
                    factorId: factor.id,
                    projectId: factor.projectId,
                    workflowRunId: factor.workflowRunId,
                    note: `来自研究产出 · ${factor.name}`,
                  });
                  setActiveView("quant");
                  setQuantTab("factor");
                }}
                onOpenStrategyInComposer={(version) => {
                  /**
                   * 把"打开哪个 strategy_version"的上下文写到全局 store，
                   * Composer 在 mount / handoff 变化时按 strategyVersionId 自动选中。
                   */
                  if (version?.id) {
                    setQuantContext({
                      projectId: version.projectId,
                      workflowRunId: version.workflowRunId ?? workflowRunId,
                      sourceLabel: version.strategyName,
                    });
                    setQuantHandoff({
                      kind: "strategy-version-to-composer",
                      strategyVersionId: version.id,
                      workflowRunId: version.workflowRunId ?? null,
                    });
                  }
                  setActiveView("quant");
                  setQuantTab("composer");
                }}
                onOpenScriptInWorkbench={(script) => {
                  const projectId = effectiveResearchProjectId;
                  if (projectId) {
                    setQuantContext({
                      projectId,
                      workflowRunId: script.workflowRunId ?? workflowRunId,
                      sourceLabel: script.name,
                    });
                  }
                  setQuantHandoff({
                    kind: "script-to-workbench",
                    scriptId: script.id,
                    projectId,
                    workflowRunId: script.workflowRunId ?? workflowRunId,
                    note: `来自研究产出 · ${script.name}`,
                  });
                  setActiveView("quant");
                  setQuantTab("script");
                }}
              />
            </div>
          </details>
        </div>
        ) : null}

        {teamPaneVisible("center") && showInlineTeamRight ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整右侧策略栏宽度"
            onMouseDown={onTeamColGutterDown(2)}
            style={teamStyles.teamColGutter}
          />
        ) : null}

        {(() => {
          const orchestratorPanel = (
          <OrchestratorChatPanel
            workflowRunId={workflowRunId}
            events={displayedLiveFeedEvents}
            running={running}
            chatInFlight={orchestratorChatInFlight}
            completed={selectedWorkflowCompleted}
            runProgress={runProgress}
            errorMessage={error}
            onErrorDismiss={() => setError(null)}
            hitlMode={teamHitlMode}
            onHitlModeChange={setTeamHitlMode}
            agentMode={teamAgentMode}
            onAgentModeChange={setTeamAgentMode}
            pendingHitlRequestId={teamPendingHitl?.requestId ?? null}
            onHitlResolved={(decision) => {
              setTeamPendingHitl(null);
              setRunProgress(
                decision === "approved" ? "已批准，分析师团队继续执行…" : "已拒绝，工作流终止"
              );
            }}
            composerValue={teamAnalysisContext}
            onComposerChange={setTeamAnalysisContext}
            onSend={() => {
              // 唯一执行入口：交给 Orchestrator 自主判断（答 / 派单 / 全队）。
              void handleOrchestratorChat();
            }}
            onInject={async (content) => {
              const wf = workflowRunId.trim();
              if (!wf) throw new Error("请先选择工作流");
              pushUserEcho(content);
              /**
               * 广播（targetRole=null）：团队跑动时 orchestrator 不跑 react-loop（只一次规划调用），
               * 真正在跑 loop 的是各分析师 slot——由它们在下一轮 reason 前 drain 并采纳。
               */
              const res = await injectWorkflowMessage(wf, content, null);
              return res.queued;
            }}
            onInterrupt={async () => {
              const wf = workflowRunId.trim();
              if (!wf) throw new Error("请先选择工作流");
              await interruptWorkflow(wf);
            }}
            plan={teamPlan}
            onExecutePlan={() => {
              const approvedMessage =
                "计划已确认。请严格按照当前 workflow 已保存的计划开始执行，持续更新每一步状态，并在完成后给出证据、结论和未完成项。";
              setTeamAgentMode("goal");
              void handleOrchestratorChat({
                message: approvedMessage,
                agentMode: "goal",
              });
            }}
            onGoalAction={(action) => {
              const wf = workflowRunId.trim();
              if (!wf) return;
              void (async () => {
                try {
                  let text: string | undefined;
                  if (action === "edit") {
                    text =
                      window
                        .prompt(
                          "编辑 Goal（结果、约束和完成标准）",
                          teamPlan?.goal?.text ?? ""
                        )
                        ?.trim() || undefined;
                    if (!text) return;
                  }
                  const result = await updateWorkflowGoal(wf, {
                    action,
                    ...(text ? { text } : {}),
                  });
                  setTeamPlan(result.data);
                  if (action === "resume") {
                    setTeamAgentMode("goal");
                    await handleOrchestratorChat({
                      message: "请从当前 Goal 的已保存计划和进度继续执行，直到满足完成标准。",
                      agentMode: "goal",
                      preserveGoal: true,
                    });
                  } else if (action === "pause") {
                    setRunProgress("Goal 已暂停");
                    setOrchestratorChatInFlight(false);
                  } else if (action === "clear") {
                    setRunProgress("");
                  }
                } catch (e) {
                  setError(`Goal 操作失败：${(e as Error).message}`);
                }
              })();
            }}
            activity={activeRationale}
            streamEvents={orchestratorStreamEvents}
            thinkingText={streamingByRole.orchestrator?.text ?? null}
            subAgentRuns={subAgentRuns}
            artifacts={teamArtifacts}
            artifactsLoading={teamArtifactsLoading}
            artifactsError={teamArtifactsError}
            onOpenArtifact={(a) => {
              const target = quantNavigationForArtifact(
                a,
                effectiveResearchProjectId,
                workflowRunId
              );
              if (target.context) setQuantContext(target.context);
              setQuantHandoff(target.handoff);
              setActiveView("quant");
              setQuantTab(target.tab);
            }}
            sendDisabled={!workflowRunId.trim()}
            sendDisabledReason={!workflowRunId.trim() ? "请先选择工作流" : ""}
            runStrip={{
              expanded: runStripExpanded,
              onExpandedChange: setRunStripExpanded,
              summary: `${scopeModeLabel(scopeMode)} · ${
                ticker.trim() || sectorName || exploreTheme || "未设标的"
              } · ${workflowRunId.trim() ? "已选 Run" : "未选 Run"}`,
              options: workflowOptions.map((row) => ({
                id: String(row.id ?? ""),
                label: (typeof row.goal === "string" && row.goal.trim()) || String(row.id ?? "").slice(0, 8),
                status: String(row.status ?? ""),
              })),
              onSelect: (id) => {
                setWorkflowRunId(id);
                const row = workflowOptions.find((w) => String(w.id) === id);
                const sid = typeof row?.sessionId === "string" ? row.sessionId.trim() : "";
                if (sid) setSelectedConversationSessionId(sid);
              },
              onCreate: () => void handleCreateTeamWorkflow(),
              onOpenResearchSettings: () => setLeftRailMode("workflow"),
              creating: creatingTeamWorkflow,
            }}
          />
          );

          if (proDockAgent && agentDock?.hostEl) {
            return createPortal(orchestratorPanel, agentDock.hostEl);
          }
          if (!showInlineTeamRight) return null;
          return (
        <aside
          style={{
            ...teamStyles.rightRail,
            ...(!teamPaneVisible("center")
              ? { flex: 1, minWidth: 0, width: "auto" }
              : { width: teamRightW, flexShrink: 0 }),
            alignSelf: "stretch",
          }}
        >
          {orchestratorPanel}
        </aside>
          );
        })()}
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
    border: "1px solid var(--qb-team-shell-border, #3f3f46)",
    borderRadius: 10,
    overflow: "hidden",
    background: "var(--qb-team-shell-bg, #070708)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 12px 40px rgba(0,0,0,0.45)",
  },
  paneToggleBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d32)",
    background: "rgba(255, 255, 255, 0.015)",
    fontSize: 11,
  },
  paneToggleHint: {
    color: "#71717a",
    fontSize: 10.5,
    marginRight: 4,
    flexShrink: 0,
  },
  paneToggleBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 9px",
    fontSize: 11,
    borderRadius: 12,
    border: "1px solid #3f3f46",
    cursor: "pointer",
    transition: "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
    fontFamily: "inherit",
  },
  paneToggleBtnActive: {
    background: "rgba(96, 165, 250, 0.16)",
    color: "#93c5fd",
    borderColor: "rgba(96, 165, 250, 0.5)",
  },
  paneToggleBtnHidden: {
    background: "transparent",
    color: "#71717a",
    borderColor: "#3f3f46",
  },
  paneToggleBtnDisabled: {
    cursor: "not-allowed",
    opacity: 0.6,
  },
  paneToggleDot: {
    fontSize: 8,
    lineHeight: 1,
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
    /**
     * 用 CSS Grid 做"设置区按内容自然撑开 / 工作流区占余高自滚"：
     *   - 第一行 `auto`：设置区按内容自然高度（不会被压缩）
     *   - 第二行 `minmax(220px, 1fr)`：工作流区占余高，但不少于 220px
     * 之前用 `flex` 给设置区设 `maxHeight: 55%` 导致设置区被压成只剩一个下拉，
     * 体验回退；回到 grid 方案后用户能完整看到「研究范围 / 工具类型 / 标的输入
     * / 模板 / 分析提示」全套设置。
     */
    display: "grid",
    gridTemplateRows: "auto minmax(220px, 1fr)",
    alignSelf: "stretch",
    minHeight: 0,
    overflow: "hidden",
  },
  /**
   * 上半「设置区」：标题 / scope / instrument / 标的输入 / 模板 / 分析提示。
   * grid 第一行 auto 按内容撑开，不再设 maxHeight。
   * 自身允许 overflow:auto 兜底 —— 屏幕特别矮时设置区也能内滚，不会把工作流挤掉。
   */
  leftRailSettings: {
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 4,
    paddingBottom: 8,
  },
  /**
   * 下半「工作流」滚动容器。
   * grid 第二行 `minmax(220px, 1fr)` 占余高；自身 overflow auto 内滚，
   * 工作流列表自身 maxHeight 已取消、跟随本容器一起滚动 —— 单一短滚动条。
   */
  leftRailWorkflows: {
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 4,
    paddingTop: 8,
    borderTop: "1px solid var(--qb-team-shell-border, #2d2d32)",
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
  /** 中栏底部研究产出抽屉。 */
  runControlsFooter: {
    flexShrink: 0,
    borderTop: "1px solid var(--qb-team-shell-border, #2d2d32)",
    background: "var(--qb-team-run-footer-bg, rgba(255, 255, 255, 0.02))",
    margin: 0,
    borderRadius: 0,
    maxHeight: "55%",
    overflow: "auto",
  },
  runControlsSummary: {
    listStyle: "none",
    cursor: "pointer",
    padding: "10px 16px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 12,
    color: "#cbd5e1",
    userSelect: "none",
    position: "sticky",
    top: 0,
    background: "var(--qb-team-run-footer-summary-bg, #16161a)",
    zIndex: 1,
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
  sectionTitle: { color: "var(--qb-team-section-fg, #e4e4e7)", fontSize: 14, marginBottom: 10 },
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

/**
 * 工作流列表样式：单独抽出避免与 teamStyles 中其它共用样式互相污染。
 * 设计目标：
 *   - 列表容器有固定 maxHeight + overflow，避免一旦工作流多起来把左栏撑爆
 *   - 每行 item 是一个"主区按钮 + 末尾操作按钮组"的两段式布局
 *   - 选中态用左侧的紫色色条 + 背景变化突出，区别于 hover
 */
const workflowListStyles: Record<string, CSSProperties> = {
  list: {
    border: "1px solid var(--qb-team-input-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-team-input-bg, #111114)",
    padding: 4,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    /**
     * 不再设 maxHeight：列表跟随父级 leftRailWorkflows 一起滚动，
     * 避免「外层 + 内层」两个滚动条同时存在导致 thumb 卡顿、视觉上左栏满是滚动条。
     */
    /**
     * 禁止水平方向溢出滚动：之前长标题（如 "研究团队·单标的·AAPL·2026/5/25 18:23:38"）
     * 会把卡片撑宽、状态徽章被推到视野外，必须拖动横向滚动条才能看到。
     * 现在状态徽章已移到标题行最前面，再加一层兜底保险。
     */
    overflowX: "hidden",
  },
  empty: {
    padding: "16px 12px",
    textAlign: "center",
    fontSize: 12,
    color: "var(--qb-team-meta, #71717a)",
    lineHeight: 1.5,
  },
  group: { display: "flex", flexDirection: "column", gap: 4 },
  groupHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 6px",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.04em",
    color: "var(--qb-team-meta, #a1a1aa)",
    textTransform: "uppercase" as const,
    background: "var(--qb-team-table-row-border, #1a1a1d)",
    borderRadius: 4,
  },
  groupCount: {
    background: "rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: "0 6px",
    fontSize: 10,
  },
  item: {
    /**
     * 改为纵向布局：上方是文字（标题 + 元信息），下方是操作按钮行。
     * 之前用左右两段式时，操作按钮列会以"按钮内容宽度"占用空间，
     * 在左栏宽度只有 ~268px 时，按钮区压占了标题行导致文字被遮挡。
     */
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
    padding: "8px 10px",
    border: "1px solid transparent",
    borderLeft: "3px solid transparent",
    borderRadius: 6,
    background: "transparent",
    minWidth: 0,
  },
  itemSelected: {
    background: "var(--qb-team-screener-btn-active-bg, #221838)",
    borderColor: "var(--qb-team-screener-btn-active-border, #7c3aed)",
    borderLeftColor: "var(--qb-team-screener-btn-active-border, #7c3aed)",
  },
  /** 主区按钮：撑满一行，display:block 让内部 flex 子元素自由排列。 */
  itemMain: {
    width: "100%",
    minWidth: 0,
    border: "none",
    background: "transparent",
    color: "var(--qb-team-input-fg, #e4e4e7)",
    textAlign: "left" as const,
    cursor: "pointer",
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  itemTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    fontWeight: 500,
    minWidth: 0,
  },
  itemTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  itemMeta: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 8,
    fontSize: 10.5,
    color: "var(--qb-team-meta, #71717a)",
    minWidth: 0,
  },
  itemId: {
    fontSize: 10,
    color: "var(--qb-team-meta, #a1a1aa)",
  },
  /** 操作按钮行：横向、右对齐，紧贴卡片底部，不再与文字争空间。 */
  itemActions: {
    display: "flex",
    flexDirection: "row" as const,
    gap: 6,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingTop: 2,
    borderTop: "1px dashed var(--qb-team-table-row-border, #27272a)",
  },
  actionBtn: {
    fontSize: 11,
    padding: "3px 10px",
    minWidth: 0,
    lineHeight: 1.4,
  },
};
