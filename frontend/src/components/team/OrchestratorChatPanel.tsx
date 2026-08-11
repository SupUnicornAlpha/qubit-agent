/**
 * Orchestrator 主对话面板（右栏 · Agent IDE 形态）
 *
 *   顶部 Header：标题 + 运行徽标 + 自主/HITL 模式切换
 *   中部 Body  ：内联 HITL 卡片 + Orchestrator 主视角对话流
 *   底部 Footer：composer —— Cursor 式发送键：
 *     - 空闲 + 有内容 → 发送（新 turn）
 *     - 运行中 + 有内容 → 追加对话（inject，下一轮 reason 采纳）
 *     - 运行中 + 无内容 → 停止（interrupt / cancel Core turn）
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AgentControlMode, type StepStreamEvent } from "../../api/types";
import {
  listFsWorkspaceMemory,
  type FsMemoryEntry,
} from "../../api/backend";
import { AgentModePicker, getAgentModeOption } from "../chat/AgentModePicker";
import {
  buildChatExecutionActivity,
  ChatExecutionActivity,
} from "../chat/ChatExecutionActivity";
import type { SubAgentRunSummary } from "../../lib/subAgentRuns";
import { type LiveConversationEvent, LiveConversationView } from "./LiveConversationView";
import {
  type LiveReasoningState,
  ThinkingGhostBox,
} from "./ThinkingGhostBox";
import { OrchestratorLiveStatus } from "./OrchestratorLiveStatus";
import { SubAgentRunsPanel } from "./SubAgentRunsPanel";
import { AgentRunPanel } from "./AgentRunChatView";
import { TeamHitlBanner } from "./TeamHitlBanner";
import { WorkflowResumeBanner } from "./WorkflowResumeBanner";
import { type OrchestratorPlan, PlanCard } from "./PlanCard";
import {
  splitEventsForPlanPlacement,
  type PlanTimelineSegment,
} from "./planSegments";

export type OrchestratorHitlMode = "off" | "ai" | "always";

/** 内联产物卡片（Orchestrator 对话框里直接展示已生成的因子/策略/回测/脚本，点击可打开）。 */
export interface OrchestratorArtifact {
  id: string;
  kind: "factor" | "strategy" | "script" | "backtest";
  title: string;
  subtitle?: string;
  projectId?: string | null;
  workflowRunId?: string | null;
  /** 用于插入对话流的时间锚点 */
  createdAt?: string | null;
}

export interface OrchestratorChatPanelProps {
  /** 当前工作流 run id（驱动 HITL banner 自挂载 + composer 启用判定） */
  workflowRunId: string;
  /** 归一化后的对话事件（已按 selfRole=orchestrator 视角过滤/组装） */
  events: LiveConversationEvent[];
  /** 是否正在轮询/运行（全队分析 handleRun） */
  running: boolean;
  /** orchestrator-chat composer 对话进行中（与 running 分离，仍显示运行徽标但不切注入模式） */
  chatInFlight?: boolean;
  /** 选中工作流是否已完成/失败（用于「继续研究」模式：基于已有研究续跑，无需重填范围） */
  completed: boolean;
  /** 运行进度文案（running 时显示在 composer 上方） */
  runProgress: string;
  /** 当前执行或工作流操作错误，统一在右侧 composer 上方展示 */
  errorMessage?: string | null;
  onErrorDismiss?: () => void;
  /** 自主 / HITL 模式 */
  hitlMode: OrchestratorHitlMode;
  onHitlModeChange: (mode: OrchestratorHitlMode) => void;
  /** 下一条新对话采用的 Agent / Plan / Goal 工作模式 */
  agentMode: AgentControlMode;
  onAgentModeChange: (mode: AgentControlMode) => void;
  /** 是否存在 pending HITL（外部状态；用于 composer 文案与 banner triggerKey 兜底） */
  pendingHitlRequestId: string | null;
  /** HITL 解决后回调（同 TeamHitlBanner.onResolved） */
  onHitlResolved: (decision: "approved" | "rejected") => void;
  /** 从检查点续跑成功后回调（刷新状态 / 进入 running） */
  onWorkflowResumed?: () => void;
  /** composer 文本（受控；与左栏「分析提示」共享同一 state） */
  composerValue: string;
  onComposerChange: (value: string) => void;
  /** 空闲时发送；可传入已展开文案（含 @记忆 正文） */
  onSend: (message?: string) => void;
  /** 运行中发送：把 composerValue 注入运行中的 Orchestrator，返回队列剩余条数 */
  onInject: (content: string) => Promise<number>;
  /** 协作式中断：请求在下一个安全断点暂停，等用户输入新提示词后续跑 */
  onInterrupt: () => Promise<void>;
  /** 当前 FS Workspace：@记忆 引用列表来源 */
  fsWorkspaceId?: string | null;
  /** 最新 plan（Goal 操作等）；对话内展示优先用 planSegments */
  plan?: OrchestratorPlan | null;
  /** 任务级 plan 时间线：旧任务在上，结构变化则新开一段 */
  planSegments?: PlanTimelineSegment[];
  /** Plan 审批后保留计划并以 Goal 模式继续同一 workflow */
  onExecutePlan?: () => void;
  /** Goal 生命周期控制：暂停、恢复、编辑和清除。 */
  onGoalAction?: (action: "pause" | "resume" | "edit" | "clear") => void;
  /** Coding-Agent 体验 P1：当前「正在调用什么、为何」活动行（tool_rationale 推流） */
  activity?: { tool: string; why: string } | null;
  /** firehose 近时 step 事件，驱动工具调用中 / A2A 实时卡 */
  streamEvents?: StepStreamEvent[];
  /** Orchestrator 当前流式思考文本（token 缓冲） */
  thinkingText?: string | null;
  /**
   * 供应商隐藏思考（reasoning_content）：DeepSeek 式虚框，不进正文。
   * 每轮替换；正文 token / 终态到来后折叠。
   */
  liveReasoning?: LiveReasoningState | null;
  /**
   * Orchestrator 已派发的子 Agent 运行摘要（可展开看内部轨迹）。
   * 让用户在右栏直接看见「谁在跑」，不必先点中间拓扑。
   */
  subAgentRuns?: SubAgentRunSummary[];
  /** 本工作流已生成的产物（因子/策略/脚本）；对话流内联 + 顶部精简汇总 */
  artifacts: OrchestratorArtifact[];
  artifactsLoading?: boolean;
  artifactsError?: string | null;
  /** 点击产物卡片：跳到量化工坊 / 底部抽屉打开 */
  onOpenArtifact: (artifact: OrchestratorArtifact) => void;
  /** 空闲启动是否禁用（沿用 teamRunDisabled） */
  sendDisabled: boolean;
  /** 启动禁用原因（tooltip） */
  sendDisabledReason: string;
  /** 当前工作流 DB 状态（用于 resume 条在 pending/running 时立即隐藏） */
  workflowStatus?: string | null;
}

const MODE_OPTIONS: ReadonlyArray<{ id: OrchestratorHitlMode; label: string; hint: string }> = [
  { id: "off", label: "完全自主", hint: "Orchestrator 自主完成，仅资金/规模/重试硬规则会暂停" },
  { id: "ai", label: "由 AI 决定", hint: "Orchestrator 自评 + 硬规则共同决定是否暂停征询" },
  { id: "always", label: "每步确认", hint: "每次规划完成都暂停，等你批准/拒绝" },
];

export function OrchestratorChatPanel({
  workflowRunId,
  events,
  running,
  chatInFlight = false,
  runProgress,
  errorMessage = null,
  onErrorDismiss,
  hitlMode,
  onHitlModeChange,
  agentMode,
  onAgentModeChange,
  pendingHitlRequestId,
  onHitlResolved,
  onWorkflowResumed,
  completed,
  composerValue,
  onComposerChange,
  onSend,
  onInject,
  onInterrupt,
  plan,
  planSegments = [],
  onExecutePlan,
  onGoalAction,
  activity,
  streamEvents = [],
  thinkingText = null,
  liveReasoning = null,
  subAgentRuns = [],
  artifacts,
  artifactsLoading = false,
  artifactsError = null,
  onOpenArtifact,
  sendDisabled,
  sendDisabledReason,
  workflowStatus = null,
  fsWorkspaceId = null,
}: OrchestratorChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatContentRef = useRef<HTMLDivElement | null>(null);
  /**
   * Stick-to-bottom: only auto-scroll while the user is near the bottom.
   * Scrolling up pauses follow so streaming/tool rows do not yank the viewport.
   */
  const [chatAutoFollow, setChatAutoFollow] = useState(true);
  const [chatAtBottom, setChatAtBottom] = useState(true);
  const chatAutoFollowRef = useRef(true);
  /** Suppress onScroll while we programmatically pin to bottom (avoids false "user scrolled up"). */
  const pinningScrollRef = useRef(false);
  useEffect(() => {
    chatAutoFollowRef.current = chatAutoFollow;
  }, [chatAutoFollow]);

  const pinChatToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !chatAutoFollowRef.current) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= 1) return;
    pinningScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      pinningScrollRef.current = false;
      setChatAtBottom(true);
    });
  }, []);

  const scrollChatToBottom = useCallback(() => {
    setChatAtBottom(true);
    setChatAutoFollow(true);
    chatAutoFollowRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    pinningScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      pinningScrollRef.current = false;
      setChatAtBottom(true);
    });
  }, []);

  const handleChatScroll = useCallback(() => {
    if (pinningScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 24;
    setChatAtBottom(atBottom);
    if (atBottom) {
      if (!chatAutoFollowRef.current) setChatAutoFollow(true);
    } else if (distanceFromBottom > 64 && chatAutoFollowRef.current) {
      setChatAutoFollow(false);
    }
  }, []);

  const [injectHint, setInjectHint] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [focusedSubAgentRole, setFocusedSubAgentRole] = useState<string | null>(null);
  const [memoryPickerOpen, setMemoryPickerOpen] = useState(false);
  const [memoryHits, setMemoryHits] = useState<FsMemoryEntry[]>([]);
  const [memoryMentions, setMemoryMentions] = useState<FsMemoryEntry[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [statusRailPinned, setStatusRailPinned] = useState(() => {
    try {
      return window.localStorage.getItem("qb.orchestrator.statusRailPinned") !== "0";
    } catch {
      return true;
    }
  });
  const subConversationRef = useRef<HTMLDivElement | null>(null);
  const wfId = workflowRunId.trim();
  const focusedSubAgent = useMemo(
    () => subAgentRuns.find((run) => run.role === focusedSubAgentRole) ?? null,
    [subAgentRuns, focusedSubAgentRole]
  );

  const toggleStatusRailPinned = () => {
    setStatusRailPinned((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("qb.orchestrator.statusRailPinned", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  /**
   * 本对话框只聚焦 Orchestrator 与用户：
   *   - Orchestrator → 用户：正式输出气泡
   *   - Orchestrator → 子 Agent / msa / 全员：折叠成一行 A2A 卡片（collapseA2AFromRole）
   *   - 用户提示词：左侧气泡
   * 其他子 Agent 之间的完整对话不在这里——点中间拓扑图的节点进入该 Agent 自己的对话框查看。
   */
  const visibleEvents = useMemo(
    () =>
      events.filter((ev) => {
        if (ev.kind !== "message") return false; // debate/system 多 Agent 噪声不在此视图
        // 仅收 Orchestrator 自己的工具调用；子 Agent 工具轨迹仍留在中间全量运行区。
        return ev.fromRole === "orchestrator" || ev.fromRole === "user";
      }),
    [events]
  );

  /**
   * 按 plan 段落切对话：
   *   [preface events] → [plan1 时段 events] → [plan2 时段 events] …
   * PlanCard 再插到「触发该 plan 的用户消息」之后（见 splitEventsForPlanPlacement）。
   * 进度更新不新开段，只刷新对应 PlanCard。
   */
  const planTimelineSections = useMemo(() => {
    const sorted = [...visibleEvents].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0
    );
    type Section = {
      key: string;
      plan: OrchestratorPlan | null;
      planStartedAt: string | null;
      segmentIndex: number | null;
      isLatest: boolean;
      events: LiveConversationEvent[];
    };
    if (planSegments.length === 0) {
      return [
        {
          key: "preface",
          plan: plan?.steps?.length ? plan : null,
          planStartedAt: plan?.updatedAt ?? null,
          segmentIndex: plan?.steps?.length ? 0 : null,
          isLatest: true,
          events: sorted,
        } satisfies Section,
      ];
    }
    const sections: Section[] = [];
    const firstStart = planSegments[0]!.startedAt;
    const preface = sorted.filter((e) => e.ts < firstStart);
    if (preface.length > 0) {
      sections.push({
        key: "preface",
        plan: null,
        planStartedAt: null,
        segmentIndex: null,
        isLatest: false,
        events: preface,
      });
    }
    for (let i = 0; i < planSegments.length; i++) {
      const seg = planSegments[i]!;
      const nextStart = planSegments[i + 1]?.startedAt;
      const chunk = sorted.filter(
        (e) => e.ts >= seg.startedAt && (nextStart == null || e.ts < nextStart)
      );
      sections.push({
        key: seg.id,
        plan: seg.plan,
        planStartedAt: seg.startedAt,
        segmentIndex: i,
        isLatest: i === planSegments.length - 1,
        events: chunk,
      });
    }
    return sections;
  }, [visibleEvents, planSegments, plan]);

  // Stick-to-bottom via ResizeObserver (sync with layout) — not a paint-after useEffect
  // on every SSE/reasoning token, which flashes "refresh then jump".
  useLayoutEffect(() => {
    const content = chatContentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      pinChatToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [pinChatToBottom]);

  useLayoutEffect(() => {
    if (chatAutoFollow) pinChatToBottom();
  }, [chatAutoFollow, pinChatToBottom]);

  // User just sent / injected a message → resume follow so their turn is visible.
  const userMessageCount = useMemo(
    () => visibleEvents.filter((ev) => ev.kind === "message" && ev.fromRole === "user").length,
    [visibleEvents]
  );
  const prevUserMessageCountRef = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount > prevUserMessageCountRef.current) {
      prevUserMessageCountRef.current = userMessageCount;
      scrollChatToBottom();
      return;
    }
    prevUserMessageCountRef.current = userMessageCount;
  }, [userMessageCount, scrollChatToBottom]);

  useEffect(() => {
    if (!focusedSubAgent) setFocusedSubAgentRole(null);
  }, [focusedSubAgent]);

  useEffect(() => {
    if (!focusedSubAgent || !subConversationRef.current) return;
    // Keep the expanded panel in view without hijacking when the user is reading above.
    if (!chatAutoFollowRef.current) return;
    subConversationRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedSubAgent]);

  /**
   * 发送语义（对齐 Cursor）：
   *   - 运行中 + 有输入 → 追加对话（onInject）
   *   - 运行中 + 空输入 → 停止（onInterrupt）
   *   - 空闲 + 有输入 → 新 turn（onSend）
   *
   * showActive：本轮在飞 / 专家或工具仍在跑。thinking 文本在 final 后可能残留，
   * 只在 chatInFlight/running 时计入，避免「其实跑完了还显示运行中」。
   */
  const toolsRunning = useMemo(
    () =>
      buildChatExecutionActivity(streamEvents, true).tools.some(
        (tool) => tool.status === "running"
      ),
    [streamEvents]
  );
  const expertsActive = subAgentRuns.some(
    (run) => run.status === "running" || run.status === "queued"
  );
  const liveTurn =
    running || chatInFlight || expertsActive || toolsRunning;
  const thinking = Boolean(thinkingText?.trim()) && (running || chatInFlight);
  const showActive = liveTurn || thinking;
  /** 有实质工作在飞时，发送走追加；否则开新 turn */
  const composerMode: "chat" | "inject" = liveTurn ? "inject" : "chat";
  const selectedAgentMode = getAgentModeOption(agentMode);
  const hasContent = composerValue.trim().length > 0;
  const showStop = showActive && !hasContent && !pendingHitlRequestId;
  const canSend = wfId.length > 0 && hasContent && !injecting && !interrupting;
  const canStop = wfId.length > 0 && showStop && !interrupting;
  // 现已统一走 orchestrator 自主对话；以下 props 保留接口兼容但不再约束发送。
  void completed;
  void sendDisabled;
  void sendDisabledReason;

  const doSend = async () => {
    if (!canSend) return;
    if (composerMode === "inject") {
      const text = composerValue.trim();
      setInjecting(true);
      setInjectHint(null);
      try {
        const queued = await onInject(text);
        onComposerChange("");
        setMemoryMentions([]);
        setInjectHint(
          `已追加到当前对话，将在 Orchestrator 下一轮思考时采纳${queued > 1 ? `（队列 ${queued} 条待消费）` : ""}`
        );
      } catch (e) {
        setInjectHint(`发送失败：${(e as Error).message}`);
      } finally {
        setInjecting(false);
      }
    } else {
      let text = composerValue.trim();
      if (memoryMentions.length > 0) {
        const block = memoryMentions
          .map((m) => `### ${m.title}\n${m.body.trim() || "（空正文）"}`)
          .join("\n\n");
        text = `${text}\n\n---\n[Workspace @记忆]\n${block}`;
      }
      onComposerChange("");
      setMemoryMentions([]);
      setMemoryPickerOpen(false);
      onSend(text);
    }
  };

  const doStop = async () => {
    if (!canStop) return;
    setInterrupting(true);
    setInjectHint(null);
    try {
      await onInterrupt();
      setInjectHint("已停止当前 Agent 运行");
    } catch (e) {
      setInjectHint(`停止失败：${(e as Error).message}`);
    } finally {
      setInterrupting(false);
    }
  };

  const openMemoryPicker = async () => {
    if (!fsWorkspaceId) {
      setInjectHint("请先在左栏选择 FS 工作区，再 @记忆");
      return;
    }
    setMemoryPickerOpen((v) => !v);
    if (memoryPickerOpen) return;
    setMemoryLoading(true);
    try {
      const rows = await listFsWorkspaceMemory(fsWorkspaceId, { limit: 30 });
      setMemoryHits(rows);
    } catch (e) {
      setInjectHint(`加载记忆失败：${(e as Error).message}`);
      setMemoryPickerOpen(false);
    } finally {
      setMemoryLoading(false);
    }
  };

  const toggleMemoryMention = (entry: FsMemoryEntry) => {
    setMemoryMentions((prev) => {
      if (prev.some((m) => m.id === entry.id)) {
        return prev.filter((m) => m.id !== entry.id);
      }
      return [...prev, entry];
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter：有内容则发送/追加；运行中无内容则停止
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (showStop) void doStop();
      else void doSend();
    }
  };

  const composerHint =
    wfId.length === 0
      ? "请先在左侧选择或新建工作流"
      : showStop
        ? "Agent 运行中 —— 点停止结束本轮，或输入内容追加对话"
        : composerMode === "inject"
          ? "运行中追加对话 —— 指令会在下一轮思考时被采纳（Cmd/Ctrl+Enter）"
          : `${selectedAgentMode.hint}（Cmd/Ctrl+Enter 发送）`;

  return (
    <div style={styles.root}>
      {/* Header：标题 + 运行徽标 */}
      <div style={styles.header}>
        <div style={styles.titleRow}>
          <span style={styles.title}>Orchestrator</span>
          {showActive ? (
            <span style={styles.runningBadge}>● 运行中</span>
          ) : pendingHitlRequestId ? (
            <span style={styles.hitlBadge}>⏸ 待确认</span>
          ) : (
            <span style={styles.idleBadge}>○ 空闲</span>
          )}
        </div>
        <div style={styles.scopeRow}>
          <span style={styles.scopeHint}>
            显示 Orchestrator 对你的输出、工具调用，以及已派发专家的实时进度。点击专家可跳转到独立子对话查看完整轨迹。
          </span>
        </div>
      </div>

      {/* 状态轨：运行态 / 工具 / A2A（Plan 已内联到对话任务段落）；可固定顶端或随正文滚走 */}
      {statusRailPinned ? (
        <div style={styles.statusRail} data-qb-orch-status-rail="pinned">
          <StatusRailToolbar pinned onToggle={toggleStatusRailPinned} />
          <StatusRailContent
            running={running}
            chatInFlight={chatInFlight}
            pendingHitlRequestId={pendingHitlRequestId}
            activity={activity}
            streamEvents={streamEvents}
            subAgentRuns={subAgentRuns}
            thinkingText={thinkingText}
            showActive={showActive}
            focusedSubAgentRole={focusedSubAgentRole}
            onSelectRun={(run) => setFocusedSubAgentRole(run.role)}
          />
        </div>
      ) : null}

      {/* Body：对话流（工具/A2A 穿插）— stick-to-bottom，上翻不强制置底 */}
      <div style={styles.bodyShell}>
        <div
          ref={scrollRef}
          style={styles.body}
          data-qb-orchestrator-chat
          onScroll={handleChatScroll}
        >
        <div ref={chatContentRef} style={styles.bodyContent}>
        {!statusRailPinned ? (
          <div style={styles.statusRailInScroll} data-qb-orch-status-rail="scroll">
            <StatusRailToolbar pinned={false} onToggle={toggleStatusRailPinned} />
            <StatusRailContent
              running={running}
              chatInFlight={chatInFlight}
              pendingHitlRequestId={pendingHitlRequestId}
              activity={activity}
              streamEvents={streamEvents}
              subAgentRuns={subAgentRuns}
              thinkingText={thinkingText}
              showActive={showActive}
              focusedSubAgentRole={focusedSubAgentRole}
              onSelectRun={(run) => setFocusedSubAgentRole(run.role)}
            />
          </div>
        ) : null}
        {focusedSubAgent ? (
          <section ref={subConversationRef} style={styles.subConversation} aria-label="专家子对话上下文">
            <div style={styles.subConversationHeader}>
              <div style={{ minWidth: 0 }}>
                <div style={styles.subConversationTitle}>专家子对话 · {focusedSubAgent.role}</div>
                <div style={styles.subConversationMeta}>
                  可向下滚动查看该专家的派单、推理、工具调用与回传；主对话不会被覆盖。
                </div>
              </div>
              <button
                type="button"
                style={styles.closeSubConversation}
                onClick={() => setFocusedSubAgentRole(null)}
              >
                返回主对话
              </button>
            </div>
            <div style={styles.subConversationBody}>
              <AgentRunPanel
                data={{
                  role: focusedSubAgent.role,
                  inbound: focusedSubAgent.inbound,
                  outbound: focusedSubAgent.outbound,
                  steps: focusedSubAgent.steps,
                  tools: focusedSubAgent.tools,
                  mcps: focusedSubAgent.mcps,
                }}
                defaultMode="chat"
              />
            </div>
          </section>
        ) : null}
        {artifacts.length > 0 || artifactsLoading || artifactsError ? (
          <div style={styles.artifactBox}>
            <button
              type="button"
              style={styles.artifactHeader}
              onClick={() => setArtifactsOpen((v) => !v)}
              aria-expanded={artifactsOpen}
            >
              <span aria-hidden style={{ fontSize: 10 }}>
                {artifactsOpen ? "▾" : "▸"}
              </span>
              📦 本轮产物（{artifacts.length}）
              <span style={styles.artifactHint}>汇总 · 卡片已按产出位置插入对话</span>
            </button>
            {artifactsOpen ? (
              <div style={styles.artifactList}>
                {artifactsLoading ? (
                  <div role="status" style={styles.artifactState}>正在同步本轮产物…</div>
                ) : null}
                {artifactsError ? (
                  <div role="alert" style={{ ...styles.artifactState, color: "var(--qb-warning, #f59e0b)" }}>
                    {artifactsError}
                  </div>
                ) : null}
                {artifacts.map((a) => (
                  <button
                    key={`${a.kind}:${a.id}`}
                    type="button"
                    style={styles.artifactCard}
                    title={`打开${a.kind === "factor" ? "因子" : a.kind === "strategy" ? "策略" : a.kind === "backtest" ? "回测" : "脚本"}：${a.title}`}
                    onClick={() => onOpenArtifact(a)}
                  >
                    <span style={styles.artifactKind}>
                      {a.kind === "factor" ? "因子" : a.kind === "strategy" ? "策略" : a.kind === "backtest" ? "回测" : "脚本"}
                    </span>
                    <span style={styles.artifactTitle}>{a.title}</span>
                    {a.subtitle ? <span style={styles.artifactSub}>{a.subtitle}</span> : null}
                    <span style={styles.artifactOpen}>打开 ↗</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {planTimelineSections.map((section, sectionIdx) => {
          const showEmpty =
            sectionIdx === 0 &&
            planTimelineSections.every((s) => s.events.length === 0) &&
            !section.plan;
          const { leading, trailing } = section.plan
            ? splitEventsForPlanPlacement(section.events, section.planStartedAt)
            : { leading: section.events, trailing: [] as typeof section.events };
          const planCard = section.plan ? (
            <PlanCard
              plan={section.plan}
              segmentLabel={
                section.segmentIndex != null
                  ? `任务 ${section.segmentIndex + 1}`
                  : undefined
              }
              defaultOpen={section.isLatest}
              onExecute={section.isLatest ? onExecutePlan : undefined}
              onGoalAction={section.isLatest ? onGoalAction : undefined}
              executeDisabled={
                !section.isLatest || running || chatInFlight || expertsActive
              }
            />
          ) : null;
          const renderConv = (
            events: typeof section.events,
            opts?: { empty?: boolean; withArtifacts?: boolean }
          ) =>
            events.length > 0 || opts?.empty ? (
              <LiveConversationView
                events={events}
                selfRole="orchestrator"
                contentMaxLength={12000}
                collapseA2AFromRole="orchestrator"
                collapseToolCalls
                layout="stream"
                artifacts={opts?.withArtifacts ? artifacts : []}
                onOpenArtifact={onOpenArtifact}
                onOpenRef={(ref) => {
                  const kind =
                    ref.kind === "factor"
                      ? "factor"
                      : ref.kind === "strategy_version"
                        ? "strategy"
                        : null;
                  if (kind) {
                    onOpenArtifact({
                      id: ref.id,
                      kind,
                      title: ref.id,
                      workflowRunId,
                    });
                  }
                }}
                emptyText={
                  opts?.empty
                    ? !wfId
                      ? "请先在左侧选择或新建工作流，再与 Orchestrator 对话。"
                      : running
                        ? "Orchestrator 已启动，正在规划与按需派发专家…"
                        : "输入研究指令并发送。Orchestrator 会直接回答，或按需召唤专家；派发后可在上方「专家进度」查看运行状态。"
                    : undefined
                }
              />
            ) : null;
          return (
            <div
              key={section.key}
              style={styles.planSection}
              data-qb-plan-section={section.key}
            >
              {sectionIdx > 0 ? (
                <div style={styles.planSectionDivider} role="separator">
                  新任务段落
                </div>
              ) : null}
              {section.plan
                ? (
                    <>
                      {renderConv(leading)}
                      {planCard}
                      {renderConv(trailing, {
                        empty: showEmpty && leading.length === 0 && trailing.length === 0,
                        withArtifacts: section.isLatest,
                      })}
                    </>
                  )
                : renderConv(section.events, {
                    empty: showEmpty,
                    withArtifacts: section.isLatest,
                  })}
            </div>
          );
        })}
        <ThinkingGhostBox reasoning={liveReasoning} />
        </div>
        </div>
        {!chatAtBottom ? (
          <button
            type="button"
            onClick={scrollChatToBottom}
            title="跳到最新消息并恢复自动跟随"
            style={styles.jumpLatestBtn}
          >
            <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>
              ↓
            </span>
            跳到最新{chatAutoFollow ? "" : "（已暂停跟随）"}
          </button>
        ) : null}
      </div>

      {/* Footer：Resume 提醒 + HITL 在输入框与模式选择之上 */}
      <div style={styles.footer}>
        {wfId ? (
          <WorkflowResumeBanner
            workflowRunId={wfId}
            chatInFlight={Boolean(chatInFlight)}
            workflowStatus={workflowStatus}
            onResumed={onWorkflowResumed}
          />
        ) : null}
        {wfId ? (
          <TeamHitlBanner
            workflowRunId={wfId}
            triggerKey={pendingHitlRequestId ?? wfId}
            onResolved={onHitlResolved}
          />
        ) : null}
        {showActive && runProgress ? <div style={styles.progress}>{runProgress}</div> : null}
        {showActive && !runProgress ? (
          <div style={styles.progress}>
            {thinking
              ? "思考输出中…"
              : toolsRunning
                ? "工具调用进行中…"
                : expertsActive
                  ? "专家 Agent 运行中…"
                  : "Orchestrator 仍在运行…"}
          </div>
        ) : null}
        {errorMessage ? (
          <div style={styles.error} role="alert">
            <span style={{ flex: 1, minWidth: 0 }}>{errorMessage}</span>
            {onErrorDismiss ? (
              <button
                type="button"
                style={styles.errorDismiss}
                onClick={onErrorDismiss}
                aria-label="关闭错误提示"
              >
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        {injectHint ? <div style={styles.injectHint}>{injectHint}</div> : null}
        {memoryMentions.length > 0 ? (
          <div style={styles.memoryChips} data-qb-orch-memory-chips>
            {memoryMentions.map((m) => (
              <button
                key={m.id}
                type="button"
                style={styles.memoryChip}
                title="再次点击移除"
                onClick={() => toggleMemoryMention(m)}
              >
                @记忆 · {m.title}
              </button>
            ))}
          </div>
        ) : null}
        {memoryPickerOpen ? (
          <div style={styles.memoryPicker} data-qb-orch-memory-picker>
            <div style={styles.memoryPickerHead}>
              <span>选择要引用的长期记忆</span>
              <button type="button" style={styles.runStripLink} onClick={() => setMemoryPickerOpen(false)}>
                关闭
              </button>
            </div>
            {memoryLoading ? (
              <div style={styles.composerHint}>加载中…</div>
            ) : memoryHits.length === 0 ? (
              <div style={styles.composerHint}>当前工作区暂无记忆条目</div>
            ) : (
              memoryHits.map((m) => {
                const selected = memoryMentions.some((x) => x.id === m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    style={{
                      ...styles.memoryPickItem,
                      ...(selected ? styles.memoryPickItemActive : null),
                    }}
                    onClick={() => toggleMemoryMention(m)}
                  >
                    {selected ? "✓ " : ""}
                    {m.pinned ? "📌 " : ""}
                    {m.title}
                  </button>
                );
              })
            )}
          </div>
        ) : null}
        <textarea
          style={styles.composer}
          value={composerValue}
          onChange={(e) => onComposerChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={
            composerMode === "inject"
              ? "给运行中的 Orchestrator 追加指令，例如：把重点放到现金流质量上…"
              : "和 Orchestrator 对话，例如：总结一下结论 / 重做一次技术面；可用 @记忆 引用课题沉淀…"
          }
        />
        <div style={styles.composerBar}>
          <div style={styles.composerMeta}>
            <button
              type="button"
              style={{
                ...styles.memoryAtBtn,
                ...(!fsWorkspaceId ? styles.modeBtnDisabled : null),
              }}
              disabled={!fsWorkspaceId}
              title={fsWorkspaceId ? "引用当前工作区长期记忆" : "先选择 FS 工作区"}
              onClick={() => void openMemoryPicker()}
            >
              @记忆
            </button>
            <AgentModePicker
              value={agentMode}
              onChange={onAgentModeChange}
              disabled={showActive}
            />
            <label style={styles.hitlSelectLabel} title="选择本次对话的人工确认策略">
              <span>HITL</span>
              <select
                value={hitlMode}
                disabled={showActive}
                onChange={(event) => onHitlModeChange(event.target.value as OrchestratorHitlMode)}
                style={{ ...styles.hitlSelect, ...(showActive ? styles.modeBtnDisabled : null) }}
              >
                {MODE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <span style={styles.composerHint}>{composerHint}</span>
          </div>
          {showStop ? (
            <button
              type="button"
              className="qb-btn-primary-brand"
              style={{
                ...styles.sendBtn,
                ...styles.stopBtn,
                ...(canStop ? null : styles.sendBtnDisabled),
              }}
              disabled={!canStop}
              title="停止当前 Agent 运行"
              onClick={() => void doStop()}
            >
              {interrupting ? "停止中…" : "停止"}
            </button>
          ) : (
            <button
              type="button"
              className="qb-btn-primary-brand"
              style={{ ...styles.sendBtn, ...(canSend ? null : styles.sendBtnDisabled) }}
              disabled={!canSend}
              title={
                canSend
                  ? composerMode === "inject"
                    ? "追加到当前对话"
                    : `使用 ${selectedAgentMode.label} 模式发送给 Orchestrator`
                  : "请输入内容"
              }
              onClick={() => void doSend()}
            >
              {injecting
                ? "发送中…"
                : composerMode === "inject"
                  ? "追加"
                  : "发送"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusRailToolbar({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={styles.statusRailToolbar}>
      <span style={styles.statusRailTitle}>运行状态 · Plan / 工具 / A2A</span>
      <button
        type="button"
        style={styles.statusRailPinBtn}
        onClick={onToggle}
        title={pinned ? "取消固定，随正文滚动" : "固定在顶部，始终可见"}
        aria-pressed={pinned}
      >
        {pinned ? "已固定" : "可滚走"}
      </button>
    </div>
  );
}

function StatusRailContent({
  running,
  chatInFlight,
  pendingHitlRequestId,
  activity,
  streamEvents,
  subAgentRuns,
  thinkingText,
  showActive,
  focusedSubAgentRole,
  onSelectRun,
}: {
  running: boolean;
  chatInFlight: boolean;
  pendingHitlRequestId: string | null;
  activity?: { tool: string; why: string } | null;
  streamEvents: StepStreamEvent[];
  subAgentRuns: SubAgentRunSummary[];
  thinkingText?: string | null;
  showActive: boolean;
  focusedSubAgentRole: string | null;
  onSelectRun: (run: SubAgentRunSummary) => void;
}) {
  return (
    <>
      <OrchestratorLiveStatus
        running={running}
        chatInFlight={chatInFlight}
        pendingHitl={Boolean(pendingHitlRequestId)}
        activity={activity}
        streamEvents={streamEvents}
        subAgentRuns={subAgentRuns}
        thinkingText={thinkingText}
      />
      {streamEvents.length > 0 || showActive ? (
        <div style={styles.executionWrap}>
          <ChatExecutionActivity events={streamEvents} running={showActive} />
        </div>
      ) : null}
      <SubAgentRunsPanel
        runs={subAgentRuns}
        selectedRole={focusedSubAgentRole}
        onSelectRun={onSelectRun}
      />
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    height: "100%",
    minHeight: 0,
    gap: 0,
  },
  header: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    paddingBottom: 10,
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d32)",
  },
  runStripLink: {
    border: "none",
    background: "transparent",
    color: "#38bdf8",
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
  },
  titleRow: { display: "flex", alignItems: "center", gap: 8 },
  title: { fontSize: 14, fontWeight: 600, color: "#e4e4e7", letterSpacing: 0.3 },
  runningBadge: {
    fontSize: 10,
    padding: "1px 7px",
    borderRadius: 999,
    border: "1px solid rgba(56,189,248,0.45)",
    background: "rgba(56,189,248,0.12)",
    color: "#7dd3fc",
    fontWeight: 600,
  },
  hitlBadge: {
    fontSize: 10,
    padding: "1px 7px",
    borderRadius: 999,
    border: "1px solid #b45309",
    background: "rgba(180,83,9,0.18)",
    color: "#fbbf24",
    fontWeight: 600,
  },
  idleBadge: {
    fontSize: 10,
    padding: "1px 7px",
    borderRadius: 999,
    border: "1px solid #3f3f46",
    color: "#71717a",
    fontWeight: 600,
  },
  interruptBtn: {
    marginLeft: "auto",
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid #b45309",
    background: "rgba(180,83,9,0.18)",
    color: "#fbbf24",
    borderRadius: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  scopeRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  scopeBtn: {
    padding: "2px 8px",
    fontSize: 10.5,
    border: "1px solid #3f3f46",
    background: "transparent",
    color: "#a1a1aa",
    borderRadius: 10,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  scopeBtnActive: {
    borderColor: "rgba(96,165,250,0.5)",
    background: "rgba(96,165,250,0.16)",
    color: "#93c5fd",
    fontWeight: 600,
  },
  scopeHint: { fontSize: 10, color: "#71717a", flex: 1, minWidth: 0 },
  modeBtnDisabled: { cursor: "not-allowed", opacity: 0.6 },
  statusRail: {
    flexShrink: 0,
    maxHeight: "42%",
    overflowY: "auto",
    overflowX: "hidden",
    padding: "8px 2px 6px",
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d32)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  statusRailInScroll: {
    marginBottom: 10,
    paddingBottom: 8,
    borderBottom: "1px dashed rgba(63,63,70,0.7)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  statusRailToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 2,
  },
  statusRailTitle: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#71717a",
  },
  statusRailPinBtn: {
    padding: "2px 8px",
    fontSize: 10,
    fontWeight: 600,
    border: "1px solid #3f3f46",
    background: "rgba(39,39,42,0.6)",
    color: "#a1a1aa",
    borderRadius: 999,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  bodyShell: {
    position: "relative",
    flex: "1 1 0",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  body: {
    flex: "1 1 0",
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "10px 2px 12px",
    // Prevent browser scroll-anchoring from fighting stick-to-bottom pinning.
    overflowAnchor: "none",
  },
  bodyContent: {
    minHeight: "min-content",
  },
  planSection: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    minWidth: 0,
  },
  planSectionDivider: {
    margin: "14px 0 10px",
    padding: "4px 0",
    borderTop: "1px dashed rgba(167,139,250,0.35)",
    color: "#a78bfa",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textAlign: "center",
  },
  jumpLatestBtn: {
    position: "absolute",
    right: 14,
    bottom: 12,
    zIndex: 5,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "5px 11px",
    borderRadius: 999,
    border: "1px solid rgba(59,130,246,0.55)",
    background: "rgba(15,23,42,0.88)",
    color: "#bfdbfe",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
    backdropFilter: "blur(4px)",
    fontFamily: "inherit",
  },
  footer: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    paddingTop: 10,
    borderTop: "1px solid var(--qb-team-shell-border, #2d2d32)",
  },
  progress: {
    fontSize: 11,
    color: "#38bdf8",
    background: "#0f1f2e",
    border: "1px solid #1e3a52",
    borderRadius: 6,
    padding: "5px 8px",
  },
  error: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 11,
    lineHeight: 1.45,
    color: "#fecaca",
    background: "rgba(127,29,29,0.28)",
    border: "1px solid rgba(248,113,113,0.45)",
    borderRadius: 6,
    padding: "6px 8px",
  },
  errorDismiss: {
    flexShrink: 0,
    border: 0,
    background: "transparent",
    color: "#fca5a5",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    padding: 0,
  },
  composer: {
    width: "100%",
    resize: "vertical",
    minHeight: 56,
    maxHeight: 200,
    padding: "8px 10px",
    background: "var(--qb-team-canvas-bg, #0c0c0e)",
    color: "#e4e4e7",
    border: "1px solid #3f3f46",
    borderRadius: 8,
    fontSize: 12,
    lineHeight: 1.5,
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  artifactBox: {
    marginBottom: 10,
    border: "1px solid rgba(96,165,250,0.35)",
    borderRadius: 8,
    background: "rgba(96,165,250,0.06)",
    overflow: "hidden",
  },
  artifactHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    color: "#93c5fd",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
  },
  artifactHint: {
    marginLeft: "auto",
    fontSize: 10,
    fontWeight: 500,
    color: "#71717a",
  },
  artifactList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "0 8px 8px",
  },
  artifactState: {
    padding: "7px 9px",
    border: "1px dashed var(--qb-border-subtle)",
    borderRadius: 6,
    color: "var(--qb-text-muted)",
    fontSize: 11,
    lineHeight: 1.45,
  },
  artifactCard: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    background: "var(--qb-team-canvas-bg, #0c0c0e)",
    border: "1px solid #27272a",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
    width: "100%",
  },
  artifactKind: {
    flexShrink: 0,
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 4,
    border: "1px solid rgba(96,165,250,0.5)",
    color: "#93c5fd",
  },
  artifactTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: "#e4e4e7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  artifactSub: { flexShrink: 0, fontSize: 10, color: "#71717a" },
  artifactOpen: { flexShrink: 0, fontSize: 10, color: "#60a5fa" },
  injectHint: {
    fontSize: 11,
    color: "#86efac",
    background: "rgba(34,197,94,0.10)",
    border: "1px solid rgba(34,197,94,0.35)",
    borderRadius: 6,
    padding: "5px 8px",
  },
  activityLine: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    marginBottom: 10,
    padding: "5px 9px",
    borderRadius: 6,
    border: "1px solid rgba(56,189,248,0.28)",
    background: "rgba(56,189,248,0.08)",
    fontSize: 11.5,
    color: "#bae6fd",
    lineHeight: 1.45,
  },
  activitySpinner: { color: "#38bdf8", animation: "qbPulse 1.1s ease-in-out infinite" },
  activityText: { minWidth: 0, color: "#cbd5e1" },
  executionWrap: {
    marginBottom: 8,
  },
  subConversation: {
    marginBottom: 10,
    border: "1px solid rgba(139,92,246,0.5)",
    borderRadius: 10,
    overflow: "hidden",
    background: "rgba(30,27,55,0.34)",
  },
  subConversationHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
    padding: "9px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  subConversationTitle: { fontSize: 12, fontWeight: 650, color: "#e9d5ff" },
  subConversationMeta: { marginTop: 3, fontSize: 10.5, lineHeight: 1.4, color: "#a78bfa" },
  closeSubConversation: {
    flexShrink: 0,
    padding: "4px 7px",
    border: "1px solid rgba(167,139,250,0.5)",
    borderRadius: 6,
    color: "#ddd6fe",
    background: "rgba(139,92,246,0.15)",
    cursor: "pointer",
    fontSize: 10.5,
    fontFamily: "inherit",
  },
  subConversationBody: { height: 500, minHeight: 300 },
  memoryChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 6,
  },
  memoryChip: {
    border: "1px solid rgba(56,189,248,0.35)",
    background: "rgba(56,189,248,0.12)",
    color: "#7dd3fc",
    borderRadius: 999,
    fontSize: 11,
    padding: "3px 8px",
    cursor: "pointer",
  },
  memoryPicker: {
    marginBottom: 8,
    padding: 8,
    borderRadius: 8,
    border: "1px solid #3f3f46",
    background: "#121216",
    maxHeight: 160,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  memoryPickerHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: 11,
    color: "#a1a1aa",
    marginBottom: 4,
  },
  memoryPickItem: {
    textAlign: "left",
    border: "none",
    background: "transparent",
    color: "#d4d4d8",
    fontSize: 12,
    padding: "4px 6px",
    borderRadius: 4,
    cursor: "pointer",
  },
  memoryPickItemActive: {
    background: "rgba(56,189,248,0.15)",
    color: "#7dd3fc",
  },
  memoryAtBtn: {
    flexShrink: 0,
    border: "1px solid #3f3f46",
    background: "#27272a",
    color: "#e4e4e7",
    borderRadius: 6,
    fontSize: 11,
    padding: "4px 8px",
    cursor: "pointer",
  },
  composerBar: { display: "flex", alignItems: "center", gap: 8 },
  composerMeta: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  composerHint: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 10.5,
    color: "#71717a",
    lineHeight: 1.4,
  },
  hitlSelectLabel: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    color: "#a1a1aa",
    fontSize: 10.5,
  },
  hitlSelect: {
    maxWidth: 106,
    padding: "3px 20px 3px 6px",
    border: "1px solid #3f3f46",
    borderRadius: 6,
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 10.5,
    fontFamily: "inherit",
  },
  sendBtn: { flexShrink: 0, fontSize: 12, padding: "6px 16px" },
  stopBtn: {
    background: "var(--qb-danger, #b91c1c)",
    borderColor: "var(--qb-danger, #b91c1c)",
  },
  sendBtnDisabled: { opacity: 0.5, cursor: "not-allowed" },
};
