import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { useTranslation } from "../../i18n";
import { describeToolCall, type ToolCallSegment } from "../../lib/toolCallSegments";

export interface ToolCallSegmentCardProps {
  segment: Extract<ToolCallSegment, { kind: "tool_call" }>;
  /**
   * 默认是否展开 JSON body。默认 false —— 草稿场景下大部分用户只关心
   * "调了什么 tool"，参数摊开会把整段挤成一坨明文。
   */
  defaultOpen?: boolean;
}

/**
 * LLM 草稿/报告里截出来的 `<TOOL_CALL>{...}</TOOL_CALL>` 块的专门渲染。
 *
 * 不再以明文 markdown 出现在正文中，而是用一张可折叠的 chip 卡片：
 *   header：tool 名 + 参数 key 概要（5 个以内）
 *   body：pretty-printed JSON（点开才显示）
 *
 * JSON 解析失败时（例如流式截断）回退到 raw 文本展示，避免内容丢失。
 */
export const ToolCallSegmentCard: FC<ToolCallSegmentCardProps> = ({
  segment,
  defaultOpen = false,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const { tool, preview } = describeToolCall(segment);
  const parsed = segment.parsed;

  const bodyText = (() => {
    if (parsed) {
      try {
        return JSON.stringify(parsed, null, 2);
      } catch {
        return segment.raw;
      }
    }
    return segment.raw;
  })();

  return (
    <div style={styles.host}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={styles.header}
        aria-expanded={open}
      >
        <span style={styles.icon} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span style={styles.badge}>tool_call</span>
        <span style={styles.toolName}>{tool}</span>
        {preview ? <span style={styles.preview}>· {preview}</span> : null}
        {parsed ? null : (
          <span style={styles.parseFailBadge} title={t("team.toolCard.parseFailTitle")}>
            raw
          </span>
        )}
      </button>
      {open ? (
        <pre style={styles.body}>
          <code>{bodyText}</code>
        </pre>
      ) : null}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  host: {
    border: "1px solid rgba(99, 102, 241, 0.35)",
    background: "rgba(67, 56, 202, 0.10)",
    borderRadius: 6,
    margin: "6px 0",
    overflow: "hidden",
  },
  header: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    background: "transparent",
    color: "#c7d2fe",
    border: "none",
    cursor: "pointer",
    fontSize: 11.5,
    textAlign: "left",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  icon: {
    fontSize: 10,
    color: "#818cf8",
    width: 10,
    flexShrink: 0,
  },
  badge: {
    fontSize: 9.5,
    fontWeight: 700,
    padding: "1px 6px",
    borderRadius: 8,
    background: "rgba(129, 140, 248, 0.18)",
    color: "#a5b4fc",
    border: "1px solid rgba(129, 140, 248, 0.45)",
    flexShrink: 0,
    letterSpacing: 0.3,
  },
  toolName: {
    color: "#e0e7ff",
    fontWeight: 600,
    flexShrink: 0,
  },
  preview: {
    color: "#94a3b8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
  },
  parseFailBadge: {
    fontSize: 9,
    padding: "1px 4px",
    borderRadius: 8,
    background: "rgba(248, 113, 113, 0.18)",
    color: "#fca5a5",
    border: "1px solid rgba(248, 113, 113, 0.4)",
    flexShrink: 0,
  },
  body: {
    margin: 0,
    padding: "8px 12px 10px",
    background: "rgba(15, 23, 42, 0.7)",
    color: "#e5e7eb",
    fontSize: 11,
    lineHeight: 1.55,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    overflow: "auto",
    maxHeight: 320,
    borderTop: "1px solid rgba(99, 102, 241, 0.25)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
};
