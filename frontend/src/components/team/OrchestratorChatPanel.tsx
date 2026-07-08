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
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LiveConversationEvent, LiveConversationView } from "./LiveConversationView";
import { TeamHitlBanner } from "./TeamHitlBanner";
import { type OrchestratorPlan, PlanCard } from "./PlanCard";

export type OrchestratorHitlMode = "off" | "ai" | "always";

/** 内联产物卡片（Orchestrator 对话框里直接展示已生成的因子/策略/脚本，点击可打开）。 */
export interface OrchestratorArtifact {
  id: string;
  kind: "factor" | "strategy" | "script";
  title: string;
  subtitle?: string;
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
  /** 自主 / HITL 模式 */
  hitlMode: OrchestratorHitlMode;
  onHitlModeChange: (mode: OrchestratorHitlMode) => void;
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
  /** Coding-Agent 体验 P1：Orchestrator 的分步计划/TODO（update_plan 推流），置于对话框顶部 */
  plan?: OrchestratorPlan | null;
  /** Coding-Agent 体验 P1：当前「正在调用什么、为何」活动行（tool_rationale 推流） */
  activity?: { tool: string; why: string } | null;
  /** 本工作流已生成的产物（因子/策略/脚本），内联在对话框顶部展示 */
  artifacts: OrchestratorArtifact[];
  /** 点击产物卡片：跳到量化工坊 / 底部抽屉打开 */
  onOpenArtifact: (artifact: OrchestratorArtifact) => void;
  /** 空闲启动是否禁用（沿用 teamRunDisabled） */
  sendDisabled: boolean;
  /** 启动禁用原因（tooltip） */
  sendDisabledReason: string;
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
  hitlMode,
  onHitlModeChange,
  pendingHitlRequestId,
  onHitlResolved,
  completed,
  composerValue,
  onComposerChange,
  onSend,
  onInject,
  onInterrupt,
  plan,
  activity,
  artifacts,
  onOpenArtifact,
  sendDisabled,
  sendDisabledReason,
}: OrchestratorChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [injectHint, setInjectHint] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const wfId = workflowRunId.trim();

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
        if (ev.messageKind === "tool_call") return false; // tool 调用属于子 Agent 视图
        return ev.fromRole === "orchestrator" || ev.fromRole === "user";
      }),
    [events]
  );

  // 新消息进来时自动滚到底（右栏主对话框默认始终跟随最新）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, runProgress]);

  /**
   * 发送语义：
   *   - 运行中：发送 = 把文本「注入」运行中的 Orchestrator（onInject，下一轮 reason 生效）
   *   - 其余（空闲/已完成）：发送 = 交给 Orchestrator **自主判断**（onSend → orchestrator-chat：
   *     直接答 / assign_task 派单 / run_analyst_team 全队）。是对话，不需要研究范围，
   *     故不受 sendDisabled 约束。「启动团队分析」按钮才是直接全队。
   */
  const showActive = running || chatInFlight;
  const mode: "chat" | "inject" = running ? "inject" : "chat";
  const hasContent = composerValue.trim().length > 0;
  const canSend = wfId.length > 0 && hasContent && !injecting;
  // 现已统一走 orchestrator 自主对话；以下 props 保留接口兼容但不再约束发送。
  void completed;
  void sendDisabled;
  void sendDisabledReason;

  const doSend = async () => {
    if (!canSend) return;
    if (mode === "inject") {
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
      : mode === "inject"
        ? "Orchestrator 运行中 —— 发送的指令会在它下一轮思考时被采纳（Cmd/Ctrl+Enter）"
        : "和 Orchestrator 对话 —— 它会自主判断：直接回答 / 派给某分析师 / 跑全队（Cmd/Ctrl+Enter 发送）";

  return (
    <div style={styles.root}>
      {/* Header：标题 + 运行徽标 + 模式切换 */}
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
        <div style={styles.modeRow} role="radiogroup" aria-label="自主 / HITL 模式">
          {MODE_OPTIONS.map((opt) => {
            const active = hitlMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={running}
                title={opt.hint}
                onClick={() => onHitlModeChange(opt.id)}
                style={{
                  ...styles.modeBtn,
                  ...(active ? styles.modeBtnActive : null),
                  ...(running ? styles.modeBtnDisabled : null),
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {/* 只聚焦 Orchestrator：对用户输出=气泡，对子 Agent 的 A2A=折叠卡片 */}
        <div style={styles.scopeRow}>
          <span style={styles.scopeHint}>
            仅显示 Orchestrator 对你的输出；对子 Agent 的派单已折叠成卡片。子 Agent
            之间的完整对话请点中间拓扑图的节点查看。
          </span>
        </div>
      </div>

      {/* Body：计划卡片 + 当前活动 + 内联 HITL + 产物卡片 + 对话流 */}
      <div ref={scrollRef} style={styles.body} data-qb-orchestrator-chat>
        <PlanCard plan={plan ?? null} />
        {activity?.why ? (
          <div style={styles.activityLine}>
            <span style={styles.activitySpinner} aria-hidden>
              ⠋
            </span>
            <span style={styles.activityText}>
              {activity.tool ? <strong>调用 {activity.tool}</strong> : null}
              {activity.tool ? "：" : null}
              {activity.why}
            </span>
          </div>
        ) : null}
        {wfId ? (
          <TeamHitlBanner
            workflowRunId={wfId}
            triggerKey={pendingHitlRequestId ?? wfId}
            onResolved={onHitlResolved}
          />
        ) : null}
        {artifacts.length > 0 ? (
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
            </button>
            {artifactsOpen ? (
              <div style={styles.artifactList}>
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
          contentMaxLength={6000}
          collapseA2AFromRole="orchestrator"
          onOpenRef={(ref) => {
            // 交接信封里的产物引用 → 复用产物打开逻辑（factor / strategy_version）。
            const kind =
              ref.kind === "factor" ? "factor" : ref.kind === "strategy_version" ? "strategy" : null;
            if (kind) onOpenArtifact({ id: ref.id, kind, title: ref.id });
          }}
          emptyText={
            !wfId
              ? "请先在左侧选择或新建工作流，再与 Orchestrator 对话。"
              : running
                ? "Orchestrator 已启动，正在规划与派发…"
                : "输入研究指令并发送，Orchestrator 将开始工作。子 Agent 的对话可在中间拓扑图点击节点查看。"
          }
        />
      </div>

      {/* Footer：进度 + composer */}
      <div style={styles.footer}>
        {running && runProgress ? <div style={styles.progress}>{runProgress}</div> : null}
        {injectHint ? <div style={styles.injectHint}>{injectHint}</div> : null}
        <textarea
          style={styles.composer}
          value={composerValue}
          onChange={(e) => onComposerChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={
            mode === "inject"
              ? "给运行中的 Orchestrator 追加指令，例如：把重点放到现金流质量上…"
              : "和 Orchestrator 对话，例如：总结一下结论 / 重做一次技术面 / 对当前标的做深度尽调…"
          }
        />
        <div style={styles.composerBar}>
          <span style={styles.composerHint}>{composerHint}</span>
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={{ ...styles.sendBtn, ...(canSend ? null : styles.sendBtnDisabled) }}
            disabled={!canSend}
            title={
              canSend
                ? mode === "inject"
                  ? "发送给运行中的 Orchestrator"
                  : "发送给 Orchestrator（它自主判断如何处理）"
                : "请输入内容"
            }
            onClick={() => void doSend()}
          >
            {injecting ? "发送中…" : mode === "inject" ? "发送给 Orchestrator" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
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
  modeRow: { display: "flex", gap: 6 },
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
  modeBtn: {
    flex: 1,
    padding: "5px 6px",
    fontSize: 11,
    border: "1px solid #3f3f46",
    background: "transparent",
    color: "#a1a1aa",
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
  },
  modeBtnActive: {
    borderColor: "#60a5fa",
    background: "rgba(96,165,250,0.16)",
    color: "#93c5fd",
    fontWeight: 600,
  },
  modeBtnDisabled: { cursor: "not-allowed", opacity: 0.6 },
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
  artifactList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "0 8px 8px",
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
  composerBar: { display: "flex", alignItems: "center", gap: 8 },
  composerHint: { flex: 1, minWidth: 0, fontSize: 10.5, color: "#71717a", lineHeight: 1.4 },
  sendBtn: { flexShrink: 0, fontSize: 12, padding: "6px 16px" },
  sendBtnDisabled: { opacity: 0.5, cursor: "not-allowed" },
};
