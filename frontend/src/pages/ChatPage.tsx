import type {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from "react";
import { ImagePlus, PanelLeft, PanelTop, Plus, X } from "lucide-react";
import {
  chatHealth,
  createChatSession,
  createConversationTurn,
  getChatSessionWorkflow,
  getOrCreateDefaultProject,
  deleteChatSession,
  deleteWorkflow,
  listChatSessions,
  listSessionMessages,
  patchSessionMessage,
  listPendingWorkflowHitl,
  resolveWorkflowHitl,
  subscribeSessionEvents,
  subscribeWorkflowStream,
} from "../api/backend";
import type {
  AgentLoopKind,
  ChatImageAttachment,
  ChatMessage,
  StepStreamEvent,
} from "../api/types";
import { useAppStore, type ChartContextPayload } from "../store";
import { MarkdownBubble } from "../components/chat/MarkdownBubble";
import { IconToolbarButton } from "../components/ui/IconToolbarButton";
import {
  clearChatStreamBinding,
  hydrateStaleChatMessages,
  persistChatStreamBinding,
  reconnectActiveChatStreams,
  buildFinalAssistantText,
  messageStatusFromFinalPayload,
  stripToolCallSentinels,
} from "../lib/chatMessageHydration";
import { useTranslation } from "../i18n";
import { ChatHitlPromptControls } from "../components/chat/ChatHitlPromptControls";
import { ChatExecutionActivity } from "../components/chat/ChatExecutionActivity";
import { ChatMessageFeedbackBar } from "../components/chat/ChatMessageFeedbackBar";
import { AgentModePicker, getAgentModeOption } from "../components/chat/AgentModePicker";
import {
  clipboardImageFiles,
  imageAttachmentFromFile,
  MAX_CHAT_IMAGES,
} from "../lib/chatImageAttachments";

import { styles } from "./_shared/legacyMainStyles";

/** Chat 页面（原 MainContent.ChatPanel） */
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
  /** @deprecated 1 session = 1 workflow；保留 prop 仅为兼容旧调用方，不再用于 API 传参 */
  workflowRunId?: string | null;
  onWorkflowFocusChange?: (workflowRunId: string | null) => void;
}> = ({
  ideEmbedded,
  displayMode = "standard",
  hideSessionSidebar = false,
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
  const [imageAttachments, setImageAttachments] = useState<ChatImageAttachment[]>([]);
  const imagePickerRef = useRef<HTMLInputElement | null>(null);
  const chatDraftPrefill = useAppStore((s) => s.chatDraftPrefill);
  const setChatDraftPrefill = useAppStore((s) => s.setChatDraftPrefill);
  const [errorText, setErrorText] = useState("");
  /** 当前 session 的 canonical chat workflow（1 session = 1 workflow） */
  const [sessionWorkflowRunId, setSessionWorkflowRunId] = useState<string | null>(null);
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
  const [hitlInflightRequestIds, setHitlInflightRequestIds] = useState<Set<string>>(
    () => new Set()
  );
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
  const sessionLoadSeqRef = useRef(0);
  const [streamRunByMessageId, setStreamRunByMessageId] = useState<Record<string, string>>({});

  const addImageFiles = useCallback(
    async (files: Iterable<File>) => {
      const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      const remaining = MAX_CHAT_IMAGES - imageAttachments.length;
      if (remaining <= 0) {
        setErrorText(`最多可附加 ${MAX_CHAT_IMAGES} 张图片`);
        return;
      }
      try {
        const attachments = await Promise.all(
          images.slice(0, remaining).map(imageAttachmentFromFile)
        );
        setImageAttachments((previous) => [...previous, ...attachments]);
        if (images.length > remaining) setErrorText(`最多可附加 ${MAX_CHAT_IMAGES} 张图片`);
        else setErrorText("");
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : "读取图片失败");
      }
    },
    [imageAttachments.length]
  );

  const onComposerPaste = (event: ReactClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const files = clipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  };

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
      const loadSeq = ++sessionLoadSeqRef.current;
      const raw = await listSessionMessages(sessionId);
      if (loadSeq !== sessionLoadSeqRef.current) return;
      // 先显示数据库中的消息并恢复流，历史工作流补全文本放到后台，避免首屏等待所有 detail。
      setChatMessages(raw);
      reconnectActiveChatStreams(raw, (workflowId, runId, assistantMessageId) => {
        bindStreamRef.current?.(workflowId, runId, assistantMessageId);
      });
      void hydrateStaleChatMessages(raw).then((hydrated) => {
        if (loadSeq !== sessionLoadSeqRef.current) return;
        const hydratedById = new Map(hydrated.map((message) => [message.id, message]));
        setChatMessages((current) =>
          current.map((message) => hydratedById.get(message.id) ?? message)
        );
      });
      const pendingMessages = raw.filter(
        (msg) => msg.status === "awaiting_approval" && Boolean(msg.workflowRunIds?.[0])
      );
      if (pendingMessages.length > 0) {
        void Promise.all(
          pendingMessages.map(async (msg) => {
            try {
              const pending = await listPendingWorkflowHitl(msg.workflowRunIds?.[0] ?? "");
              return pending[0]?.id ? { messageId: msg.id, requestId: pending[0].id } : null;
            } catch {
              return null;
            }
          })
        ).then((items) => {
          if (loadSeq !== sessionLoadSeqRef.current) return;
          const hitlMap = Object.fromEntries(
            items
              .filter((item): item is { messageId: string; requestId: string } => item !== null)
              .map((item) => [item.messageId, item.requestId])
          );
          if (Object.keys(hitlMap).length > 0) {
            setHitlRequestByMessageId((prev) => ({ ...prev, ...hitlMap }));
          }
        });
      }
    },
    [setChatMessages]
  );

  useEffect(() => {
    const boot = async () => {
      const [dftProj] = await Promise.all([getOrCreateDefaultProject(), chatHealth()]);
      const wsId = dftProj.workspaceId;
      const pid = dftProj.id;
      setWorkspaceId(wsId);
      setProjectId(pid);
      const sessions = await listChatSessions({ workspaceId: wsId, projectId: pid, limit: 100 });
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
    if (!selectedSessionId || !projectId) {
      setSessionWorkflowRunId(null);
      return;
    }
    let disposed = false;
    void getChatSessionWorkflow(selectedSessionId, projectId)
      .then((row) => {
        if (disposed) return;
        const id = String(row.id ?? "").trim();
        setSessionWorkflowRunId(id || null);
        if (id) onWorkflowFocusChange?.(id);
      })
      .catch(() => {
        if (!disposed) setSessionWorkflowRunId(null);
      });
    return () => {
      disposed = true;
    };
  }, [selectedSessionId, projectId, onWorkflowFocusChange]);

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
        if (
          event.type === "observe" ||
          event.type === "tool_call_start" ||
          event.type === "tool_call_end"
        ) {
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
                m.id === assistantMessageId ? { ...m, content: stepLabel, status: "running" } : m
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
              m.id === assistantMessageId
                ? { ...m, content: cleanedBuffer, status: "completed" }
                : m
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
          await patchSessionMessage({
            messageId,
            status: "running",
            content: "▶️ 已批准，继续执行…",
          });
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
    if (!selectedSessionId || !projectId || (!input.trim() && imageAttachments.length === 0))
      return;
    try {
      const trimmed = input.trim() || "请分析附图。";
      const block = chartContext ? formatChartContextBlock(chartContext) : "";
      const combinedGoal = block ? `${block}\n\n${trimmed}` : trimmed;
      const turn = await createConversationTurn({
        sessionId: selectedSessionId,
        projectId,
        message: combinedGoal,
        workflowMode: "research",
        turnMode: "continue_goal",
        loopKind: chatLoopKind,
        hitlMode: chatHitlMode,
        agentMode: chatAgentMode,
        ...(imageAttachments.length ? { attachments: imageAttachments } : {}),
      });
      setSessionWorkflowRunId(turn.runId);
      onWorkflowFocusChange?.(turn.runId);
      const streamRunId = turn.agentRunId ?? turn.runId;
      if (streamRunId) {
        bindStream(turn.runId, streamRunId, turn.assistantMessage.id);
      }
      await reloadSessionMessages(selectedSessionId);
      setInput("");
      setImageAttachments([]);
      setChartContext(null);
      setErrorText("");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "发送失败");
    }
  };

  const canSend = Boolean(input.trim() || imageAttachments.length > 0);

  const visibleChatMessages = chatMessages;

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
        (message) => message.status === "awaiting_approval" && Boolean(message.workflowRunIds?.[0])
      ) ?? null;

  const handleStopGeneration = async () => {
    const message = activeAssistantMessage;
    const workflowId = message?.workflowRunIds?.[0];
    if (!message || !workflowId) return;
    const partial = stripToolCallSentinels(message.content).trim();
    const stoppedContent = partial ? `${partial}\n\n_已停止生成_` : "⏹️ 已停止生成";
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
            已附带行情上下文（{chartContext.symbol} / {chartContext.timeframe}
            ）。发送一条消息后会自动清除。
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
          showSessionChrome
            ? `qb-chat-layout--sessions-${sessionLayout}`
            : "qb-chat-layout--sessions-hidden",
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
              {sessionWorkflowRunId ? (
                <span className="qb-simple-session-workflow-hint" title={sessionWorkflowRunId}>
                  workflow {sessionWorkflowRunId.slice(0, 8)}…
                </span>
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
                const running = msgs.some((m) => m.status === "running" || m.status === "queued");
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
                        {workflowIds.map((id) => (
                          <button
                            key={id}
                            type="button"
                            className={
                              simpleMode ? "qb-simple-chat-workflow-link" : "qb-btn-ghost qb-btn--compact"
                            }
                            onClick={() => openWorkflowTrace(id)}
                            title={`在运行监控中查看 workflow ${id} 的完整 Trace`}
                          >
                            {simpleMode ? `workflow ${id.slice(0, 8)}` : `查看 Trace · ${id.slice(0, 8)}`}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {!running && last.status === "completed" && (last.workflowRunIds?.length ?? workflowIds.length) ? (
                      <ChatMessageFeedbackBar chatMessageId={last.id} />
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
                  {msg.attachments?.length ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                      {msg.attachments.map((attachment, index) => (
                        <img
                          key={`${attachment.name ?? "image"}-${index}`}
                          src={attachment.dataUrl}
                          alt={attachment.name || "已附加图片"}
                          style={{
                            width: 156,
                            maxHeight: 156,
                            objectFit: "cover",
                            borderRadius: 8,
                            border: "1px solid var(--qb-border, #3f3f46)",
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
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
            <input
              ref={imagePickerRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addImageFiles(event.target.files);
                event.target.value = "";
              }}
            />
            {imageAttachments.length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", width: "100%" }}>
                {imageAttachments.map((attachment, index) => (
                  <div
                    key={`${attachment.name ?? "image"}-${index}`}
                    style={{ position: "relative" }}
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name || "待发送图片"}
                      style={{
                        width: 72,
                        height: 72,
                        objectFit: "cover",
                        borderRadius: 8,
                        border: "1px solid var(--qb-border, #3f3f46)",
                      }}
                    />
                    <button
                      type="button"
                      aria-label="移除图片"
                      onClick={() =>
                        setImageAttachments((items) => items.filter((_, i) => i !== index))
                      }
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        width: 20,
                        height: 20,
                        padding: 2,
                        borderRadius: 999,
                        border: "1px solid #52525b",
                        background: "#18181b",
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {!simpleMode ? (
              <AgentModePicker value={chatAgentMode} onChange={setChatAgentMode} />
            ) : null}
            {!simpleMode ? (
              <label style={{ ...styles.chatMeta, display: "flex", alignItems: "center", gap: 6 }}>
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
              </label>
            ) : null}
            {!simpleMode ? (
              <label
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
              </label>
            ) : null}
            {simpleMode ? (
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={onComposerPaste}
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
                onPaste={onComposerPaste}
                placeholder={t("chat.form.placeholder")}
              />
            )}
            {simpleMode ? (
              <div className="qb-simple-composer__footer">
                <button
                  type="button"
                  onClick={() => imagePickerRef.current?.click()}
                  title="粘贴或选择图片"
                  aria-label="选择图片"
                >
                  <ImagePlus size={16} />
                </button>
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
                  disabled={!activeAssistantMessage && !canSend}
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
                type="button"
                className="qb-btn-ghost"
                onClick={() => imagePickerRef.current?.click()}
                title="粘贴或选择图片"
              >
                <ImagePlus size={16} />
              </button>
            )}
            {!simpleMode ? (
              <button
                className={activeAssistantMessage ? "qb-btn-danger" : "qb-btn-primary-brand"}
                type={activeAssistantMessage ? "button" : "submit"}
                disabled={!activeAssistantMessage && !canSend}
                onClick={activeAssistantMessage ? () => void handleStopGeneration() : undefined}
              >
                {activeAssistantMessage ? "停止" : t("common.action.send")}
              </button>
            ) : null}
          </form>
        </div>
      </div>
    </div>
  );
};
