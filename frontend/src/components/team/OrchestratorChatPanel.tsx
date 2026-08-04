/**
 * Orchestrator 主对话面板（右栏 · Agent IDE 形态）
 *
 * 设计目标（见对话记录 · 2026-06）：把"和 Orchestrator 对话"做成 coding-agent 风格的
 * 右侧常驻面板，而不是把人工介入埋在画布下方的橙色 banner 里。
 *
 *   顶部 Header：标题 + 运行徽标 + 自主/HITL 模式切换（完全自主 ⇄ 人工介入）
 *   中部 Body  ：内联 HITL 卡片（复用 TeamHitlBanner）+ 以 Orchestrator 为主视角的对话流
 *   底部 Footer：输入框 composer —— 空闲时把指令喂给 Orchestrator 并启动/继续研究
 *
 * 本组件刻意保持"展示 + 受控回调"，真正的运行/HITL 业务逻辑仍在 MainContent：
 *   - onSend(text)：把 text 作为分析提示（context）并启动团队分析（idle 时）
 *   - HITL 应答走 TeamHitlBanner 自包含链路（listPendingWorkflowHitl / resolveWorkflowHitl）
 *
 * 后端尚不支持"向运行中的 Orchestrator 随时注入消息"——运行中且无 pending HITL 时，
 * composer 会被禁用并提示"将在 Orchestrator 暂停征询时回复"。这是已知边界，待后端
 * 消息注入能力落地后再放开（见任务单）。
 */
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AgentControlMode, type StepStreamEvent } from "../../api/types";
import { AgentModePicker, getAgentModeOption } from "../chat/AgentModePicker";
import { ChatExecutionActivity } from "../chat/ChatExecutionActivity";
import type { SubAgentRunSummary } from "../../lib/subAgentRuns";
import { type LiveConversationEvent, LiveConversationView } from "./LiveConversationView";
import { OrchestratorLiveStatus } from "./OrchestratorLiveStatus";
import { SubAgentRunsPanel } from "./SubAgentRunsPanel";
import { AgentRunPanel } from "./AgentRunChatView";
import { TeamHitlBanner } from "./TeamHitlBanner";
import { type OrchestratorPlan, PlanCard } from "./PlanCard";
import { buildChatExecutionActivity } from "../chat/ChatExecutionActivity";

export type OrchestratorHitlMode = "off" | "ai" | "always";

/** 内联产物卡片（Orchestrator 对话框里直接展示已生成的因子/策略/脚本，点击可打开）。 */
export interface OrchestratorArtifact {
  id: string;
  kind: "factor" | "strategy" | "script";
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
  /** composer 文本（受控；与左栏「分析提示」共享同一 state） */
  composerValue: string;
  onComposerChange: (value: string) => void;
  /** 空闲时发送：把 composerValue 作为指令启动团队分析 */
  onSend: () => void;
  /** 运行中发送：把 composerValue 注入运行中的 Orchestrator，返回队列剩余条数 */
  onInject: (content: string) => Promise<number>;
  /** 协作式中断：请求在下一个安全断点暂停，等用户输入新提示词后续跑 */
  onInterrupt: () => Promise<void>;
  /** Agent / Plan / Goal：Orchestrator 的分步计划（update_plan 推流），置于对话框顶部 */
  plan?: OrchestratorPlan | null;
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
  /** 可折叠 Run 条：工作流切换 / 新建 / 研究设置主体 */
  runStrip?: {
    expanded: boolean;
    onExpandedChange: (open: boolean) => void;
    summary: string;
    options: Array<{ id: string; label: string; status?: string }>;
    onSelect: (id: string) => void;
    onCreate: () => void;
    /** @deprecated 设置已嵌在 Run 条；保留跳转左栏工作流列表 */
    onOpenResearchSettings?: () => void;
    creating?: boolean;
    /** 已点「新建」待二次确认 */
    createConfirmPending?: boolean;
    onCancelCreate?: () => void;
    /** 研究设置表单（展开后显示） */
    settingsContent?: ReactNode;
  };
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
  completed,
  composerValue,
  onComposerChange,
  onSend,
  onInject,
  onInterrupt,
  plan,
  onExecutePlan,
  onGoalAction,
  activity,
  streamEvents = [],
  thinkingText = null,
  subAgentRuns = [],
  artifacts,  artifactsLoading = false,
  artifactsError = null,
  onOpenArtifact,
  sendDisabled,
  sendDisabledReason,
  runStrip,
}: OrchestratorChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [injectHint, setInjectHint] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [focusedSubAgentRole, setFocusedSubAgentRole] = useState<string | null>(null);
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

  // 新消息进来时自动滚到底（右栏主对话框默认始终跟随最新）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, runProgress, subAgentRuns.length, streamEvents.length, thinkingText, activity]);

  useEffect(() => {
    if (!focusedSubAgent) setFocusedSubAgentRole(null);
  }, [focusedSubAgent]);

  useEffect(() => {
    if (!focusedSubAgent || !subConversationRef.current) return;
    subConversationRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusedSubAgent]);

  /**
   * 发送语义：
   *   - 运行中：发送 = 把文本「注入」运行中的 Orchestrator（onInject，下一轮 reason 生效）
   *   - 其余（空闲/已完成）：发送 = 交给 Orchestrator **自主判断**（onSend → orchestrator-chat：
   *     直接答 / assign_task 派单 / run_analyst_team 全队）。是对话，不需要研究范围，
   *     故不受 sendDisabled 约束。「启动团队分析」按钮才是直接全队。
   *
   * showActive 不能只看 running/chatInFlight：final 后专家/工具仍可能在飞，
   * 仍应显示 ● 运行中（Cursor/Codex 风格）。
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
  const thinking = Boolean(thinkingText?.trim());
  const showActive =
    running || chatInFlight || expertsActive || toolsRunning || thinking;
  const composerMode: "chat" | "inject" = running || expertsActive ? "inject" : "chat";
  const selectedAgentMode = getAgentModeOption(agentMode);
  const hasContent = composerValue.trim().length > 0;
  const canSend = wfId.length > 0 && hasContent && !injecting;
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
        setInjectHint(
          `已发送给 Orchestrator，将在它下一轮思考时采纳${queued > 1 ? `（队列 ${queued} 条待消费）` : ""}`
        );
      } catch (e) {
        setInjectHint(`发送失败：${(e as Error).message}`);
      } finally {
        setInjecting(false);
      }
    } else {
      onSend();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter 发送，回车换行（coding-agent 习惯）
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void doSend();
    }
  };

  const composerHint =
    wfId.length === 0
      ? "请先在左侧选择或新建工作流"
      : composerMode === "inject"
        ? "Orchestrator 运行中 —— 发送的指令会在它下一轮思考时被采纳（Cmd/Ctrl+Enter）"
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
          {running && !pendingHitlRequestId ? (
            <button
              type="button"
              disabled={interrupting}
              title="在下一个安全断点暂停，等你输入新提示词后继续"
              onClick={async () => {
                setInterrupting(true);
                setInjectHint(null);
                try {
                  await onInterrupt();
                  setInjectHint("已请求中断，将在下一个断点暂停并等你输入新提示词…");
                } catch (e) {
                  setInjectHint(`中断请求失败：${(e as Error).message}`);
                } finally {
                  setInterrupting(false);
                }
              }}
              style={{
                ...styles.interruptBtn,
                ...(interrupting ? styles.modeBtnDisabled : null),
              }}
            >
              {interrupting ? "中断中…" : "⏸ 中断"}
            </button>
          ) : null}
        </div>
        <div style={styles.scopeRow}>
          <span style={styles.scopeHint}>
            显示 Orchestrator 对你的输出、工具调用，以及已派发专家的实时进度。点击专家可跳转到独立子对话查看完整轨迹。
          </span>
        </div>
      </div>

      {runStrip ? (
        <div style={styles.runStrip} data-qb-orch-run-strip>
          <button
            type="button"
            style={styles.runStripToggle}
            onClick={() => runStrip.onExpandedChange(!runStrip.expanded)}
            aria-expanded={runStrip.expanded}
          >
            <span style={styles.runStripTitle}>
              {runStrip.expanded ? "▾" : "▸"} Run · {wfId ? wfId.slice(0, 8) : "未选择"}
            </span>
            <span style={styles.runStripSummary}>{runStrip.summary}</span>
          </button>
          {runStrip.expanded ? (
            <div style={styles.runStripBody}>
              <label style={styles.runStripLabel}>
                当前工作流
                <select
                  style={styles.runStripSelect}
                  value={wfId}
                  onChange={(e) => runStrip.onSelect(e.target.value)}
                >
                  <option value="">选择工作流…</option>
                  {runStrip.options.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                      {opt.status ? ` · ${opt.status}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div style={styles.runStripActions}>
                {runStrip.createConfirmPending ? (
                  <>
                    <button
                      type="button"
                      className="qb-btn-primary-brand"
                      style={styles.runStripBtn}
                      disabled={runStrip.creating}
                      onClick={() => runStrip.onCreate()}
                    >
                      {runStrip.creating ? "创建中…" : "确认新建工作流"}
                    </button>
                    <button
                      type="button"
                      style={styles.runStripLink}
                      disabled={runStrip.creating}
                      onClick={() => runStrip.onCancelCreate?.()}
                    >
                      取消
                    </button>
                    <span style={styles.runStripConfirmHint}>
                      新建 = 新研究回合
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="qb-btn-primary-brand"
                    style={styles.runStripBtn}
                    disabled={runStrip.creating}
                    onClick={() => runStrip.onCreate()}
                  >
                    {runStrip.creating ? "创建中…" : "新建工作流"}
                  </button>
                )}
                {runStrip.onOpenResearchSettings ? (
                  <button
                    type="button"
                    style={styles.runStripLink}
                    onClick={() => runStrip.onOpenResearchSettings?.()}
                  >
                    工作流列表（左栏）
                  </button>
                ) : null}
              </div>
              {runStrip.settingsContent ? (
                <div style={styles.runStripSettings}>{runStrip.settingsContent}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 状态轨：Plan / 运行态 / 工具 / A2A 专家进度；可固定顶端或随正文滚走 */}
      {statusRailPinned ? (
        <div style={styles.statusRail} data-qb-orch-status-rail="pinned">
          <StatusRailToolbar pinned onToggle={toggleStatusRailPinned} />
          <StatusRailContent
            plan={plan ?? null}
            onExecutePlan={onExecutePlan}
            onGoalAction={onGoalAction}
            executeDisabled={running || chatInFlight || expertsActive}
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

      {/* Body：对话流（工具/A2A 穿插） */}
      <div ref={scrollRef} style={styles.body} data-qb-orchestrator-chat>
        {!statusRailPinned ? (
          <div style={styles.statusRailInScroll} data-qb-orch-status-rail="scroll">
            <StatusRailToolbar pinned={false} onToggle={toggleStatusRailPinned} />
            <StatusRailContent
              plan={plan ?? null}
              onExecutePlan={onExecutePlan}
              onGoalAction={onGoalAction}
              executeDisabled={running || chatInFlight || expertsActive}
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
                    title={`打开${a.kind === "factor" ? "因子" : a.kind === "strategy" ? "策略" : "脚本"}：${a.title}`}
                    onClick={() => onOpenArtifact(a)}
                  >
                    <span style={styles.artifactKind}>
                      {a.kind === "factor" ? "因子" : a.kind === "strategy" ? "策略" : "脚本"}
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
        <LiveConversationView
          events={visibleEvents}
          selfRole="orchestrator"
          contentMaxLength={12000}
          collapseA2AFromRole="orchestrator"
          collapseToolCalls
          layout="stream"
          artifacts={artifacts}
          onOpenArtifact={onOpenArtifact}
          onOpenRef={(ref) => {
            // 交接信封里的产物引用 → 复用产物打开逻辑（factor / strategy_version）。
            const kind =
              ref.kind === "factor" ? "factor" : ref.kind === "strategy_version" ? "strategy" : null;
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
            !wfId
              ? "请先在左侧选择或新建工作流，再与 Orchestrator 对话。"
              : running
                ? "Orchestrator 已启动，正在规划与按需派发专家…"
                : "输入研究指令并发送。Orchestrator 会直接回答，或按需召唤专家；派发后可在上方「专家进度」查看运行状态。"
          }
        />
      </div>

      {/* Footer：HITL 在输入框与模式选择之上 */}
      <div style={styles.footer}>
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
        <textarea
          style={styles.composer}
          value={composerValue}
          onChange={(e) => onComposerChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={
            composerMode === "inject"
              ? "给运行中的 Orchestrator 追加指令，例如：把重点放到现金流质量上…"
              : "和 Orchestrator 对话，例如：总结一下结论 / 重做一次技术面 / 对当前标的做深度尽调…"
          }
        />
        <div style={styles.composerBar}>
          <div style={styles.composerMeta}>
            <AgentModePicker
              value={agentMode}
              onChange={onAgentModeChange}
              disabled={running}
            />
            <label style={styles.hitlSelectLabel} title="选择本次对话的人工确认策略">
              <span>HITL</span>
              <select
                value={hitlMode}
                disabled={running}
                onChange={(event) => onHitlModeChange(event.target.value as OrchestratorHitlMode)}
                style={{ ...styles.hitlSelect, ...(running ? styles.modeBtnDisabled : null) }}
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
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={{ ...styles.sendBtn, ...(canSend ? null : styles.sendBtnDisabled) }}
            disabled={!canSend}
            title={
              canSend
                ? composerMode === "inject"
                  ? "发送给运行中的 Orchestrator"
                  : `使用 ${selectedAgentMode.label} 模式发送给 Orchestrator`
                : "请输入内容"
            }
            onClick={() => void doSend()}
          >
            {injecting
              ? "发送中…"
              : composerMode === "inject"
                ? "发送给 Orchestrator"
                : "发送"}
          </button>
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
  plan,
  onExecutePlan,
  onGoalAction,
  executeDisabled,
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
  plan: OrchestratorPlan | null;
  onExecutePlan?: () => void;
  onGoalAction?: (action: "pause" | "resume" | "edit" | "clear") => void;
  executeDisabled: boolean;
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
      <PlanCard
        plan={plan}
        onExecute={onExecutePlan}
        onGoalAction={onGoalAction}
        executeDisabled={executeDisabled}
      />
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
  runStrip: {
    flexShrink: 0,
    borderBottom: "1px solid var(--qb-team-shell-border, #2d2d32)",
    marginBottom: 8,
    paddingBottom: 8,
  },
  runStripToggle: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 2,
    border: "none",
    background: "transparent",
    color: "#e4e4e7",
    cursor: "pointer",
    padding: "4px 0",
    textAlign: "left",
  },
  runStripTitle: { fontSize: 12, fontWeight: 600, color: "#93c5fd" },
  runStripSummary: { fontSize: 11, color: "#a1a1aa" },
  runStripBody: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
  runStripLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 11,
    color: "#a1a1aa",
  },
  runStripSelect: {
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
  },
  runStripActions: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  runStripConfirmHint: { fontSize: 11, color: "#fbbf24" },
  runStripSettings: {
    maxHeight: 360,
    overflow: "auto",
    paddingRight: 2,
  },
  runStripBtn: { fontSize: 12, padding: "6px 10px" },
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
  body: {
    flex: "1 1 0",
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "10px 2px 12px",
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
  sendBtnDisabled: { opacity: 0.5, cursor: "not-allowed" },
};
