import type { CSSProperties, FC, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { MarkdownBubble } from "../chat/MarkdownBubble";
import {
  avatarColorFor,
  avatarLabelFor,
  formatRoleName,
  TEAM_BROADCAST_ROLE,
} from "./conversationAvatar";

/**
 * 通用 IM 风格对话流。
 *
 * - `selfRole`：左右气泡的判定依据，self → 右侧黄；其他 → 左侧带头像。
 * - `events`：归一化后的对话事件，按 ts 升序排列；外部已过滤过的事件直接喂进来。
 * - debate / system 事件渲染成居中横幅卡，避免和正常 message 混淆。
 * - tool_call 消息单独走 ToolCallCard，跟普通 LLM 对话区分开，避免 JSON 把视线挤垮。
 */
export type LiveConversationMessageEvent = {
  kind: "message";
  id: string;
  ts: string;
  fromRole: string;
  toRole: string;
  /** 比如 'llm_message' / 'tool_call' / 'handoff'。 */
  messageKind?: string | null;
  toolName?: string | null;
  contentText: string;
};

export type LiveConversationDebateEvent = {
  kind: "debate";
  id: string;
  ts: string;
  /** 'debate_start' | 'debate_turn' | 'debate_verdict' | 'debate_end' | string */
  debateType: string;
  speakerRole?: string | null;
  round?: number | null;
  stance?: string | null;
  text: string;
};

export type LiveConversationSystemEvent = {
  kind: "system";
  id: string;
  ts: string;
  text: string;
};

export type LiveConversationEvent =
  | LiveConversationMessageEvent
  | LiveConversationDebateEvent
  | LiveConversationSystemEvent;

export type LiveConversationViewProps = {
  events: LiveConversationEvent[];
  /** 哪个 role 显示在右侧（"本人"），默认 orchestrator。 */
  selfRole?: string;
  /** 内容裁剪上限，每条消息最多渲染多少字符。 */
  contentMaxLength?: number;
  emptyText?: ReactNode;
};

function formatTs(ts: string): string {
  const m = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  if (m && m[1]) return m[1];
  if (/^\d{2}:\d{2}/.test(ts)) return ts.slice(0, 8);
  const d = new Date(ts);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return ts;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

export const LiveConversationView: FC<LiveConversationViewProps> = ({
  events,
  selfRole = "orchestrator",
  contentMaxLength = 4000,
  emptyText,
}) => {
  const { t } = useTranslation();
  const sorted = useMemo(() => {
    return [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }, [events]);

  if (sorted.length === 0) {
    return (
      <div
        data-qb-live-conv-empty
        style={{
          fontSize: 12,
          color: "var(--qb-team-meta, #71717a)",
          padding: "16px 8px",
        }}
      >
        {emptyText ?? t("team.conversation.empty")}
      </div>
    );
  }

  return (
    <div data-qb-live-conv style={containerStyle}>
      {sorted.map((ev) => {
        switch (ev.kind) {
          case "message":
            if (ev.messageKind === "tool_call") {
              return <ToolCallCard key={ev.id} ev={ev} maxLen={contentMaxLength} />;
            }
            /**
             * Orchestrator 的"全员广播"消息（runtime 写入 toRole=__team__，避免对 N 个
             * 分析师重复落 N 条几乎一样的 llm_message）渲染成居中横幅，跟 1-1 message
             * 区分开 —— 否则前端硬编码识别 "to ∈ role 集合" 会把它当成普通 message 显示，
             * 头像 / 路由都对不上。
             */
            if (ev.toRole === TEAM_BROADCAST_ROLE) {
              return <BroadcastBanner key={ev.id} ev={ev} maxLen={contentMaxLength} />;
            }
            return <MessageRow key={ev.id} ev={ev} selfRole={selfRole} maxLen={contentMaxLength} />;
          case "debate":
            return <DebateBanner key={ev.id} ev={ev} maxLen={contentMaxLength} />;
          case "system":
            return <SystemBanner key={ev.id} ev={ev} maxLen={contentMaxLength} />;
        }
      })}
    </div>
  );
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "8px 4px",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
};

const Avatar: FC<{ role: string; size?: number }> = ({ role, size = 28 }) => {
  const { bg, fg } = avatarColorFor(role);
  return (
    <div
      title={formatRoleName(role)}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color: fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size <= 24 ? 9 : 10,
        fontWeight: 700,
        flexShrink: 0,
        boxShadow: "0 0 0 1px rgba(255,255,255,0.06)",
        userSelect: "none",
      }}
    >
      {avatarLabelFor(role)}
    </div>
  );
};

const tsLabel: CSSProperties = {
  fontSize: 10,
  color: "var(--qb-team-meta, #71717a)",
  fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
};

/**
 * 启发式判断 LLM 消息是否值得走 Markdown 渲染：
 * - GFM 表格：连续两行都出现 `|`；
 * - 标题：行首 `# ` ~ `###### `；
 * - 引用：行首 `> `；
 * - 有序/无序列表：行首 `- ` / `* ` / `1. `；
 * - 围栏代码块：``` 或 ~~~；
 * - 链接：`[text](url)`；
 * 任一命中即视为 markdown。否则走更省渲染开销的 plain text 分支。
 */
function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  if (/```|~~~/.test(text)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;
  if (/(^|\n)#{1,6}\s/.test(text)) return true;
  if (/(^|\n)>\s/.test(text)) return true;
  if (/(^|\n)\s*([-*+]\s|\d+\.\s)/.test(text)) return true;
  // GFM table 需要至少表头 + 分隔行两行 `|`：
  const lines = text.split("\n");
  let pipeLines = 0;
  for (const line of lines) {
    if (line.includes("|")) pipeLines++;
    if (pipeLines >= 2) return true;
  }
  return false;
}

const MessageRow: FC<{
  ev: LiveConversationMessageEvent;
  selfRole: string;
  maxLen: number;
}> = ({ ev, selfRole, maxLen }) => {
  const { t } = useTranslation();
  const isSelf = ev.fromRole === selfRole;
  const accent = avatarColorFor(ev.fromRole).bg;
  const tagText = `${formatRoleName(ev.fromRole)} → ${formatRoleName(ev.toRole)}${
    ev.messageKind ? ` · ${ev.messageKind}` : ""
  }${ev.toolName ? ` · ${ev.toolName}` : ""}`;
  const bubbleBg = isSelf ? "rgba(245,158,11,0.08)" : "rgba(96,165,250,0.06)";
  const bubbleBorder = isSelf
    ? "rgba(245,158,11,0.32)"
    : `rgba(${hexToRgbStr(avatarColorFor(ev.fromRole).bg)}, 0.32)`;
  const safeBorder = bubbleBorder.includes("rgba(NaN") ? "rgba(96,165,250,0.32)" : bubbleBorder;

  const rawContent = ev.contentText || t("team.conversation.noTextContent");
  const content = truncate(rawContent, maxLen);
  /**
   * llm_message 消息往往是分析师的结构化输出，里面带 GFM 表格 / 标题 / 列表，
   * 直接 `pre-wrap` 显示会把 `|` 当原始字符——所以这里启发式切到 MarkdownBubble，
   * 让表格 / 标题 / 代码块走我们改良过的样式。
   * 其它种类（handoff、纯 ack 等短文本）继续走更轻量的内联文本分支。
   */
  const useMarkdown =
    (ev.messageKind === "llm_message" || ev.messageKind == null) && looksLikeMarkdown(content);

  return (
    <div
      data-qb-live-conv-row={isSelf ? "self" : "other"}
      style={{
        display: "flex",
        flexDirection: isSelf ? "row-reverse" : "row",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <Avatar role={ev.fromRole} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isSelf ? "flex-end" : "flex-start",
          maxWidth: useMarkdown ? "92%" : "82%",
          minWidth: 0,
        }}
      >
        <div style={{ ...tsLabel, marginBottom: 2 }}>
          {formatTs(ev.ts)} · {tagText}
        </div>
        <div
          data-qb-live-conv-bubble={isSelf ? "self" : "other"}
          data-qb-live-conv-md={useMarkdown ? "1" : undefined}
          style={{
            padding: useMarkdown ? "6px 12px" : "8px 12px",
            borderRadius: 10,
            background: bubbleBg,
            border: `1px solid ${safeBorder}`,
            color: "var(--qb-team-live-feed-fg, var(--qb-body-fg, #e4e4e7))",
            fontSize: useMarkdown ? 13 : 12,
            lineHeight: 1.55,
            whiteSpace: useMarkdown ? "normal" : "pre-wrap",
            wordBreak: "break-word",
            position: "relative",
            minWidth: 0,
            width: useMarkdown ? "100%" : undefined,
          }}
        >
          {useMarkdown ? (
            <>
              {!isSelf ? (
                <div
                  style={{
                    display: "block",
                    color: accent,
                    fontWeight: 600,
                    fontSize: 11,
                    marginBottom: 2,
                    lineHeight: 1.4,
                  }}
                >
                  {formatRoleName(ev.fromRole)}
                </div>
              ) : null}
              <MarkdownBubble text={content} />
            </>
          ) : (
            <>
              {!isSelf ? (
                <span
                  style={{
                    color: accent,
                    fontWeight: 600,
                    fontSize: 11,
                    marginRight: 6,
                  }}
                >
                  {formatRoleName(ev.fromRole)}
                </span>
              ) : null}
              {content}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/** 把 tool_call 的 contentText（首行 "✓ name (123ms)\n{json}"）解构出来。 */
type ToolCallPieces = {
  statusIcon: string | null;
  /** 'ok' | 'warn' | 'fail' | 'unknown'。 */
  status: "ok" | "warn" | "fail" | "unknown";
  latencyMs: number | null;
  body: string;
};

function parseToolCallText(text: string, fallbackName: string | null | undefined): ToolCallPieces {
  if (!text) {
    return { statusIcon: null, status: "unknown", latencyMs: null, body: "" };
  }
  const firstNl = text.indexOf("\n");
  const head = firstNl === -1 ? text : text.slice(0, firstNl);
  const rest = firstNl === -1 ? "" : text.slice(firstNl + 1);

  /**
   * 兼容 logResearchTeamInteraction 写入的格式： `✓ name (123ms)\n{json}` /
   * `✗ name (123ms)\n{...}` / `⚠ name ...`。第二个分组 `(?:⚠️|.)` 单独把 `⚠️`
   * (U+26A0 U+FE0F) 这种带 variation selector 的双字符 emoji 放在外面，避免
   * 把多字符 emoji 塞进字符类（biome noMisleadingCharacterClass 会报）。
   */
  const m = head.match(/^(⚠️|[✓✗⚠ℹ])\s*([^\s].*?)\s*(?:\((\d+)ms\))?\s*$/);
  if (!m) {
    return { statusIcon: null, status: "unknown", latencyMs: null, body: text };
  }
  const icon = m[1] ?? null;
  const name = m[2] ?? fallbackName ?? "";
  const latency = m[3] ? Number(m[3]) : null;
  let status: ToolCallPieces["status"] = "unknown";
  if (icon === "✓") status = "ok";
  else if (icon === "✗") status = "fail";
  else if (icon === "⚠" || icon === "⚠️") status = "warn";

  if (rest.trim().length === 0 && name) {
    return { statusIcon: icon, status, latencyMs: latency, body: "" };
  }
  return { statusIcon: icon, status, latencyMs: latency, body: rest };
}

function tryPrettyJson(body: string): { isJson: boolean; pretty: string } {
  const trimmed = body.trim();
  if (!trimmed) return { isJson: false, pretty: "" };
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) return { isJson: false, pretty: body };
  try {
    const parsed = JSON.parse(trimmed);
    return { isJson: true, pretty: JSON.stringify(parsed, null, 2) };
  } catch {
    return { isJson: false, pretty: body };
  }
}

type StatusStyle = {
  bg: string;
  border: string;
  fg: string;
  chip: string;
};

const STATUS_PALETTE: Record<ToolCallPieces["status"], StatusStyle> = {
  ok: {
    bg: "rgba(34,197,94,0.07)",
    border: "rgba(34,197,94,0.35)",
    fg: "#86efac",
    chip: "rgba(34,197,94,0.16)",
  },
  warn: {
    bg: "rgba(245,158,11,0.07)",
    border: "rgba(245,158,11,0.32)",
    fg: "#fbbf24",
    chip: "rgba(245,158,11,0.18)",
  },
  fail: {
    bg: "rgba(239,68,68,0.07)",
    border: "rgba(239,68,68,0.35)",
    fg: "#fca5a5",
    chip: "rgba(239,68,68,0.18)",
  },
  unknown: {
    bg: "rgba(148,163,184,0.07)",
    border: "rgba(148,163,184,0.32)",
    fg: "#cbd5e1",
    chip: "rgba(148,163,184,0.18)",
  },
};

const COLLAPSED_BODY_LINES = 8;

const ToolCallCard: FC<{ ev: LiveConversationMessageEvent; maxLen: number }> = ({ ev, maxLen }) => {
  const { t } = useTranslation();
  const pieces = parseToolCallText(ev.contentText, ev.toolName);
  const palette = STATUS_PALETTE[pieces.status];
  const statusLabel = t(`team.conversation.toolCall.status.${pieces.status}`);
  const toolCallAria = t("team.conversation.toolCall.ariaLabel");
  const toolName = ev.toolName || "tool";
  const { isJson, pretty } = tryPrettyJson(pieces.body);
  const fullBody = truncate(pretty, maxLen);
  const lines = fullBody.split("\n");
  const collapsable = lines.length > COLLAPSED_BODY_LINES;
  const [expanded, setExpanded] = useState(false);
  const visibleBody = expanded || !collapsable ? fullBody : lines.slice(0, COLLAPSED_BODY_LINES).join("\n");

  return (
    <div
      data-qb-live-conv-toolcall={pieces.status}
      style={{
        alignSelf: "stretch",
        margin: "0 auto",
        width: "min(96%, 720px)",
        padding: "8px 12px 10px",
        borderRadius: 10,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        boxShadow: "0 1px 0 rgba(0,0,0,0.18) inset",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: pieces.body ? 6 : 0,
        }}
      >
        <span style={{ ...tsLabel }}>{formatTs(ev.ts)}</span>
        <span
          style={{
            fontSize: 10,
            color: "var(--qb-team-meta, #71717a)",
            fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
          }}
        >
          ·
        </span>
        <span
          title={formatRoleName(ev.fromRole)}
          style={{
            fontSize: 11,
            color: avatarColorFor(ev.fromRole).bg,
            fontWeight: 600,
          }}
        >
          {formatRoleName(ev.fromRole)}
        </span>
        <span
          aria-label={toolCallAria}
          title={toolCallAria}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 6px",
            borderRadius: 4,
            background: "rgba(0,0,0,0.18)",
            border: "1px solid rgba(255,255,255,0.06)",
            fontSize: 10,
            color: "var(--qb-team-meta, #a1a1aa)",
            fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
            letterSpacing: 0.2,
          }}
        >
          <span aria-hidden style={{ opacity: 0.85 }}>{"⚙"}</span>
          tool
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--qb-body-fg, #e4e4e7)",
            fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {toolName}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 7px",
            borderRadius: 999,
            background: palette.chip,
            color: palette.fg,
            border: `1px solid ${palette.border}`,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.2,
          }}
        >
          {pieces.statusIcon ? <span aria-hidden>{pieces.statusIcon}</span> : null}
          {statusLabel}
          {pieces.latencyMs != null ? (
            <span style={{ opacity: 0.75 }}>· {pieces.latencyMs}ms</span>
          ) : null}
        </span>
        {collapsable ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              marginLeft: "auto",
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 4,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "var(--qb-team-meta, #a1a1aa)",
              cursor: "pointer",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
            }}
          >
            {expanded
              ? t("team.conversation.toolCall.collapse")
              : t("team.conversation.toolCall.expand", { n: lines.length })}
          </button>
        ) : null}
      </div>
      {pieces.body ? (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.28)",
            border: "1px solid rgba(255,255,255,0.05)",
            color: isJson ? "#e4e4e7" : "#d4d4d8",
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: expanded ? "60vh" : undefined,
            overflowY: expanded ? "auto" : "hidden",
          }}
        >
          {visibleBody}
          {!expanded && collapsable ? (
            <span style={{ color: "var(--qb-team-meta, #71717a)" }}>{"\n…"}</span>
          ) : null}
        </pre>
      ) : null}
    </div>
  );
};

function useDebateTitle(): (ev: LiveConversationDebateEvent) => string {
  const { t } = useTranslation();
  return (ev: LiveConversationDebateEvent) => {
    switch (ev.debateType) {
      case "debate_start":
        return t("team.conversation.debate.start");
      case "debate_turn":
        return t("team.conversation.debate.turn", {
          round: ev.round ?? "?",
          stance: ev.stance ? ` · ${ev.stance}` : "",
          speaker: ev.speakerRole ? ` · ${formatRoleName(ev.speakerRole)}` : "",
        });
      case "debate_verdict":
        return t("team.conversation.debate.verdict");
      case "debate_end":
        return t("team.conversation.debate.end");
      default:
        return ev.debateType;
    }
  };
}

const DebateBanner: FC<{ ev: LiveConversationDebateEvent; maxLen: number }> = ({ ev, maxLen }) => {
  const debateTitle = useDebateTitle();
  return (
    <div style={bannerWrapStyle}>
      <div
        data-qb-live-conv-banner="debate"
        style={{
          ...bannerStyle,
          borderColor: "var(--qb-team-debate-border, rgba(124,58,237,0.45))",
          background: "var(--qb-team-debate-bg, rgba(124,58,237,0.08))",
          color: "var(--qb-team-debate-fg, #e9d5ff)",
        }}
      >
        <div
          style={{
            ...tsLabel,
            marginBottom: 4,
            color: "var(--qb-team-debate-accent, var(--qb-team-debate-fg, #c4b5fd))",
          }}
        >
          {formatTs(ev.ts)} · {debateTitle(ev)}
        </div>
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "inherit" }}>
          {truncate(ev.text || "", maxLen)}
        </div>
      </div>
    </div>
  );
};

/**
 * Orchestrator 的"全员广播"消息（toRole=__team__）。
 *
 * 视觉上跟 DebateBanner / SystemBanner 一样走居中横幅，但保留：
 *   - 发送者头像（Orchestrator 一般是橙色）
 *   - "→ 全员（N 个角色）"的 routing tag
 *   - 真正的 plan / brief 正文，按需走 markdown 渲染（Orchestrator 多半输出 GFM）
 *
 * 这样原本会被错误染成 `__team__` 灰色头像 / 雷同 N 条的画面，被收敛成一条
 * 突出的"团队公告"，对用户阅读 + 拓扑画布展开 fan-out 都更直观。
 */
const BroadcastBanner: FC<{ ev: LiveConversationMessageEvent; maxLen: number }> = ({
  ev,
  maxLen,
}) => {
  const { t } = useTranslation();
  const accent = avatarColorFor(ev.fromRole).bg;
  /** payloadJson.targetRoles 在前端 hydration 已扁平到 contentText 之外；这里没拿到结构化字段，
   *  退化成只显示「→ 全员」，但保留正文。后续若要展示 N 个角色名，把 hydration 多透一个字段即可。 */
  const tagText = `${formatRoleName(ev.fromRole)}${t("team.conversation.broadcastSuffix")}${
    ev.messageKind ? ` · ${ev.messageKind}` : ""
  }`;
  const rawContent = ev.contentText || t("team.conversation.noTextContent");
  const content = truncate(rawContent, maxLen);
  const useMarkdown = looksLikeMarkdown(content);

  return (
    <div style={bannerWrapStyle}>
      <div
        data-qb-live-conv-banner="broadcast"
        style={{
          ...bannerStyle,
          width: "min(96%, 720px)",
          borderStyle: "solid",
          borderColor: "rgba(245,158,11,0.45)",
          background: "rgba(245,158,11,0.06)",
          color: "var(--qb-body-fg, #f4f4f5)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 4,
          }}
        >
          <Avatar role={ev.fromRole} size={20} />
          <div style={{ ...tsLabel }}>
            {formatTs(ev.ts)} · <span style={{ color: accent, fontWeight: 600 }}>{tagText}</span>
          </div>
        </div>
        {useMarkdown ? (
          <MarkdownBubble text={content} />
        ) : (
          <div style={{ fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{content}</div>
        )}
      </div>
    </div>
  );
};

const SystemBanner: FC<{ ev: LiveConversationSystemEvent; maxLen: number }> = ({ ev, maxLen }) => {
  const { t } = useTranslation();
  return (
    <div style={bannerWrapStyle}>
      <div
        data-qb-live-conv-banner="system"
        style={{
          ...bannerStyle,
          borderColor:
            "var(--qb-team-live-feed-row-border, var(--qb-sidebar-border, rgba(161,161,170,0.35)))",
          background:
            "var(--qb-main-card-bg, var(--qb-sidebar-explorer-bg, rgba(63,63,70,0.25)))",
          color: "var(--qb-body-fg, #d4d4d8)",
        }}
      >
        <div style={{ ...tsLabel, marginBottom: 4 }}>
          {formatTs(ev.ts)} · {t("team.conversation.systemTag")}
        </div>
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "inherit" }}>
          {truncate(ev.text || "", maxLen)}
        </div>
      </div>
    </div>
  );
};

const bannerWrapStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
};

const bannerStyle: CSSProperties = {
  width: "min(92%, 560px)",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px dashed",
};

/**
 * 把 "hsl(..)" 或 "#rrggbb" 大致转成 "r,g,b" 字符串供半透明边框用。
 * 失败返回 "NaN,NaN,NaN" → 调用方 fallback。
 */
function hexToRgbStr(color: string): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (color.length === 7) {
      r = parseInt(color.slice(1, 3), 16);
      g = parseInt(color.slice(3, 5), 16);
      b = parseInt(color.slice(5, 7), 16);
    } else {
      r = parseInt(color[1]! + color[1]!, 16);
      g = parseInt(color[2]! + color[2]!, 16);
      b = parseInt(color[3]! + color[3]!, 16);
    }
    return `${r}, ${g}, ${b}`;
  }
  if (color.startsWith("hsl")) {
    return "96, 165, 250";
  }
  return "NaN,NaN,NaN";
}
