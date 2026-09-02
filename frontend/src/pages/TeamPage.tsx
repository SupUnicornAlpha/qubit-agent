import { Ban, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createChatSession,
  createConversationTurn,
  deleteWorkflow,
  getChatSessionWorkflow,
  getDefaultProjectSession,
  getDefaultWorkspace,
  getOrCreateDefaultProject,
  getResearchWorkflowGraph,
  injectWorkflowMessage,
  interruptWorkflow,
  listBacktestJobs,
  listFactors,
  listMonitorWorkflows,
  listProjectStrategyScripts,
  listProjects,
  listStrategyVersions,
  patchWorkflow,
  putFsWorkspaceRun,
  subscribeWorkflowEvents,
  updateWorkflowGoal,
} from "../api/backend";
import type {
  AgentControlMode,
  AgentLoopKind,
  AnalystTeamGraphAgentStep,
  AnalystTeamGraphInteraction,
  AnalystTeamGraphMcpCall,
  AnalystTeamGraphPayload,
  AnalystTeamGraphToolCall,
  ResearchPhase,
  ResearchPhaseState,
  ResearchPhaseStatus,
  StepStreamEvent,
} from "../api/types";
import { KlinePanel } from "../components/chart/KlinePanel";
import { NewsBriefSection } from "../components/chart/NewsBriefSection";
import {
  TeamAgentGraph,
  type TeamGraphActivity,
  type TeamGraphSelection,
  teamGraphUndirectedKey,
} from "../components/ide/TeamAgentGraph";
import { pickPreferredProject } from "../components/quant/useDefaultProject";
import { AgentRunPanel } from "../components/team/AgentRunChatView";
import {
  type LiveConversationEvent,
  LiveConversationView,
} from "../components/team/LiveConversationView";
import {
  type OrchestratorArtifact,
  OrchestratorChatPanel,
} from "../components/team/OrchestratorChatPanel";
import type { OrchestratorPlan } from "../components/team/PlanCard";
import { ResearchAnalysisWorkspace } from "../components/team/ResearchAnalysisWorkspace";
import { ResearchMultiKlineGrid } from "../components/team/ResearchMultiKlineGrid";
import { ResearchOutputTabs } from "../components/team/ResearchOutputTabs";
import { ResearchToolResultsPanel } from "../components/team/ResearchToolResultsPanel";
import { ResizableY } from "../components/team/ResizableY";
import { TeamAgentPixelOffice } from "../components/team/TeamAgentPixelOffice";
import { TeamHitlBanner } from "../components/team/TeamHitlBanner";
import { TeamStrategyContractPane } from "../components/team/TeamStrategyContractPane";
import {
  type PlanTimelineSegment,
  latestPlanFromSegments,
  planStructureKey,
  upsertPlanSegment,
} from "../components/team/planSegments";
import { FsWorkspaceExplorer } from "../components/workspace/FsWorkspaceExplorer";
import { WorkspaceFilePane } from "../components/workspace/WorkspaceFilePane";
import { coerceChartMarketExchange, guessChartExchangeFromSymbol } from "../lib/chartSpec";
import { stripToolCallSentinels } from "../lib/chatMessageHydration";
import { isNarrativeNearDuplicate } from "../lib/narrativeNearDuplicate";
import { quantNavigationForArtifact } from "../lib/quantArtifactNavigation";
import {
  type ResearchCanvasToolHit,
  buildResearchCanvasToolHits,
  latestSuccessfulMarketLink,
} from "../lib/researchCanvasToolLink";
import { buildResearchMarketSymbolList } from "../lib/researchMarketSymbols";
import {
  type ResearchInstrumentUi,
  type ResearchScopeMode,
  parseSymbolList,
  scopeModeLabel,
} from "../lib/researchScope";
import { buildSubAgentRunSummaries } from "../lib/subAgentRuns";
import {
  buildFilteredTeamGraphDisplay,
  describeInteractionRouting,
  filterInteractionsForEdge,
} from "../lib/teamGraphDisplay";
import { formatEdgeSelectionSummary, isToolGraphEdge } from "../lib/teamGraphEdgeVisual";
import { isUiHiddenAgentThought } from "../lib/uiHiddenAgentThought";
import {
  WORKFLOW_KIND_LABEL,
  type WorkflowKind,
  classifyWorkflow,
  groupWorkflowOptions,
} from "../lib/workflowKind";
import { useAgentDockOptional } from "../shell/pro/AgentDockContext";
import { useAppStore } from "../store";

/** Team 页面（原 MainContent.TeamDashboardPanel） */
type TeamPaneKey = "left" | "center" | "right";
const TEAM_PANES: readonly TeamPaneKey[] = ["left", "center", "right"];
const TEAM_PANE_LABEL: Record<TeamPaneKey, string> = {
  left: "研究与工作流",
  center: "研究画布",
  right: "Orchestrator 对话",
};
const RESEARCH_PHASE_VALUES = new Set<ResearchPhase>([
  "scope",
  "plan",
  "evidence",
  "analysis",
  "validation",
  "delivery",
]);
const RESEARCH_PHASE_STATUS_VALUES = new Set<ResearchPhaseStatus>([
  "pending",
  "active",
  "completed",
  "revisited",
  "blocked",
]);

function parseResearchPhaseStates(raw: unknown): ResearchPhaseState[] {
  if (!Array.isArray(raw)) return [];
  const states: ResearchPhaseState[] = [];
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const phaseRaw = record.phase ?? record.researchPhase ?? record.research_phase;
    const statusRaw = record.status;
    if (
      typeof phaseRaw !== "string" ||
      !RESEARCH_PHASE_VALUES.has(phaseRaw as ResearchPhase) ||
      typeof statusRaw !== "string" ||
      !RESEARCH_PHASE_STATUS_VALUES.has(statusRaw as ResearchPhaseStatus) ||
      states.some((state) => state.phase === phaseRaw)
    ) {
      continue;
    }
    const note = typeof record.note === "string" ? record.note.trim().slice(0, 300) : "";
    states.push({
      phase: phaseRaw as ResearchPhase,
      status: statusRaw as ResearchPhaseStatus,
      ...(note ? { note } : {}),
    });
  }
  return states;
}
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
  const byCount =
    TEAM_GRAPH_VIEWPORT_MIN_HEIGHT + Math.max(0, nodeCount - 6) * TEAM_GRAPH_VIEWPORT_PER_NODE;
  const byViewport = Math.floor(viewportHeight * 0.58);
  return Math.max(
    TEAM_GRAPH_VIEWPORT_MIN_HEIGHT,
    Math.min(TEAM_GRAPH_VIEWPORT_MAX_HEIGHT, byViewport, byCount)
  );
}

export const TeamDashboardPanel: FC = () => {
  /**
   * 研究范围不再走左栏表单：新建会话用默认单标的 / 股票多头。
   * 真正的研究问题从右侧 Orchestrator 对话发出。
   */
  const ticker = "";
  const scopeMode: ResearchScopeMode = "single";
  const researchInstrument: ResearchInstrumentUi = "equity_long";
  /** 右侧 Orchestrator 输入框的研究上下文。 */
  const [teamAnalysisContext, setTeamAnalysisContext] = useState("");
  /**
   * Agent 底座/引擎：团队里每个角色单轮 reason 用哪个引擎
   * （docs/CLI_AGENT_PROJECTION_DESIGN.md 模型 B）。写入 loopOptions.roleReasoner，
   * 与 loop_kind 正交——仍走 MSA 编排，仅替换角色 reason 引擎。
   */
  const roleReasoner: AgentLoopKind = "native";
  /** Agent / Plan / Goal 工作模式；与上面的推理引擎选择正交。 */
  const teamAgentMode = useAppStore((s) => s.agentControlMode);
  const setTeamAgentMode = useAppStore((s) => s.setAgentControlMode);
  const selectedConversationSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedConversationSessionId = useAppStore((s) => s.setSelectedSessionId);

  const [workflowRunId, setWorkflowRunId] = useState("");
  /** 始终指向最新选中的 workflow，供慢请求 / 对话收口校验，避免切走后旧响应回写。 */
  const workflowRunIdRef = useRef(workflowRunId);
  useEffect(() => {
    workflowRunIdRef.current = workflowRunId;
  }, [workflowRunId]);
  const [workflowOptions, setWorkflowOptions] = useState<Array<Record<string, unknown>>>([]);
  const [workflowKindFilter, setWorkflowKindFilter] = useState<WorkflowKind | "all">("all");
  const [running, setRunning] = useState(false);
  /**
   * interrupt 已被服务端确认后，列表轮询短暂返回旧 running 状态时的本地终态闩锁。
   * 下一次从 composer / resume 明确启动同一 workflow 时会清除。
   */
  const [stoppedWorkflowId, setStoppedWorkflowId] = useState<string | null>(null);
  /** 右侧 composer 对话走 Orchestrator ReAct；与团队运行态分离。 */
  const [orchestratorChatInFlight, setOrchestratorChatInFlight] = useState(false);
  /**
   * 运行中「追加对话」队列：inject 入队给 Bun ReAct；同时本地保留，
   * 以便 Core turn 结束后自动续跑（Core 不走 drainUserMessages）。
   */
  const pendingFollowUpsRef = useRef<string[]>([]);
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
  const [agentHeartbeats, setAgentHeartbeats] = useState<
    import("../api/backend").WorkflowAgentHeartbeatsResponse | null
  >(null);
  /** 心跳快照是运行状态的服务端权威读模型；连接状态单独保留，避免重连窗口误报运行。 */
  const [heartbeatSyncState, setHeartbeatSyncState] = useState<
    "idle" | "connecting" | "live" | "degraded" | "unavailable"
  >("idle");
  useEffect(() => {
    if (!workflowRunId.trim()) {
      setAgentHeartbeats(null);
      setHeartbeatSyncState("idle");
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let didFallbackToPoll = false;
    setHeartbeatSyncState("connecting");

    void (async () => {
      const { subscribeWorkflowHeartbeatStream, getWorkflowAgentHeartbeats } = await import(
        "../api/backend"
      );
      if (cancelled) return;

      unsubscribe = subscribeWorkflowHeartbeatStream({
        workflowId: workflowRunId,
        callbacks: {
          onSnapshot: (snap) => {
            if (cancelled) return;
            setAgentHeartbeats(snap);
            setHeartbeatSyncState("live");
          },
          onEnd: () => {
            /** 心跳流结束通常意味着本轮 Agent 已无存活实例 → 同步 UI 空闲。 */
            if (cancelled) return;
            setOrchestratorChatInFlight(false);
            setRunProgress("");
            setHeartbeatSyncState("live");
          },
          onError: async () => {
            if (cancelled || didFallbackToPoll) return;
            didFallbackToPoll = true;
            setHeartbeatSyncState("degraded");
            /** SSE 失败 → 单次 polling 兜底（不再继续轮询，避免回到老的浪费节奏）。 */
            try {
              const fallback = await getWorkflowAgentHeartbeats(workflowRunId);
              if (!cancelled) {
                setAgentHeartbeats(fallback);
                setHeartbeatSyncState("degraded");
              }
            } catch {
              if (!cancelled) {
                setAgentHeartbeats(null);
                setHeartbeatSyncState("unavailable");
              }
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
  const [creatingTeamWorkflow, setCreatingTeamWorkflow] = useState(false);
  /** 新建研究会话二次确认（1 session = 1 workflow；Tauri 下不用 window.confirm） */
  const [pendingCreateWorkflow, setPendingCreateWorkflow] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem("qb.team.leftRailMode", leftRailMode);
    } catch {
      /* ignore */
    }
  }, [leftRailMode]);

  const fsWorkspaceCreateDefaults = useMemo(() => {
    const symbolsRaw = parseSymbolList(ticker);
    const symbols = [...new Set(symbolsRaw)].slice(0, 32).map((symbol) => ({
      symbol,
      exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(symbol)),
    }));
    const focusSym = symbols[0]?.symbol || ticker.trim().toUpperCase();
    return {
      name: `${scopeModeLabel(scopeMode)} · ${focusSym || "课题"}`.slice(0, 80),
      mode: scopeMode,
      symbols,
      focus: focusSym
        ? {
            symbol: focusSym,
            exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(focusSym)),
          }
        : undefined,
    };
  }, [scopeMode, ticker]);

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
    [persistHiddenTeamPanes]
  );
  const teamPaneVisible = useCallback(
    (pane: TeamPaneKey) => !hiddenTeamPanes.has(pane),
    [hiddenTeamPanes]
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
   * 供应商隐藏思考（reasoning_content 等）：按 role 只保留「当前一轮」。
   * 新一轮替换；正文 token / 收口 → status=done（虚框折叠）；不进对话正文。
   */
  const [reasoningByRole, setReasoningByRole] = useState<
    Record<string, { text: string; status: "streaming" | "done"; ts: string; stepIndex?: number }>
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
  const [teamPlanSegments, setTeamPlanSegments] = useState<PlanTimelineSegment[]>([]);
  const teamPlan = useMemo(() => latestPlanFromSegments(teamPlanSegments), [teamPlanSegments]);
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
  const [orchestratorStreamEvents, setOrchestratorStreamEvents] = useState<StepStreamEvent[]>([]);
  /**
   * 用户在右侧 Orchestrator 对话框发出的提示词回显（启动指令 / 运行中插话）。
   * 合成成 fromRole="user" 的消息事件并入实时流，让用户看到自己说过什么。
   */
  const [userEchoes, setUserEchoes] = useState<Array<{ id: string; content: string; ts: string }>>(
    []
  );
  const userEchoesRef = useRef(userEchoes);
  useEffect(() => {
    userEchoesRef.current = userEchoes;
  }, [userEchoes]);
  const pushUserEcho = useCallback((content: string) => {
    const text = content.trim();
    if (!text) return;
    setUserEchoes((prev) =>
      [
        ...prev,
        { id: `ue-${Date.now()}-${prev.length}`, content: text, ts: new Date().toISOString() },
      ].slice(-50)
    );
  }, []);
  /** 本工作流已生成的产物（内联在右栏对话框顶部，点击可打开到量化工坊）。 */
  const [teamArtifacts, setTeamArtifacts] = useState<OrchestratorArtifact[]>([]);
  const [teamArtifactsLoading, setTeamArtifactsLoading] = useState(false);
  const [teamArtifactsError, setTeamArtifactsError] = useState<string | null>(null);

  const [teamGraph, setTeamGraph] = useState<AnalystTeamGraphPayload | null>(null);
  /** SSE 正常时由事件驱动拓扑回拉；断线时才启用低频轮询兜底。 */
  const [workflowEventStreamUnavailable, setWorkflowEventStreamUnavailable] = useState(false);
  /** 单调递增；切 workflow 后丢弃过期的拓扑响应（长对话尤其容易晚归）。 */
  const teamGraphLoadGenRef = useRef(0);
  /** 切工作流后丢弃上一份产物请求，避免晚到的 setState 把旧卡片写回来。 */
  const teamArtifactLoadGenRef = useRef(0);
  const [graphSelection, setGraphSelection] = useState<TeamGraphSelection>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [teamGraphView, setTeamGraphView] = useState<"topology" | "office">("topology");
  /** 研究中栏画布：分析流 / 行情 / 新闻 / 工具结果 / 执行图 / Strategy API */
  const [researchCanvasTab, setResearchCanvasTab] = useState<
    "analysis" | "topology" | "market" | "news" | "tools" | "file" | "strategy"
  >("analysis");
  const [openWsFile, setOpenWsFile] = useState<{
    workspaceId: string;
    path: string;
  } | null>(null);
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
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);
  const setProAgentLifecycle = useAppStore((s) => s.setProAgentLifecycle);
  const pendingWorkspaceFile = useAppStore((s) => s.pendingWorkspaceFile);
  const setPendingWorkspaceFile = useAppStore((s) => s.setPendingWorkspaceFile);

  const teamTriRef = useRef<HTMLDivElement | null>(null);
  const [teamLeftW, setTeamLeftW] = useState(268);
  const [teamRightW, setTeamRightW] = useState(400);
  const teamColDrag = useRef<{
    which: 1 | 2;
    startX: number;
    left0: number;
    right0: number;
  } | null>(null);

  const refreshWorkflowOptions = useCallback(async () => {
    const wfRows = (await listMonitorWorkflows({})) as Array<Record<string, unknown>>;
    const active = wfRows.filter((w) => String(w.status) !== "cancelled");
    setWorkflowOptions(active);
    return active;
  }, []);

  const loadTeamGraph = useCallback(
    async (opts?: {
      preserveSelection?: boolean;
      /** 后台同步不切换 loading，避免运行期画布像整页刷新一样闪烁。 */
      background?: boolean;
    }) => {
      const wf = workflowRunId.trim();
      if (!wf) {
        teamGraphLoadGenRef.current += 1;
        setTeamGraph(null);
        setGraphLoading(false);
        return;
      }
      const gen = ++teamGraphLoadGenRef.current;
      if (!opts?.background) setGraphLoading(true);
      try {
        const g = await getResearchWorkflowGraph(wf);
        // 用户已切到其他工作流：丢掉本响应，否则长对话会把右侧/中栏「钉」回旧任务。
        if (gen !== teamGraphLoadGenRef.current || workflowRunIdRef.current.trim() !== wf) {
          return;
        }
        setTeamGraph(g);
        if (g?.plan?.steps?.length) {
          const at = g.plan.updatedAt ?? new Date().toISOString();
          setTeamPlanSegments((prev) => upsertPlanSegment(prev, g.plan as OrchestratorPlan, at));
        }
        if (!opts?.preserveSelection) setGraphSelection(null);
      } catch {
        if (gen !== teamGraphLoadGenRef.current || workflowRunIdRef.current.trim() !== wf) {
          return;
        }
        // 后台同步短暂失败时保留上一帧，不能为了一个网络抖动把画布清空。
        if (!opts?.background) setTeamGraph(null);
      } finally {
        if (gen === teamGraphLoadGenRef.current && !opts?.background) {
          setGraphLoading(false);
        }
      }
    },
    [workflowRunId]
  );

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

  /**
   * 将一组紧邻的 SSE 持久化事件合并为一次后台图同步。token 本身只更新本地流式气泡，
   * 不触发整图请求；这既保留实时输出，也避免刷新感。
   */
  const graphRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleTeamGraphRefresh = useCallback((delayMs = 350) => {
    if (graphRefreshTimerRef.current) clearTimeout(graphRefreshTimerRef.current);
    graphRefreshTimerRef.current = setTimeout(() => {
      graphRefreshTimerRef.current = null;
      void loadTeamGraphRef.current({ preserveSelection: true, background: true });
    }, delayMs);
  }, []);

  const handleOrchestratorChatRef = useRef<
    | ((options?: {
        message?: string;
        agentMode?: AgentControlMode;
        preserveGoal?: boolean;
        skipEcho?: boolean;
        attachments?: import("../api/types").ChatImageAttachment[];
      }) => Promise<void>)
    | null
  >(null);

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

  /**
   * 切换研究任务：先清空中栏/右栏本地态，再拉新 graph。
   * 配合 loadTeamGraph 的 gen 校验，避免长对话慢请求把 UI「钉」回旧任务。
   * 必须清 running：否则从上一个 running 任务切到新建 pending 时徽标仍显示 RUNNING。
   */
  useEffect(() => {
    setTeamGraph(null);
    setGraphSelection(null);
    setStreamingByRole({});
    setReasoningByRole({});
    setUserEchoes([]);
    setTeamPlanSegments([]);
    setActiveRationale(null);
    setOrchestratorStreamEvents([]);
    setOrchestratorChatInFlight(false);
    setWorkflowEventStreamUnavailable(false);
    setRunning(false);
    setRunProgress("");
    setError(null);
    pendingFollowUpsRef.current = [];
    settledRolesRef.current = new Set();
    if (graphRefreshTimerRef.current) {
      clearTimeout(graphRefreshTimerRef.current);
      graphRefreshTimerRef.current = null;
    }
    void loadTeamGraph();
  }, [workflowRunId, loadTeamGraph]);

  /**
   * SSE 正常时，下面的 firehose 会在持久化步骤/工具事件到达后按需刷新图数据。
   * 仅在 SSE 连接断开时低频兜底，避免 2.5 秒一次的整图替换造成画布闪烁。
   */
  useEffect(() => {
    if (
      (!running && !orchestratorChatInFlight) ||
      !workflowRunId.trim() ||
      !workflowEventStreamUnavailable
    ) {
      return;
    }
    void loadTeamGraph({ preserveSelection: true, background: true });
    const id = window.setInterval(() => {
      void loadTeamGraph({ preserveSelection: true, background: true });
    }, 10_000);
    return () => window.clearInterval(id);
  }, [
    running,
    orchestratorChatInFlight,
    workflowRunId,
    workflowEventStreamUnavailable,
    loadTeamGraph,
  ]);

  const mergedLiveFeedRows = useMemo(() => {
    type Row = { key: string; t: number; kind: "interaction" | "debate"; body: string };
    const rows: Row[] = [];
    // 实时流跟随活动拓扑：不按固定槽位白名单裁剪，任意被调用的 Agent 交互都可见
    for (const row of teamGraph?.interactions ?? []) {
      rows.push({
        key: `i-${row.id}`,
        t: new Date(row.createdAt).getTime() || 0,
        kind: "interaction",
        body: `${describeInteractionRouting(row)} · ${row.kind}${row.toolName ? ` · ${row.toolName}` : ""}\n${String(row.contentText ?? "").slice(0, 1200)}`,
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
          basketTickers: "",
          sectorPeers: "",
          exploreCandidates: "",
          instrument: researchInstrument,
          optionUnderlying: "",
        },
        toolHits: researchCanvasToolHits,
        limit: 8,
      }),
    [
      chartSpec.symbol,
      chartSpec.exchange,
      scopeMode,
      ticker,
      researchInstrument,
      researchCanvasToolHits,
    ]
  );

  const applyCanvasMarketLink = useCallback(
    (hit: ResearchCanvasToolHit, tab: "market" | "news") => {
      if (hit.symbol) {
        setChartSpec({
          symbol: hit.symbol,
          ...(hit.exchange ? { exchange: coerceChartMarketExchange(hit.exchange) } : {}),
        });
        requestChartReload();
      }
      setResearchCanvasTab(tab);
    },
    [requestChartReload, setChartSpec]
  );

  // 工具联动：同步标的到 chartSpec；不自动抢走画布 Tab（默认保持分析流）。
  useEffect(() => {
    const link = latestSuccessfulMarketLink(researchCanvasToolHits);
    if (!link?.symbol) return;
    if (lastLinkedToolIdRef.current === link.id) return;
    lastLinkedToolIdRef.current = link.id;
    setChartSpec({
      symbol: link.symbol,
      ...(link.exchange ? { exchange: coerceChartMarketExchange(link.exchange) } : {}),
    });
    // 只有用户已在行情/新闻 Tab 时才重拉，避免切 workflow 时拓扑与 klines 抢后端。
    if (researchCanvasTab === "market" || researchCanvasTab === "news") {
      requestChartReload();
    }
  }, [researchCanvasToolHits, requestChartReload, setChartSpec, researchCanvasTab]);

  useEffect(() => {
    lastLinkedToolIdRef.current = null;
    setResearchCanvasTab("analysis");
  }, [workflowRunId]);

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

  /**
   * 右栏虚框：优先 orchestrator 本轮思考；否则取最近更新的 role（专家也在跑时可见）。
   */
  const liveReasoning = useMemo(() => {
    const pick = (text: string, status: "streaming" | "done", role: string) => {
      const cleaned = text.trim();
      if (!cleaned || isUiHiddenAgentThought(cleaned)) return null;
      return { text: cleaned, status, role };
    };
    const orch = reasoningByRole.orchestrator;
    if (orch?.text?.trim()) {
      const hit = pick(orch.text, orch.status, "orchestrator");
      if (hit) return hit;
    }
    let best: { text: string; status: "streaming" | "done"; role: string; ts: string } | null =
      null;
    for (const [role, row] of Object.entries(reasoningByRole)) {
      if (!row.text?.trim() || isUiHiddenAgentThought(row.text)) continue;
      if (!best || row.ts > best.ts) {
        best = { text: row.text, status: row.status, role, ts: row.ts };
      }
    }
    return best ? { text: best.text, status: best.status, role: best.role } : null;
  }, [reasoningByRole]);

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
      if (row.fromRole === "user") persistedUserContents.add(String(row.contentText ?? "").trim());
      events.push({
        kind: "message",
        id: `i-${row.id}`,
        ts: row.createdAt,
        fromRole: row.fromRole,
        toRole: row.toRole,
        messageKind: row.kind,
        toolName: row.toolName,
        contentText: String(row.contentText ?? ""),
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
     * 并入同一时间线，令每一轮可回看；终态正文相同 / 近重复的「收到」开场白交由
     * 正式消息呈现，避免重影。
     */
    const finalAnswerTexts = (teamGraph?.interactions ?? [])
      .filter(
        (row) =>
          row.fromRole === "orchestrator" &&
          row.toRole === "user" &&
          row.kind === "llm_message" &&
          row.payloadJson &&
          typeof row.payloadJson === "object" &&
          (row.payloadJson as Record<string, unknown>).phase === "workflow_final_answer"
      )
      .map((row) => String(row.contentText ?? "").trim())
      .filter(Boolean);
    const finalAnswerSet = new Set(finalAnswerTexts);
    const seenReasonNarratives: string[] = [];
    for (const step of teamGraph?.agentSteps ?? []) {
      if (step.agentRole !== "orchestrator" || step.phase !== "reason") continue;
      const text = stripToolCallSentinels(step.thought).trim();
      if (!text || isUiHiddenAgentThought(text, step.actionJson) || finalAnswerSet.has(text)) {
        continue;
      }
      if (finalAnswerTexts.some((final) => isNarrativeNearDuplicate(text, final))) continue;
      if (seenReasonNarratives.some((prev) => isNarrativeNearDuplicate(text, prev))) continue;
      seenReasonNarratives.push(text);
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
    return events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(-200);
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
    setReasoningByRole({});
    setUserEchoes([]);
    setTeamPlanSegments([]);
    setActiveRationale(null);
    setOrchestratorStreamEvents([]);
    setWorkflowEventStreamUnavailable(false);
    settledRolesRef.current = new Set();
    pendingFollowUpsRef.current = [];
    const ORCHESTRATOR_STREAM_CAP = 120;
    const unsubscribe = subscribeWorkflowEvents({
      workflowId: wf,
      onEvent: (event) => {
        // 已切到其他任务：忽略本订阅迟到事件（长对话更易晚到）。
        if (workflowRunIdRef.current.trim() !== wf) return;
        setWorkflowEventStreamUnavailable(false);
        if (
          event.type === "tool_call_start" ||
          event.type === "tool_call_end" ||
          event.type === "step_persisted" ||
          event.type === "observe" ||
          event.type === "final" ||
          event.type === "error" ||
          event.source === "a2a"
        ) {
          scheduleTeamGraphRefresh();
        }
        const role = event.role || "unknown";
        if (
          event.type === "tool_call_start" ||
          event.type === "tool_call_end" ||
          (event.source === "a2a" && event.type !== "token" && event.type !== "reasoning_token")
        ) {
          setOrchestratorStreamEvents((prev) => [...prev, event].slice(-ORCHESTRATOR_STREAM_CAP));
        }
        if (event.type === "plan") {
          // 分步计划快照 → 任务段落（结构变则新开一段，仅进度则刷新当前段）。
          const steps = Array.isArray(event.payload?.steps)
            ? (event.payload.steps as OrchestratorPlan["steps"])
            : [];
          const mode = event.payload?.mode;
          const goal = event.payload?.goal;
          const rawResearchPhase = event.payload?.researchPhase ?? event.payload?.research_phase;
          const researchPhase =
            typeof rawResearchPhase === "string" &&
            RESEARCH_PHASE_VALUES.has(rawResearchPhase as ResearchPhase)
              ? (rawResearchPhase as ResearchPhase)
              : undefined;
          const researchPhases = parseResearchPhaseStates(
            event.payload?.researchPhases ?? event.payload?.research_phases
          );
          const snapshot: OrchestratorPlan = {
            steps,
            updatedAt: String(event.payload?.updatedAt ?? event.ts ?? ""),
            ...(mode === "agent" ||
            mode === "plan" ||
            mode === "goal" ||
            mode === "ask" ||
            mode === "diagnose"
              ? { mode }
              : {}),
            ...(goal && typeof goal === "object"
              ? { goal: goal as NonNullable<OrchestratorPlan["goal"]> }
              : {}),
            ...(researchPhase ? { researchPhase } : {}),
            ...(researchPhases.length > 0 ? { researchPhases } : {}),
          };
          const at = snapshot.updatedAt || new Date(event.ts).toISOString();
          setTeamPlanSegments((prev) => {
            const last = prev[prev.length - 1];
            const isNew = !last || planStructureKey(last.plan) !== planStructureKey(snapshot);
            let startAt = at;
            if (isNew) {
              // 把触发该任务的最近一条用户消息划入新段落（否则仍挂在上一段下面）。
              const echoes = userEchoesRef.current;
              const lastEcho = echoes[echoes.length - 1];
              if (lastEcho?.ts && (!last || lastEcho.ts >= last.startedAt) && lastEcho.ts <= at) {
                startAt = lastEcho.ts;
              }
            }
            return upsertPlanSegment(prev, snapshot, startAt);
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
        if (event.type === "reasoning_token") {
          const piece = String(event.payload?.["token"] ?? event.payload?.["text"] ?? "");
          if (!piece) return;
          const stepIndex = typeof event.stepIndex === "number" ? event.stepIndex : undefined;
          const ts = new Date(event.ts).toISOString();
          setReasoningByRole((prev) => {
            const cur = prev[role];
            const newRound =
              !cur ||
              cur.status === "done" ||
              (stepIndex !== undefined &&
                cur.stepIndex !== undefined &&
                cur.stepIndex !== stepIndex);
            return {
              ...prev,
              [role]: {
                text: (newRound ? "" : cur.text) + piece,
                status: "streaming",
                ts,
                ...(stepIndex !== undefined ? { stepIndex } : {}),
              },
            };
          });
          return;
        }
        if (event.type === "token") {
          const piece = String(event.payload?.["token"] ?? event.payload?.["text"] ?? "");
          if (!piece) return;
          // 正文开始 → 折叠本轮隐藏思考（仍可点开回看，直到下轮替换）。
          setReasoningByRole((prev) => {
            const cur = prev[role];
            if (!cur?.text.trim() || cur.status === "done") return prev;
            return { ...prev, [role]: { ...cur, status: "done" } };
          });
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
          setReasoningByRole((prev) => {
            const cur = prev[role];
            if (!cur?.text.trim() || cur.status === "done") return prev;
            return { ...prev, [role]: { ...cur, status: "done" } };
          });
          if (event.type === "final" || event.type === "error") {
            setActiveRationale(null); // 终态：清掉「正在调用」活动行
            // 强制收口未配对的 tool_call_start，避免「工具还在跑」拖住运行徽标
            setOrchestratorStreamEvents((prev) => {
              const open = new Map<string, StepStreamEvent>();
              for (const ev of prev) {
                const id = String(ev.payload.toolCallId ?? `${ev.runId}:${ev.stepIndex}`);
                if (ev.type === "tool_call_start") open.set(id, ev);
                if (ev.type === "tool_call_end") open.delete(id);
              }
              if (open.size === 0) return prev;
              const now = Date.now();
              const closes: StepStreamEvent[] = [...open.entries()].map(([id, start]) => ({
                ...start,
                type: "tool_call_end",
                ts: now,
                payload: {
                  ...start.payload,
                  toolCallId: id,
                  status: event.type === "error" ? "failed" : "success",
                },
              }));
              return [...prev, ...closes].slice(-ORCHESTRATOR_STREAM_CAP);
            });
            const followUps = pendingFollowUpsRef.current.splice(0);
            if (event.type === "final" && followUps.length > 0) {
              // 本轮结束后自动续跑追加对话（Cursor 式 queue）
              setOrchestratorChatInFlight(true);
              setRunProgress("继续处理追加对话…");
              const nextMsg = followUps.join("\n\n");
              queueMicrotask(() => {
                void handleOrchestratorChatRef.current?.({
                  message: nextMsg,
                  skipEcho: true,
                });
              });
            } else {
              setOrchestratorChatInFlight(false);
              setRunProgress("");
            }
            // chat 路径：终态后 orchestrator→user 答复才落库，防抖回拉 + 刷新工作流状态。
            if (settleRefetchTimerRef.current) clearTimeout(settleRefetchTimerRef.current);
            settleRefetchTimerRef.current = setTimeout(() => {
              void loadTeamGraphRef.current({ preserveSelection: true, background: true });
              void refreshWorkflowOptionsRef.current();
              setTimeout(() => {
                void loadTeamGraphRef.current({ preserveSelection: true, background: true });
              }, 1500);
            }, 700);
          }
        }
      },
      onError: () => {
        /** firehose 断开：低频轮询兜底，避免静默丢失已落库的拓扑变化。 */
        setWorkflowEventStreamUnavailable(true);
      },
    });
    return () => {
      unsubscribe();
      if (settleRefetchTimerRef.current) {
        clearTimeout(settleRefetchTimerRef.current);
        settleRefetchTimerRef.current = null;
      }
      if (graphRefreshTimerRef.current) {
        clearTimeout(graphRefreshTimerRef.current);
        graphRefreshTimerRef.current = null;
      }
    };
  }, [workflowRunId, scheduleTeamGraphRefresh]);

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
      if (!text || isUiHiddenAgentThought(text, step.actionJson)) continue;
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
   * 内联产物轮询：按 workflow 聚合因子、策略、回测和脚本卡片。
   * 只在切换工作流时清空；左栏列表 15s 刷新不得重拉、不得把已显示卡片抹掉。
   * 四类接口各自返回就上屏，脚本走不含代码正文的轻量列表。
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
    const gen = ++teamArtifactLoadGenRef.current;
    setTeamArtifacts([]);
    setTeamArtifactsLoading(true);
    setTeamArtifactsError(null);

    const ingest = (kind: OrchestratorArtifact["kind"], items: OrchestratorArtifact[]) => {
      if (!alive || teamArtifactLoadGenRef.current !== gen) return;
      setTeamArtifacts((prev) =>
        teamArtifactLoadGenRef.current !== gen
          ? prev
          : [...prev.filter((row) => row.kind !== kind), ...items]
      );
      setTeamArtifactsLoading(false);
    };

    const load = async () => {
      const failures: string[] = [];
      await Promise.all([
        listFactors({ workflowRunId: wf })
          .then((rows) =>
            ingest(
              "factor",
              rows.map((f) => ({
                id: f.id,
                kind: "factor" as const,
                title: f.name,
                subtitle: f.status === "draft" ? "草稿" : f.category,
                projectId: f.projectId,
                workflowRunId: f.workflowRunId,
                createdAt: f.createdAt,
              }))
            )
          )
          .catch(() => {
            failures.push("因子");
          }),
        listStrategyVersions({ workflowRunId: wf })
          .then((rows) =>
            ingest(
              "strategy",
              rows.map((v) => ({
                id: v.id,
                kind: "strategy" as const,
                title: v.strategyName,
                subtitle: v.versionTag,
                projectId: v.projectId,
                workflowRunId: v.workflowRunId,
                createdAt: v.createdAt,
              }))
            )
          )
          .catch(() => {
            failures.push("策略");
          }),
        listBacktestJobs({ workflowRunId: wf })
          .then((rows) =>
            ingest(
              "backtest",
              rows.map((b) => ({
                id: b.id,
                kind: "backtest" as const,
                title: `回测 ${b.id.slice(0, 8)}`,
                subtitle: b.status,
                projectId: undefined,
                workflowRunId: b.workflowRunId ?? wf,
                createdAt: b.startedAt,
              }))
            )
          )
          .catch(() => {
            failures.push("回测");
          }),
        listProjectStrategyScripts({ workflowRunId: wf })
          .then((rows) =>
            ingest(
              "script",
              rows.map((s) => ({
                id: s.id,
                kind: "script" as const,
                title: s.name,
                subtitle: s.purpose,
                workflowRunId: s.workflowRunId ?? wf,
                createdAt: s.createdAt,
              }))
            )
          )
          .catch(() => {
            failures.push("脚本");
          }),
      ]);
      if (!alive || teamArtifactLoadGenRef.current !== gen) return;
      setTeamArtifactsLoading(false);
      setTeamArtifactsError(
        failures.length > 0 ? `${failures.join("、")} 产物暂时同步失败，已保留其他可用产物。` : null
      );
    };

    void load();
    const timer = setInterval(() => void load(), 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workflowRunId]);

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
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { targetRoles?: unknown }).targetRoles)
            ? ((payload as { targetRoles?: unknown }).targetRoles as unknown[]).filter(
                (v): v is string => typeof v === "string" && v.length > 0
              )
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
  }, [
    filteredGraphDisplay?.interactions,
    running,
    agentHeartbeats,
    workflowOptions,
    workflowRunId,
  ]);

  const workflowSessionId = useMemo(() => {
    const row = workflowOptions.find((w) => String(w.id) === workflowRunId);
    const sid = row?.sessionId;
    return typeof sid === "string" && sid ? sid : "";
  }, [workflowRunId, workflowOptions]);

  const selectedWorkflowRow = useMemo(
    () => workflowOptions.find((w) => String(w.id) === workflowRunId) ?? null,
    [workflowOptions, workflowRunId]
  );

  /**
   * 运行态优先取 heartbeat SSE 的 workflow status：它是服务端刚读取 DB 后生成的
   * 快照，优先级高于左栏 15 秒刷新得到的旧列表行。没有快照时才降级用列表状态。
   */
  const authoritativeWorkflowStatus = useMemo(() => {
    if (agentHeartbeats?.workflowRunId === workflowRunId.trim()) {
      return agentHeartbeats.status;
    }
    return selectedWorkflowRow?.status ? String(selectedWorkflowRow.status) : null;
  }, [agentHeartbeats, selectedWorkflowRow, workflowRunId]);
  const authoritativeStatusObservedAt =
    agentHeartbeats?.workflowRunId === workflowRunId.trim() ? agentHeartbeats.summary.asOf : null;

  useEffect(() => {
    if (workflowSessionId && workflowSessionId !== selectedConversationSessionId) {
      setSelectedConversationSessionId(workflowSessionId);
    }
  }, [workflowSessionId, selectedConversationSessionId, setSelectedConversationSessionId]);

  /**
   * 选中工作流是否已结束（completed/failed/cancelled）。用于右栏「继续研究」模式：
   * 已结束时 composer 允许基于已有研究续跑（后端用上次 ticker 兜底，无需重填研究范围）。
   * running 时不算（那是注入模式）。
   */
  const selectedWorkflowCompleted = useMemo(() => {
    if (running) return false;
    const st = authoritativeWorkflowStatus;
    return st === "completed" || st === "partial" || st === "failed" || st === "cancelled";
  }, [authoritativeWorkflowStatus, running]);

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
    const wfPid = selectedWorkflowRow?.projectId ? String(selectedWorkflowRow.projectId) : "";
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
    typeof window === "undefined" ? 900 : window.innerHeight
  );
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const graphHeight = useMemo(
    () => computeTopologyHeight(filteredGraphDisplay?.nodes?.length ?? 0, viewportH),
    [filteredGraphDisplay?.nodes?.length, viewportH]
  );
  const [graphSize, setGraphSize] = useState({ w: 720, h: graphHeight });

  useLayoutEffect(() => {
    const el = graphWrapRef.current;
    if (!el) return;
    const applyWidth = (width: number) => {
      const w = Math.max(320, Math.floor(width));
      setGraphSize((prev) =>
        prev.w === w && prev.h === graphHeight ? prev : { w, h: graphHeight }
      );
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

  // NOTE: team graph 加载见上方依赖 loadTeamGraph 的 effect（含切换清空）；勿再 debounce 双发。

  useEffect(() => {
    void (async () => {
      try {
        // 单租户兜底 workspace；详见 src/runtime/bootstrap/ensure-default-workspace.ts。
        const dft = await getDefaultWorkspace();
        const wsId = dft.id;
        const projects = await listProjects(wsId);
        // 与量化工坊 useDefaultProject 同一策略，避免 Agent 写入 Default Project
        // 而团队页锁在 projects[0]（seed fixture）导致产出/列表错 project。
        let pid = pickPreferredProject(projects);
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

  useEffect(() => {
    setTeamPendingHitl(null);
  }, [workflowRunId]);

  useEffect(() => {
    const st = authoritativeWorkflowStatus ?? "";
    const locallyStopped = stoppedWorkflowId === workflowRunId.trim();
    // 用服务端工作流状态校准本地 running，避免超时/幽灵 turn 后 UI 仍以为在跑。
    // 注意：切任务时若仍带着上一轮 chatInFlight，本 effect 会早退一帧；
    // 切换清理 effect 已置 false，下一帧会按新 workflow 的 DB 状态校准。
    if (locallyStopped) {
      setRunning(false);
      return;
    }
    if (orchestratorChatInFlight) return;
    if (st === "running") {
      setRunning(true);
    } else {
      // pending / awaiting_approval / terminal / 未知 → 一律不当作在跑
      // （新建 skipDispatch 工作流是 pending，绝不能继承上一任务的 running）
      setRunning(false);
    }
  }, [authoritativeWorkflowStatus, orchestratorChatInFlight, stoppedWorkflowId, workflowRunId]);

  useEffect(() => {
    const st = authoritativeWorkflowStatus ?? "";
    const locallyStopped = stoppedWorkflowId === workflowRunId.trim();
    // pending = 已创建未开跑，不能显示 Agent: RUNNING（之前把 pending 算进 running）
    const next = teamPendingHitl
      ? "awaiting_hitl"
      : !locallyStopped && (running || orchestratorChatInFlight || st === "running")
        ? "running"
        : "idle";
    setProAgentLifecycle(next);
  }, [
    teamPendingHitl,
    running,
    orchestratorChatInFlight,
    authoritativeWorkflowStatus,
    stoppedWorkflowId,
    workflowRunId,
    setProAgentLifecycle,
  ]);

  useEffect(() => {
    if (!pendingWorkspaceFile) return;
    setOpenWsFile({
      workspaceId: pendingWorkspaceFile.workspaceId,
      path: pendingWorkspaceFile.path,
    });
    setResearchCanvasTab("file");
    setPendingWorkspaceFile(null);
  }, [pendingWorkspaceFile, setPendingWorkspaceFile]);

  /**
   * 中栏底部「研究产出」抽屉的折叠态（因子/策略/脚本/草稿）。
   * 从右栏迁移而来：右栏现在是 Orchestrator 主对话框，产物下移到中栏底部，可隐去。
   * 持久化到 localStorage，默认展开，让研究产出在分析首屏保持可见。
   */
  const OUTPUTS_DRAWER_LS_KEY = "qb.team-outputs-drawer-open";
  const [outputsDrawerOpen, setOutputsDrawerOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(OUTPUTS_DRAWER_LS_KEY);
      return stored == null ? true : stored === "1";
    } catch {
      return true;
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
    /** 追加队列续跑时勿重复 echo（inject 时已写入） */
    skipEcho?: boolean;
    attachments?: import("../api/types").ChatImageAttachment[];
  }) => {
    const wf = workflowRunId.trim();
    const msg = (options?.message ?? teamAnalysisContext).trim();
    const attachments = options?.attachments ?? [];
    if (!wf) {
      setError("请先选择工作流");
      return;
    }
    if (!msg && attachments.length === 0) return;
    const sessionId = workflowSessionId || teamResearchSessionId;
    const projectId = effectiveResearchProjectId || teamResearchProjectId;
    if (!sessionId || !projectId) {
      setError("当前工作流尚未关联有效项目/会话，无法发送消息。");
      return;
    }
    setError(null);
    setStoppedWorkflowId(null);
    const echoText = msg || "请分析附图。";
    if (!options?.skipEcho) pushUserEcho(echoText);
    if (!options?.message) setTeamAnalysisContext("");
    setOrchestratorChatInFlight(true);
    setRunProgress("Orchestrator 处理中…（自主判断是否调度团队）");
    const wfAtStart = wf;
    try {
      const turn = await createConversationTurn({
        sessionId,
        projectId,
        workflowRunId: wf,
        message: msg || echoText,
        turnMode: "continue_goal",
        hitlMode: teamHitlMode,
        roleReasoner,
        agentMode: options?.agentMode ?? teamAgentMode,
        ...(options?.preserveGoal ? { preserveGoal: true } : {}),
        ...(activeFsWorkspaceId ? { fsWorkspaceId: activeFsWorkspaceId } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      // 用户已切走：丢弃本次收口，避免旧会话把右侧钉回。
      if (workflowRunIdRef.current.trim() !== wfAtStart) {
        return;
      }
      if (activeFsWorkspaceId) {
        void putFsWorkspaceRun(activeFsWorkspaceId, wf, {
          title: echoText.slice(0, 120),
          status: "running",
          workflowId: wf,
          sessionId,
        }).catch(() => undefined);
      }
      setSelectedConversationSessionId(turn.sessionId);
      void refreshWorkflowOptions();
      void loadTeamGraph({ preserveSelection: true });
    } catch (e) {
      if (workflowRunIdRef.current.trim() !== wfAtStart) return;
      setOrchestratorChatInFlight(false);
      setError((e as Error).message);
      setRunProgress("");
    }
  };

  handleOrchestratorChatRef.current = handleOrchestratorChat;

  const handleCreateTeamWorkflow = async () => {
    if (!teamResearchProjectId) {
      setError("尚未解析到默认项目，无法创建研究会话。请检查工作区是否可用。");
      setPendingCreateWorkflow(false);
      return;
    }
    setError(null);
    setCreatingTeamWorkflow(true);
    try {
      const dft = await getDefaultWorkspace();
      const title = `研究团队 · ${scopeModeLabel(scopeMode)} · ${ticker.trim() || "标的"} · ${new Date().toLocaleString()}`;
      const session = await createChatSession({
        workspaceId: dft.id,
        projectId: teamResearchProjectId,
        title,
      });
      const workflow = await getChatSessionWorkflow(session.id, teamResearchProjectId);
      setTeamResearchSessionId(session.id);
      await refreshWorkflowOptions();
      setWorkflowRunId(String(workflow.id));
      setSelectedConversationSessionId(session.id);
      if (activeFsWorkspaceId) {
        void putFsWorkspaceRun(activeFsWorkspaceId, String(workflow.id), {
          title,
          status: "queued",
          workflowId: String(workflow.id),
          sessionId: session.id,
          focus: fsWorkspaceCreateDefaults.focus,
        }).catch(() => undefined);
      }
      setPendingCreateWorkflow(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingTeamWorkflow(false);
    }
  };

  const requestCreateTeamWorkflow = () => {
    if (creatingTeamWorkflow) return;
    setPendingCreateWorkflow(true);
  };

  const cancelPendingCreateWorkflow = () => {
    setPendingCreateWorkflow(false);
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
               * 左栏顶：视图切换。工作区 = FS 课题树；工作流 = 任务列表。
               */}
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--qb-team-section-fg, #e4e4e7)",
                  marginBottom: 8,
                }}
              >
                研究
              </div>
              <div
                className="qb-team-graph-view-toggle"
                role="tablist"
                aria-label="左栏视图"
                style={{ marginBottom: 8, alignSelf: "flex-start" }}
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
                    onOpenWorkflowSettings={() => {
                      setLeftRailMode("workflow");
                    }}
                    activeRunId={workflowRunId.trim() || null}
                    projectId={effectiveResearchProjectId || teamResearchProjectId || null}
                    onOpenFile={({ workspaceId, path }) => {
                      setOpenWsFile({ workspaceId, path });
                      setResearchCanvasTab("file");
                    }}
                  />
                </div>
              ) : (
                <div className="qb-wf-explorer" style={teamStyles.leftRailWorkflowPane}>
                  <div className="qb-wf-explorer__toolbar">
                    <input
                      type="search"
                      className="qb-wf-explorer__search"
                      value={workflowListQuery}
                      onChange={(e) => setWorkflowListQuery(e.target.value)}
                      placeholder="搜索…"
                      aria-label="搜索工作流"
                    />
                    <select
                      className="qb-wf-explorer__filter"
                      value={workflowKindFilter}
                      onChange={(e) =>
                        setWorkflowKindFilter(e.target.value as WorkflowKind | "all")
                      }
                      aria-label="工作流类型筛选"
                    >
                      <option value="all">全部</option>
                      {(Object.keys(WORKFLOW_KIND_LABEL) as WorkflowKind[]).map((k) => (
                        <option key={k} value={k}>
                          {WORKFLOW_KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="qb-wf-explorer__icon-btn"
                      onClick={() => void refreshWorkflowOptions()}
                      title="刷新"
                      aria-label="刷新工作流列表"
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      type="button"
                      className="qb-wf-explorer__icon-btn"
                      onClick={requestCreateTeamWorkflow}
                      disabled={
                        !teamResearchProjectId || !teamResearchSessionId || creatingTeamWorkflow
                      }
                      title={!teamResearchSessionId ? "正在解析默认会话…" : "新建研究会话"}
                      aria-label="新建会话"
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  {pendingCreateWorkflow ? (
                    <div className="qb-wf-explorer__confirm" role="status">
                      <span style={{ flex: 1, minWidth: 0 }}>新建一次研究回合？</span>
                      <button
                        type="button"
                        className="qb-btn-primary-brand"
                        style={{ fontSize: 11, padding: "3px 8px" }}
                        onClick={() => void handleCreateTeamWorkflow()}
                        disabled={
                          creatingTeamWorkflow || !teamResearchProjectId || !teamResearchSessionId
                        }
                      >
                        {creatingTeamWorkflow ? "创建中…" : "确认"}
                      </button>
                      <button
                        type="button"
                        className="qb-btn-secondary"
                        style={{ fontSize: 11, padding: "3px 8px" }}
                        onClick={cancelPendingCreateWorkflow}
                        disabled={creatingTeamWorkflow}
                      >
                        取消
                      </button>
                    </div>
                  ) : null}
                  {workflowRunId.trim() && !workflowSessionId && teamResearchSessionId ? (
                    <div className="qb-wf-explorer__confirm" role="status">
                      <span style={{ flex: 1, minWidth: 0 }}>当前工作流未绑定会话</span>
                      <button
                        type="button"
                        className="qb-btn-secondary"
                        style={{ fontSize: 11, padding: "3px 8px" }}
                        onClick={() => void handleLinkWorkflowToDefaultSession()}
                      >
                        关联
                      </button>
                    </div>
                  ) : null}
                  <div className="qb-wf-explorer__list" role="listbox" aria-label="工作流列表">
                    {filteredGroupedWorkflowList.length === 0 ? (
                      <div className="qb-wf-explorer__empty">
                        {workflowOptions.length === 0
                          ? "暂无工作流。点 + 新建一次研究。"
                          : "没有匹配项。"}
                      </div>
                    ) : (
                      filteredGroupedWorkflowList.map((group) => (
                        <div key={group.kind}>
                          <div className="qb-wf-group__head">
                            <span>{group.label}</span>
                            <span>{group.rows.length}</span>
                          </div>
                          {group.rows.map((row) => {
                            const id = String(row.id ?? "");
                            const goal = typeof row.goal === "string" ? row.goal.trim() : "";
                            const status = String(row.status ?? "—");
                            const sid =
                              typeof row.sessionId === "string" ? row.sessionId.trim() : "";
                            const startedAt =
                              typeof row.startedAt === "string" && row.startedAt
                                ? formatWorkflowListTime(row.startedAt)
                                : "";
                            const selected = id === workflowRunId;
                            const pendingDel = pendingHardDeleteWfId === id;
                            const tone = workflowStatusDot(status);
                            const title = workflowListTitle(goal, id);
                            return (
                              <div
                                key={id}
                                className={`qb-wf-row${selected ? " is-selected" : ""}${pendingDel ? " is-pending-delete" : ""}`}
                              >
                                <span
                                  className="qb-wf-row__dot"
                                  style={{ background: tone.color }}
                                  title={tone.label}
                                  aria-hidden
                                />
                                <button
                                  type="button"
                                  className="qb-wf-row__main"
                                  onClick={() => {
                                    setWorkflowRunId(id);
                                    if (sid) setSelectedConversationSessionId(sid);
                                    setWorkflowNotice(null);
                                  }}
                                  title={
                                    status === "failed"
                                      ? `${title}（未能完成，可在右侧继续补充）`
                                      : title
                                  }
                                  aria-pressed={selected}
                                >
                                  <div className="qb-wf-row__title">{title}</div>
                                  <div className="qb-wf-row__meta">
                                    {tone.label}
                                    {startedAt ? ` · ${startedAt}` : ""}
                                    {!sid ? " · 未绑会话" : ""}
                                  </div>
                                </button>
                                <div className="qb-wf-row__actions">
                                  <button
                                    type="button"
                                    className="qb-wf-row__action"
                                    onClick={() => void handleCancelOneWorkflow(id)}
                                    disabled={status === "cancelled"}
                                    title="取消（软删除，保留审计）"
                                    aria-label="取消工作流"
                                  >
                                    <Ban size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    className={`qb-wf-row__action${pendingDel ? " is-confirm" : " is-danger"}`}
                                    onClick={() => handleClickHardDeleteWorkflow(id)}
                                    title={
                                      pendingDel
                                        ? "再次点击确认硬删除（3 秒内有效）"
                                        : "硬删除，不可恢复"
                                    }
                                    aria-label={pendingDel ? "确认硬删除" : "硬删除工作流"}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                  {workflowNotice ? (
                    <div
                      className="qb-callout qb-callout--success"
                      role="status"
                      style={{ margin: "0 0 8px" }}
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
                  {agentHeartbeats && agentHeartbeats.summary.aliveAgents > 0 && running ? (
                    <div
                      style={{
                        flexShrink: 0,
                        padding: "4px 8px",
                        fontSize: 10,
                        color: "#86efac",
                      }}
                      title="拓扑画布节点会脉冲高亮显示活跃 Agent"
                    >
                      {agentHeartbeats.summary.aliveAgents}/{agentHeartbeats.summary.totalAgents}{" "}
                      Agent 活跃
                    </div>
                  ) : null}
                  <details className="qb-wf-explorer__topology">
                    <summary>
                      执行图
                      {teamGraph?.edges?.length ? ` · ${Math.min(teamGraph.edges.length, 24)}` : ""}
                    </summary>
                    {!teamGraph?.edges?.length ? (
                      <div className="qb-wf-explorer__topology-body">暂无边记录</div>
                    ) : (
                      <ul className="qb-wf-explorer__topology-body">
                        {teamGraph.edges.slice(0, 24).map((ed) => (
                          <li key={ed.key}>
                            {ed.a} ↔ {ed.b} · 消息 {ed.messageCount} · 工具 {ed.toolCount}
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                </div>
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
                      研究工作区 · 分析流 / 行情 / 新闻 / 工具 / 执行图
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
                  <div
                    style={{
                      ...teamStyles.teamEditorBody,
                      display: "flex",
                      flexDirection: "column",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      data-qb-team-research-panel
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        flex: 1,
                        minHeight: 0,
                        overflow: "hidden",
                        background: "transparent",
                      }}
                    >
                      <div
                        className="qb-team-graph-view-toggle"
                        role="tablist"
                        aria-label="研究画布视图"
                        style={{
                          marginBottom: 10,
                          alignSelf: "stretch",
                          width: "100%",
                          flexShrink: 0,
                        }}
                      >
                        {(
                          [
                            ["analysis", "分析流"],
                            ["topology", "执行图"],
                            ["market", "行情 K 线"],
                            ["news", "新闻资讯"],
                            ["strategy", "策略契约"],
                            [
                              "tools",
                              `工具结果${researchCanvasToolHits.length ? ` (${researchCanvasToolHits.length})` : ""}`,
                            ],
                            ...(openWsFile
                              ? [
                                  [
                                    "file",
                                    `文件 · ${openWsFile.path.split("/").pop() || "编辑"}`,
                                  ] as const,
                                ]
                              : []),
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

                      {researchCanvasTab === "analysis" ? (
                        <ResearchAnalysisWorkspace
                          events={displayedLiveFeedEvents}
                          running={running || orchestratorChatInFlight}
                          runProgress={runProgress}
                          researchPhase={teamPlan?.researchPhase}
                          researchPhases={teamPlan?.researchPhases}
                          focusSymbol={chartSpec.symbol || researchMarketSymbols[0]?.symbol || null}
                          focusExchange={
                            chartSpec.exchange || researchMarketSymbols[0]?.exchange || null
                          }
                          activeRationale={activeRationale}
                          toolHits={researchCanvasToolHits}
                          artifacts={teamArtifacts}
                          artifactsLoading={teamArtifactsLoading}
                          artifactsError={teamArtifactsError}
                          onOpenMarketEvidence={(hit) => applyCanvasMarketLink(hit, "market")}
                          onOpenNewsEvidence={(hit) => applyCanvasMarketLink(hit, "news")}
                          onOpenArtifact={(artifact) => {
                            const target = quantNavigationForArtifact(
                              artifact,
                              effectiveResearchProjectId,
                              workflowRunId
                            );
                            if (target.context) setQuantContext(target.context);
                            setQuantHandoff(target.handoff);
                            setActiveView("quant");
                            setQuantTab(target.tab);
                          }}
                        />
                      ) : null}

                      {researchCanvasTab === "strategy" ? (
                        <TeamStrategyContractPane
                          key={`${workflowSessionId || teamResearchSessionId}:${workflowRunId.trim()}`}
                          sessionId={workflowSessionId || teamResearchSessionId}
                          workflowRunId={workflowRunId.trim()}
                        />
                      ) : null}

                      {researchCanvasTab === "file" && openWsFile ? (
                        <WorkspaceFilePane
                          workspaceId={openWsFile.workspaceId}
                          path={openWsFile.path}
                          onClose={() => {
                            setOpenWsFile(null);
                            setResearchCanvasTab("analysis");
                          }}
                        />
                      ) : null}
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
                        <div
                          style={{
                            flex: 1,
                            minHeight: 0,
                            display: "flex",
                            flexDirection: "column",
                            overflow: "hidden",
                          }}
                        >
                          <ResearchToolResultsPanel
                            hits={researchCanvasToolHits}
                            onOpenMarket={(hit) => applyCanvasMarketLink(hit, "market")}
                            onOpenNews={(hit) => applyCanvasMarketLink(hit, "news")}
                          />
                        </div>
                      ) : null}

                      {researchCanvasTab === "topology" ? (
                        <>
                          <h3 style={{ ...teamStyles.sectionTitle, marginTop: 0 }}>
                            Execution Map · 团队执行图
                          </h3>
                          <p
                            style={{
                              fontSize: 12,
                              color: "var(--qb-team-meta, #a1a1aa)",
                              marginBottom: 12,
                            }}
                          >
                            默认只显示用户与编排器，其它 Agent
                            被调用后才入图。工具调用会联动到「行情 / 新闻 / 工具结果」视图。
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
                                <div
                                  className="qb-team-graph-view-toggle"
                                  role="tablist"
                                  aria-label="拓扑视图切换"
                                >
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
                                <span
                                  style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}
                                >
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
                                      height:
                                        teamGraphView === "office"
                                          ? "min(72vh, 860px)"
                                          : graphHeight,
                                      minHeight: teamGraphView === "office" ? 520 : graphHeight,
                                      maxHeight:
                                        teamGraphView === "office"
                                          ? "min(72vh, 860px)"
                                          : graphHeight,
                                      overflow: "hidden",
                                      flexDirection: "column",
                                      justifyContent:
                                        teamGraphView === "office" ? "stretch" : "center",
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
                                        onSelectNode={(role) =>
                                          setGraphSelection({ kind: "node", role })
                                        }
                                        onSelectEdge={(a, b) =>
                                          setGraphSelection({ kind: "edge", a, b })
                                        }
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
                                        onSelectNode={(role) =>
                                          setGraphSelection({ kind: "node", role })
                                        }
                                        onClear={() => setGraphSelection(null)}
                                      />
                                    )}
                                    {teamGraphView === "topology" ? (
                                      <p
                                        style={{
                                          fontSize: 10,
                                          color: "var(--qb-team-meta, #71717a)",
                                          marginTop: 6,
                                        }}
                                      >
                                        箭头表示消息方向；双向为两条弧线。工具/MCP
                                        连线：绿色=成功、红色=全失败、琥珀=部分失败。
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
                                  {graphEdgeDetail.edge && isToolGraphEdge(graphEdgeDetail.edge)
                                    ? " → "
                                    : " · "}
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
                                        decision === "approved"
                                          ? "已批准，分析师团队继续执行…"
                                          : "已拒绝，工作流终止"
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
                                      {liveFeedCollapsed ? (
                                        <span style={{ marginLeft: "auto" }} />
                                      ) : null}
                                      <button
                                        type="button"
                                        onClick={() => setLiveFeedCollapsed((v) => !v)}
                                        title={
                                          liveFeedCollapsed
                                            ? "展开实时对话流窗口"
                                            : "折叠实时对话流窗口"
                                        }
                                        aria-label={
                                          liveFeedCollapsed
                                            ? "展开实时对话流窗口"
                                            : "折叠实时对话流窗口"
                                        }
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
                                              border: "1px solid var(--qb-blue, #007acc)",
                                              background: "var(--qb-team-panel-bg, #252526)",
                                              color: "var(--qb-body-fg, #cccccc)",
                                              fontSize: 11,
                                              fontWeight: 600,
                                              cursor: "pointer",
                                              boxShadow: "none",
                                              backdropFilter: "none",
                                            }}
                                          >
                                            <span
                                              aria-hidden
                                              style={{ fontSize: 12, lineHeight: 1 }}
                                            >
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
                                              ? {
                                                  exchange: coerceChartMarketExchange(
                                                    target.exchange
                                                  ),
                                                }
                                              : {}),
                                          });
                                          requestChartReload();
                                        }
                                        setResearchCanvasTab(
                                          target.kind === "news" ? "news" : "market"
                                        );
                                      }}
                                    />
                                  </ResizableY>
                                </div>
                              ) : (
                                <div
                                  style={{
                                    marginTop: 14,
                                    padding: "14px 16px",
                                    border:
                                      "1px dashed var(--qb-team-live-feed-row-border, var(--qb-sidebar-border, #3f3f46))",
                                    borderRadius: 8,
                                    color: "var(--qb-team-meta, #a1a1aa)",
                                    fontSize: 12,
                                  }}
                                >
                                  点击研究画布中的 Agent 节点，查看该 Agent
                                  的对话、工具调用与执行轨迹。
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
                    <span
                      style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-blue, #93c5fd)" }}
                    >
                      OUTPUTS · 因子 / 策略 / 脚本 / 草稿
                    </span>
                  </span>
                  <span style={{ fontSize: 11, color: "var(--qb-body-muted, #a1a1aa)" }}>
                    点击折叠/展开
                  </span>
                </summary>
                <div style={{ padding: "10px 16px 14px" }}>
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--qb-body-muted, #71717a)",
                      marginTop: 0,
                      marginBottom: 10,
                      lineHeight: 1.45,
                    }}
                  >
                    展示当前工作流下 Agent 生成的
                    <strong>推荐 / 草稿 / 因子 / 策略 / 回测 / 脚本</strong>。
                    因子可进因子工坊或回测工坊试跑；策略组合可一键进回测工坊看
                    equity；回测结果可直接打开可视化。
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
                    onOpenFactorInBacktest={(factor) => {
                      setQuantContext({
                        projectId: factor.projectId,
                        workflowRunId: factor.workflowRunId ?? workflowRunId,
                        sourceLabel: factor.name,
                      });
                      setQuantHandoff({
                        kind: "raw",
                        expr: factor.expr,
                        lang: "qlib_expr",
                        note: `来自研究产出 · ${factor.name}`,
                      });
                      setActiveView("quant");
                      setQuantTab("backtest");
                    }}
                    onOpenStrategyInComposer={(version) => {
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
                    onOpenCompositionInBacktest={(version, composition) => {
                      setQuantContext({
                        projectId: version.projectId,
                        workflowRunId: version.workflowRunId ?? workflowRunId,
                        sourceLabel: version.strategyName,
                      });
                      setQuantHandoff({
                        kind: "composition",
                        compositionId: composition.id,
                        strategyVersionId: version.id,
                        note: `来自研究产出 · ${version.strategyName}`,
                      });
                      setActiveView("quant");
                      setQuantTab("backtest");
                    }}
                    onOpenBacktestInStudio={(job) => {
                      if (effectiveResearchProjectId) {
                        setQuantContext({
                          projectId: effectiveResearchProjectId,
                          workflowRunId: job.workflowRunId ?? workflowRunId,
                          sourceLabel: `回测 ${job.id.slice(0, 8)}`,
                        });
                      }
                      setQuantHandoff({
                        kind: "backtest-job",
                        jobId: job.id,
                        note: `来自研究产出 · ${job.status}`,
                      });
                      setActiveView("quant");
                      setQuantTab("backtest");
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
                onWorkflowResumed={() => {
                  setStoppedWorkflowId(null);
                  setRunning(true);
                  setOrchestratorChatInFlight(true);
                  setRunProgress("正在从检查点继续…");
                  setError(null);
                  void refreshWorkflowOptions();
                }}
                workflowStatus={authoritativeWorkflowStatus}
                runtimeSyncState={heartbeatSyncState}
                runtimeObservedAt={authoritativeStatusObservedAt}
                composerValue={teamAnalysisContext}
                onComposerChange={setTeamAnalysisContext}
                fsWorkspaceId={activeFsWorkspaceId}
                onSend={(message, attachments) => {
                  // 唯一执行入口：交给 Orchestrator 自主判断（答 / 派单 / 全队）。
                  void handleOrchestratorChat({
                    ...(message ? { message } : {}),
                    ...(attachments?.length ? { attachments } : {}),
                  });
                }}
                onInject={async (content) => {
                  const wf = workflowRunId.trim();
                  if (!wf) throw new Error("请先选择工作流");
                  pushUserEcho(content);
                  pendingFollowUpsRef.current.push(content);
                  /**
                   * 广播（targetRole=null）：团队跑动时 orchestrator 不跑 react-loop（只一次规划调用），
                   * 真正在跑 loop 的是各分析师 slot——由它们在下一轮 reason 前 drain 并采纳。
                   * Core 路径额外靠 pendingFollowUpsRef 在 final 后自动续跑。
                   */
                  try {
                    const res = await injectWorkflowMessage(wf, content, null);
                    return Math.max(res.queued, pendingFollowUpsRef.current.length);
                  } catch {
                    return pendingFollowUpsRef.current.length;
                  }
                }}
                onInterrupt={async () => {
                  const wf = workflowRunId.trim();
                  if (!wf) throw new Error("请先选择工作流");
                  // 乐观空闲：按钮立刻反馈，不等后端 cancel 回包
                  pendingFollowUpsRef.current = [];
                  setStoppedWorkflowId(wf);
                  setOrchestratorChatInFlight(false);
                  setRunning(false);
                  setRunProgress("");
                  setActiveRationale(null);
                  setOrchestratorStreamEvents((prev) => {
                    const open = new Map<string, StepStreamEvent>();
                    for (const ev of prev) {
                      const id = String(ev.payload.toolCallId ?? `${ev.runId}:${ev.stepIndex}`);
                      if (ev.type === "tool_call_start") open.set(id, ev);
                      if (ev.type === "tool_call_end") open.delete(id);
                    }
                    if (open.size === 0) return prev;
                    const now = Date.now();
                    return [
                      ...prev,
                      ...[...open.entries()].map(([id, start]) => ({
                        ...start,
                        type: "tool_call_end" as const,
                        ts: now,
                        payload: { ...start.payload, toolCallId: id, status: "cancelled" },
                      })),
                    ];
                  });
                  try {
                    const interrupted = await interruptWorkflow(wf);
                    // Stop 与已自然结束的竞态：不要把 completed/failed 误标成“已停止”。
                    if (interrupted.status !== "cancelled") {
                      setStoppedWorkflowId((current) => (current === wf ? null : current));
                      throw new Error(`工作流已处于 ${interrupted.status}，未执行停止操作`);
                    }
                    void loadTeamGraph({ preserveSelection: true });
                    void refreshWorkflowOptions();
                  } catch (error) {
                    setStoppedWorkflowId((current) => (current === wf ? null : current));
                    throw error;
                  }
                }}
                plan={teamPlan}
                planSegments={teamPlanSegments}
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
                            .prompt("编辑 Goal（结果、约束和完成标准）", teamPlan?.goal?.text ?? "")
                            ?.trim() || undefined;
                        if (!text) return;
                      }
                      const result = await updateWorkflowGoal(wf, {
                        action,
                        ...(text ? { text } : {}),
                      });
                      if (result.data) {
                        setTeamPlanSegments((prev) =>
                          upsertPlanSegment(
                            prev,
                            result.data!,
                            result.data!.updatedAt ?? new Date().toISOString()
                          )
                        );
                      }
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
                thinkingText={
                  running || orchestratorChatInFlight
                    ? (streamingByRole.orchestrator?.text ?? null)
                    : null
                }
                liveReasoning={
                  running || orchestratorChatInFlight || liveReasoning?.status === "streaming"
                    ? liveReasoning
                    : null
                }
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
    border: "1px solid var(--qb-team-shell-border, #2d2d2d)",
    borderRadius: 0,
    overflow: "hidden",
    background: "var(--qb-team-shell-bg, #1e1e1e)",
    boxShadow: "none",
  },
  paneToggleBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d2d)",
    background: "var(--qb-team-titlebar-bg, #252526)",
    fontSize: 11,
  },
  paneToggleHint: {
    color: "var(--qb-team-meta, #71717a)",
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
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--qb-team-input-border, #3f3f46)",
    cursor: "pointer",
    transition: "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
    fontFamily: "inherit",
  },
  paneToggleBtnActive: {
    background: "var(--qb-tint, rgba(96, 165, 250, 0.16))",
    color: "var(--qb-blue, #93c5fd)",
    borderColor: "var(--qb-blue, rgba(96, 165, 250, 0.5))",
  },
  paneToggleBtnHidden: {
    background: "transparent",
    color: "var(--qb-team-meta, #71717a)",
    borderColor: "var(--qb-team-input-border, #3f3f46)",
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
    background: "var(--qb-team-left-bg, #252526)",
    borderRight: "1px solid var(--qb-team-shell-border, #2d2d2d)",
    borderRadius: 0,
    padding: 8,
    /**
     * 外层 flex 列：标题 + 工作区/工作流 Tab 贴顶；
     * 下方内容区 flex:1。勿再用 2 行 grid 包整栏——否则 Tab 会占满 1fr，
     * 把 Workspace 树挤到栏底（中间大片空白）。
     */
    display: "flex",
    flexDirection: "column",
    gap: 0,
    alignSelf: "stretch",
    minHeight: 0,
    overflow: "hidden",
  },
  /** 工作流模式：工具条贴顶，列表吃满剩余高度。 */
  leftRailWorkflowPane: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  centerCol: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--qb-team-center-bg, #1e1e1e)",
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
    /** 产出区保持为底部 dock，最多占 42%，避免运行流被压到不可读。 */
    maxHeight: "42%",
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
    color: "var(--qb-body-fg, #cbd5e1)",
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
    background: "var(--qb-team-act-btn-active-bg, #37373d)",
    borderColor: "var(--qb-team-act-btn-active-border, var(--qb-blue, #007acc))",
    color: "var(--qb-team-act-btn-active-fg, #ffffff)",
  },
  teamMainStage: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--qb-team-stage-bg, #1e1e1e)",
  },
  teamEditorTitleBar: {
    height: 38,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d2d)",
    fontSize: 12,
    color: "var(--qb-team-titlebar-fg, #cccccc)",
    background: "var(--qb-team-titlebar-bg, #252526)",
  },
  teamEditorBody: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: 14,
  },
  rightRail: {
    background: "var(--qb-team-right-bg, #252526)",
    borderLeft: "1px solid var(--qb-team-shell-border, #2d2d2d)",
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
    background: "var(--qb-team-tab-active-bg, #1e1e1e)",
    color: "var(--qb-team-tab-active-fg, #ffffff)",
    borderColor: "var(--qb-team-tab-active-border, var(--qb-blue, #007acc))",
  },
  panel: {
    background: "var(--qb-team-panel-bg, #252526)",
    border: "1px solid var(--qb-team-panel-border, #2d2d2d)",
    borderRadius: 4,
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
  configRow: {
    display: "flex",
    gap: 12,
    alignItems: "flex-end",
    flexWrap: "wrap",
    marginBottom: 14,
  },
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
  memberGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 8,
  },
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
  empty: {
    color: "var(--qb-team-member-tag-fg, #52525b)",
    fontSize: 13,
    textAlign: "center",
    padding: 30,
  },
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

function formatWorkflowListTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const now = new Date();
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}/${mm}/${dd}`;
  return `${mm}/${dd} ${hh}:${min}`;
}

function workflowListTitle(goal: string, id: string): string {
  const cleaned = goal.replace(/^研究团队\s*[·•]\s*/, "").trim();
  return cleaned || `(无标题) ${id.slice(0, 8)}`;
}

function workflowStatusDot(status: string): { color: string; label: string } {
  switch (status) {
    case "running":
      return { color: "#22c55e", label: "运行中" };
    case "failed":
      return { color: "#f87171", label: "失败" };
    case "cancelled":
      return { color: "#71717a", label: "已取消" };
    case "completed":
      return { color: "#60a5fa", label: "已完成" };
    case "awaiting_approval":
      return { color: "#fbbf24", label: "待审批" };
    case "pending":
    case "queued":
      return { color: "#a1a1aa", label: "排队" };
    default:
      return { color: "#71717a", label: status || "未知" };
  }
}
