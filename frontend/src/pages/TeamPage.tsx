import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { createConversationTurn, getOrCreateDefaultProject, createWorkflow, putFsWorkspaceRun, getDefaultWorkspace, getDefaultProjectSession, getAnalystTeamGraph, deleteWorkflow, listMonitorWorkflows, listProjects, patchWorkflow, updateWorkflowGoal, injectWorkflowMessage, interruptWorkflow, listFactors, listStrategyVersions, listStrategyScripts, subscribeWorkflowEvents } from "../api/backend";
import type { AnalystTeamGraphPayload, AnalystTeamGraphInteraction, AnalystTeamGraphAgentStep, AnalystTeamGraphToolCall, AnalystTeamGraphMcpCall, StepStreamEvent, AgentControlMode, AgentLoopKind } from "../api/types";
import { useAppStore } from "../store";
import { stripToolCallSentinels } from "../lib/chatMessageHydration";
import { isNarrativeNearDuplicate } from "../lib/narrativeNearDuplicate";
import { KlinePanel } from "../components/chart/KlinePanel";
import { NewsBriefSection } from "../components/chart/NewsBriefSection";
import { TeamAgentGraph, teamGraphUndirectedKey, type TeamGraphActivity, type TeamGraphSelection } from "../components/ide/TeamAgentGraph";
import { TeamAgentPixelOffice } from "../components/team/TeamAgentPixelOffice";
import { ResearchMultiKlineGrid } from "../components/team/ResearchMultiKlineGrid";
import { ResearchToolResultsPanel } from "../components/team/ResearchToolResultsPanel";
import { buildResearchCanvasToolHits, latestSuccessfulMarketLink, type ResearchCanvasToolHit } from "../lib/researchCanvasToolLink";
import { coerceChartMarketExchange, guessChartExchangeFromSymbol } from "../lib/chartSpec";
import { buildResearchMarketSymbolList } from "../lib/researchMarketSymbols";
import { chartPatchFromResearchScope } from "../lib/researchScopeChartLink";
import { formatEdgeSelectionSummary, isToolGraphEdge } from "../lib/teamGraphEdgeVisual";
import { filterPromptTemplates, instrumentLabel, parseSymbolList, scopeModeLabel, type ResearchInstrumentUi, type ResearchScopeMode } from "../lib/researchScope";
import { buildFilteredTeamGraphDisplay, describeInteractionRouting, filterInteractionsForEdge } from "../lib/teamGraphDisplay";
import { ResearchOutputTabs } from "../components/team/ResearchOutputTabs";
import { AgentRunPanel } from "../components/team/AgentRunChatView";
import { LiveConversationView, type LiveConversationEvent } from "../components/team/LiveConversationView";
import { ResizableY } from "../components/team/ResizableY";
import { TeamHitlBanner } from "../components/team/TeamHitlBanner";
import type { OrchestratorPlan } from "../components/team/PlanCard";
import { OrchestratorChatPanel, type OrchestratorArtifact } from "../components/team/OrchestratorChatPanel";
import { FsWorkspaceExplorer } from "../components/workspace/FsWorkspaceExplorer";
import { WorkspaceFilePane } from "../components/workspace/WorkspaceFilePane";
import { TeamResearchSettingsPanel } from "../components/team/TeamResearchSettingsPanel";
import { buildSubAgentRunSummaries } from "../lib/subAgentRuns";
import { classifyWorkflow, groupWorkflowOptions, WORKFLOW_KIND_LABEL, type WorkflowKind } from "../lib/workflowKind";
import { quantNavigationForArtifact } from "../lib/quantArtifactNavigation";
import { useAgentDockOptional } from "../shell/pro/AgentDockContext";


/** Team 页面（原 MainContent.TeamDashboardPanel） */
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

export const TeamDashboardPanel: FC = () => {
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
  const [agentHeartbeats, setAgentHeartbeats] =
    useState<import("../api/backend").WorkflowAgentHeartbeatsResponse | null>(null);
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
      } = await import("../api/backend");
      if (cancelled) return;

      unsubscribe = subscribeWorkflowHeartbeatStream({
        workflowId: workflowRunId,
        callbacks: {
          onSnapshot: (snap) => {
            if (cancelled) return;
            setAgentHeartbeats(snap);
          },
          onEnd: () => {
            /** 心跳流结束通常意味着本轮 Agent 已无存活实例 → 同步 UI 空闲。 */
            if (cancelled) return;
            setOrchestratorChatInFlight(false);
            setRunProgress("");
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
  /** 新建工作流二次确认（Tauri 下不用 window.confirm） */
  const [pendingCreateWorkflow, setPendingCreateWorkflow] = useState(false);

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
    "topology" | "market" | "news" | "tools" | "file"
  >("topology");
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

  const handleOrchestratorChatRef = useRef<
    ((options?: {
      message?: string;
      agentMode?: AgentControlMode;
      preserveGoal?: boolean;
      skipEcho?: boolean;
    }) => Promise<void>) | null
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

  /**
   * 右栏虚框：优先 orchestrator 本轮思考；否则取最近更新的 role（专家也在跑时可见）。
   */
  const liveReasoning = useMemo(() => {
    const orch = reasoningByRole.orchestrator;
    if (orch?.text?.trim()) {
      return { text: orch.text, status: orch.status, role: "orchestrator" as const };
    }
    let best: { text: string; status: "streaming" | "done"; role: string; ts: string } | null =
      null;
    for (const [role, row] of Object.entries(reasoningByRole)) {
      if (!row.text?.trim()) continue;
      if (!best || row.ts > best.ts) {
        best = { text: row.text, status: row.status, role, ts: row.ts };
      }
    }
    return best
      ? { text: best.text, status: best.status, role: best.role }
      : null;
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
      .map((row) => row.contentText.trim())
      .filter(Boolean);
    const finalAnswerSet = new Set(finalAnswerTexts);
    const seenReasonNarratives: string[] = [];
    for (const step of teamGraph?.agentSteps ?? []) {
      if (step.agentRole !== "orchestrator" || step.phase !== "reason") continue;
      const text = stripToolCallSentinels(step.thought).trim();
      if (
        !text ||
        text === "Reasoning with LLM provider" ||
        /^Prime Core (reasoning|acting)/i.test(text) ||
        finalAnswerSet.has(text)
      ) {
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
    setReasoningByRole({});
    setUserEchoes([]);
    setTeamPlan(null);
    setActiveRationale(null);
    setOrchestratorStreamEvents([]);
    settledRolesRef.current = new Set();
    pendingFollowUpsRef.current = [];
    const ORCHESTRATOR_STREAM_CAP = 120;
    const unsubscribe = subscribeWorkflowEvents({
      workflowId: wf,
      onEvent: (event) => {
        const role = event.role || "unknown";
        if (
          event.type === "tool_call_start" ||
          event.type === "tool_call_end" ||
          (event.source === "a2a" && event.type !== "token" && event.type !== "reasoning_token")
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
          const stepIndex =
            typeof event.stepIndex === "number" ? event.stepIndex : undefined;
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
                const id = String(
                  ev.payload.toolCallId ?? `${ev.runId}:${ev.stepIndex}`
                );
                if (ev.type === "tool_call_start") open.set(id, ev);
                if (ev.type === "tool_call_end") open.delete(id);
              }
              if (open.size === 0) return prev;
              const now = Date.now();
              const closes: StepStreamEvent[] = [...open.entries()].map(
                ([id, start]) => ({
                  ...start,
                  type: "tool_call_end",
                  ts: now,
                  payload: {
                    ...start.payload,
                    toolCallId: id,
                    status: event.type === "error" ? "failed" : "success",
                  },
                })
              );
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

  useEffect(() => {
    const next = teamPendingHitl
      ? "awaiting_hitl"
      : running || orchestratorChatInFlight
        ? "running"
        : "idle";
    setProAgentLifecycle(next);
  }, [teamPendingHitl, running, orchestratorChatInFlight, setProAgentLifecycle]);

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
    /** 追加队列续跑时勿重复 echo（inject 时已写入） */
    skipEcho?: boolean;
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
    if (!options?.skipEcho) pushUserEcho(msg);
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
        ...(activeFsWorkspaceId ? { fsWorkspaceId: activeFsWorkspaceId } : {}),
      });
      if (activeFsWorkspaceId) {
        void putFsWorkspaceRun(activeFsWorkspaceId, wf, {
          title: msg.slice(0, 120),
          status: "running",
          workflowId: wf,
          sessionId,
        }).catch(() => undefined);
      }
      setSelectedConversationSessionId(turn.sessionId);
      void refreshWorkflowOptions();
      void loadTeamGraph({ preserveSelection: true });
    } catch (e) {
      setOrchestratorChatInFlight(false);
      setError((e as Error).message);
      setRunProgress("");
    }
  };

  handleOrchestratorChatRef.current = handleOrchestratorChat;

  const handleCreateTeamWorkflow = async () => {
    if (!teamResearchProjectId || !teamResearchSessionId) {
      setError("尚未解析到默认项目/会话，无法创建工作流。请检查工作区是否可用。");
      setPendingCreateWorkflow(false);
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
      if (activeFsWorkspaceId) {
        void putFsWorkspaceRun(activeFsWorkspaceId, String(created.data.id), {
          title: `研究团队 · ${scopeModeLabel(scopeMode)} · ${ticker.trim() || sectorName || "标的"}`,
          status: "queued",
          workflowId: String(created.data.id),
          sessionId: teamResearchSessionId,
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
    setRunStripExpanded(true);
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


  const researchSettingsPanel = (
    <TeamResearchSettingsPanel
      styles={teamStyles}
      compact
      scopeMode={scopeMode}
      onScopeModeChange={handleScopeModeChange}
      researchInstrument={researchInstrument}
      onResearchInstrumentChange={handleResearchInstrumentChange}
      roleReasoner={roleReasoner}
      onRoleReasonerChange={setRoleReasoner}
      ticker={ticker}
      onTickerChange={setTicker}
      basketTickers={basketTickers}
      onBasketTickersChange={setBasketTickers}
      sectorName={sectorName}
      onSectorNameChange={setSectorName}
      sectorPeers={sectorPeers}
      onSectorPeersChange={setSectorPeers}
      exploreTheme={exploreTheme}
      onExploreThemeChange={setExploreTheme}
      exploreCandidates={exploreCandidates}
      onExploreCandidatesChange={setExploreCandidates}
      optionUnderlying={optionUnderlying}
      onOptionUnderlyingChange={setOptionUnderlying}
      optionContract={optionContract}
      onOptionContractChange={setOptionContract}
      optionExpiry={optionExpiry}
      onOptionExpiryChange={setOptionExpiry}
      optionStrike={optionStrike}
      onOptionStrikeChange={setOptionStrike}
      optionRight={optionRight}
      onOptionRightChange={setOptionRight}
      promptTemplateId={promptTemplateId}
      onApplyPromptTemplate={applyPromptTemplate}
      availablePromptTemplates={availablePromptTemplates}
      teamAnalysisContext={teamAnalysisContext}
      onTeamAnalysisContextChange={setTeamAnalysisContext}
      onClearPromptTemplateId={() => setPromptTemplateId("")}
      scopeModeLabel={scopeModeLabel}
      instrumentLabel={instrumentLabel}
    />
  );

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
              onOpenWorkflowSettings={() => {
                setRunStripExpanded(true);
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
            <div style={teamStyles.leftRailWorkflowPane}>
          <div style={teamStyles.leftRailSettings}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 8 }}>
            工作流列表
          </div>
          <p style={{ fontSize: 11, color: "#71717a", marginBottom: 10, lineHeight: 1.45 }}>
            研究设置已迁至右侧 Orchestrator 的 <strong>Run 条</strong>（展开即可编辑范围 / 标的 / 提示）。
            新建工作流等同开启一次新研究，需确认。
          </p>
          <button
            type="button"
            style={{
              border: "none",
              background: "transparent",
              color: "#38bdf8",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
              marginBottom: 8,
              textAlign: "left",
            }}
            onClick={() => setRunStripExpanded(true)}
          >
            打开 Run 条研究设置 →
          </button>
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
              {pendingCreateWorkflow ? (
                <>
                  <button
                    type="button"
                    className="qb-btn-primary-brand"
                    style={{ fontSize: 12, padding: "6px 10px" }}
                    onClick={() => void handleCreateTeamWorkflow()}
                    disabled={
                      creatingTeamWorkflow ||
                      !teamResearchProjectId ||
                      !teamResearchSessionId
                    }
                    title="确认后将创建一条新的研究工作流（等同新研究回合）"
                  >
                    {creatingTeamWorkflow ? "创建中…" : "确认新建工作流"}
                  </button>
                  <button
                    type="button"
                    className="qb-btn-secondary"
                    style={{ fontSize: 12, padding: "6px 10px" }}
                    onClick={cancelPendingCreateWorkflow}
                    disabled={creatingTeamWorkflow}
                  >
                    取消
                  </button>
                  <span style={{ fontSize: 11, color: "#fbbf24", alignSelf: "center" }}>
                    新建工作流 = 新研究回合，确认后才会创建
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  className="qb-btn-secondary"
                  style={{ fontSize: 12, padding: "6px 10px" }}
                  onClick={requestCreateTeamWorkflow}
                  disabled={!teamResearchProjectId || !teamResearchSessionId}
                  title={
                    !teamResearchSessionId
                      ? "正在解析默认会话…"
                      : "创建仅用于研究团队的工作流（不触发总控编排）"
                  }
                >
                  新建工作流
                </button>
              )}
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
            ...teamStyles.panel,
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
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
                ...(openWsFile
                  ? [["file", `文件 · ${openWsFile.path.split("/").pop() || "编辑"}`] as const]
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

          {researchCanvasTab === "file" && openWsFile ? (
            <WorkspaceFilePane
              workspaceId={openWsFile.workspaceId}
              path={openWsFile.path}
              onClose={() => {
                setOpenWsFile(null);
                setResearchCanvasTab("topology");
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
                展示当前工作流下 Agent 生成的<strong>推荐 / 草稿 / 因子 / 策略 / 脚本</strong>。
                Rust Core 主路径写入的是「推荐」（recommendation.record）；「策略」需
                strategy.create_version，「脚本」来自 research 流水线的 Python on_bar。
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
            fsWorkspaceId={activeFsWorkspaceId}
            onSend={(message) => {
              // 唯一执行入口：交给 Orchestrator 自主判断（答 / 派单 / 全队）。
              void handleOrchestratorChat(message ? { message } : undefined);
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
              setOrchestratorChatInFlight(false);
              setRunning(false);
              setRunProgress("");
              setActiveRationale(null);
              setOrchestratorStreamEvents((prev) => {
                const open = new Map<string, StepStreamEvent>();
                for (const ev of prev) {
                  const id = String(
                    ev.payload.toolCallId ?? `${ev.runId}:${ev.stepIndex}`
                  );
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
              await interruptWorkflow(wf);
              void loadTeamGraph({ preserveSelection: true });
              void refreshWorkflowOptions();
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
            thinkingText={
              running || orchestratorChatInFlight
                ? streamingByRole.orchestrator?.text ?? null
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
                if (activeFsWorkspaceId && id) {
                  void putFsWorkspaceRun(activeFsWorkspaceId, id, {
                    title:
                      (typeof row?.goal === "string" && row.goal.trim()) ||
                      id.slice(0, 8),
                    status: String(row?.status ?? "queued"),
                    workflowId: id,
                    sessionId: sid || undefined,
                  }).catch(() => undefined);
                }
              },
              onCreate: () => {
                if (pendingCreateWorkflow) {
                  void handleCreateTeamWorkflow();
                  return;
                }
                requestCreateTeamWorkflow();
              },
              onOpenResearchSettings: () => setLeftRailMode("workflow"),
              creating: creatingTeamWorkflow,
              createConfirmPending: pendingCreateWorkflow,
              onCancelCreate: cancelPendingCreateWorkflow,
              settingsContent: researchSettingsPanel,
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
  /** 工作流模式下：设置提示 + 列表的内层 grid */
  leftRailWorkflowPane: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateRows: "auto minmax(180px, 1fr)",
    overflow: "hidden",
  },
  /**
   * 上半「设置区」：研究设置入口提示（表单已迁 Run 条）。
   */
  leftRailSettings: {
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 4,
    paddingBottom: 8,
  },
  /**
   * 下半「工作流」滚动容器。
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
