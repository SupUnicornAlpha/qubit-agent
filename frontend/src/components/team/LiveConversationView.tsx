import type { CSSProperties, FC, ReactNode } from "react";
import { useMemo } from "react";
import { avatarColorFor, avatarLabelFor, formatRoleName } from "./conversationAvatar";

/**
 * 通用 IM 风格对话流。
 *
 * - `selfRole`：左右气泡的判定依据，self → 右侧黄；其他 → 左侧带头像。
 * - `events`：归一化后的对话事件，按 ts 升序排列；外部已过滤过的事件直接喂进来。
 * - debate / system 事件渲染成居中横幅卡，避免和正常 message 混淆。
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
        {emptyText ?? "暂无对话记录。"}
      </div>
    );
  }

  return (
    <div data-qb-live-conv style={containerStyle}>
      {sorted.map((ev) => {
        switch (ev.kind) {
          case "message":
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

const MessageRow: FC<{
  ev: LiveConversationMessageEvent;
  selfRole: string;
  maxLen: number;
}> = ({ ev, selfRole, maxLen }) => {
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

  const content = truncate(ev.contentText || "(无文本内容)", maxLen);

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
          maxWidth: "82%",
          minWidth: 0,
        }}
      >
        <div style={{ ...tsLabel, marginBottom: 2 }}>
          {formatTs(ev.ts)} · {tagText}
        </div>
        <div
          data-qb-live-conv-bubble={isSelf ? "self" : "other"}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            background: bubbleBg,
            border: `1px solid ${safeBorder}`,
            color: "var(--qb-team-live-feed-fg, var(--qb-body-fg, #e4e4e7))",
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            position: "relative",
          }}
        >
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
        </div>
      </div>
    </div>
  );
};

function debateTitle(ev: LiveConversationDebateEvent): string {
  switch (ev.debateType) {
    case "debate_start":
      return "辩论开始";
    case "debate_turn":
      return `辩论轮次 R${ev.round ?? "?"}${ev.stance ? ` · ${ev.stance}` : ""}${
        ev.speakerRole ? ` · ${formatRoleName(ev.speakerRole)}` : ""
      }`;
    case "debate_verdict":
      return "辩论裁决";
    case "debate_end":
      return "辩论结束";
    default:
      return ev.debateType;
  }
}

const DebateBanner: FC<{ ev: LiveConversationDebateEvent; maxLen: number }> = ({ ev, maxLen }) => {
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

const SystemBanner: FC<{ ev: LiveConversationSystemEvent; maxLen: number }> = ({ ev, maxLen }) => {
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
        <div style={{ ...tsLabel, marginBottom: 4 }}>{formatTs(ev.ts)} · 系统</div>
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
