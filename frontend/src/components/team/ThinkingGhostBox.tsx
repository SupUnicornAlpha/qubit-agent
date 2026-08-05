import { type CSSProperties, type FC, useEffect, useState } from "react";

export type LiveReasoningState = {
  text: string;
  status: "streaming" | "done";
  role?: string;
};

type Props = {
  reasoning: LiveReasoningState | null;
};

/**
 * DeepSeek 式「思考」虚框：不进正文气泡。
 * - streaming：展开流式展示本轮 reasoning_content
 * - done（正文已开始或本轮收口）：默认折叠为「已深度思考」；可点开回看
 * 下一轮思考到来时由父级替换整段 text（不是追加历史）。
 */
export const ThinkingGhostBox: FC<Props> = ({ reasoning }) => {
  const text = reasoning?.text?.trim() ?? "";
  const streaming = reasoning?.status === "streaming";
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!text) return;
    setExpanded(streaming);
  }, [streaming, text]);

  if (!text) return null;

  return (
    <div
      data-qb-thinking-ghost
      style={styles.root}
      aria-live={streaming ? "polite" : "off"}
    >
      <style>{`@keyframes qb-thinking-pulse{0%{box-shadow:0 0 0 0 rgba(96,165,250,.45)}70%{box-shadow:0 0 0 6px rgba(96,165,250,0)}100%{box-shadow:0 0 0 0 rgba(96,165,250,0)}}`}</style>
      <button
        type="button"
        style={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span style={styles.chevron} aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={styles.title}>
          {streaming ? "深度思考中…" : "已深度思考"}
        </span>
        {streaming ? <span style={styles.pulse} aria-hidden /> : null}
      </button>
      {expanded ? (
        <div style={styles.body}>
          {text}
          {streaming ? <span style={styles.caret}>▌</span> : null}
        </div>
      ) : null}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    margin: "8px 12px 4px",
    border: "1px dashed rgba(148, 163, 184, 0.45)",
    borderRadius: 10,
    background: "rgba(148, 163, 184, 0.06)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "8px 12px",
    border: "none",
    background: "transparent",
    color: "rgba(148, 163, 184, 0.95)",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "left",
  },
  chevron: {
    fontSize: 10,
    opacity: 0.8,
  },
  title: {
    letterSpacing: "0.02em",
  },
  pulse: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "rgba(96, 165, 250, 0.85)",
    boxShadow: "0 0 0 0 rgba(96, 165, 250, 0.5)",
    animation: "qb-thinking-pulse 1.4s ease-out infinite",
  },
  body: {
    padding: "0 12px 10px 28px",
    color: "rgba(148, 163, 184, 0.82)",
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 220,
    overflowY: "auto",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  caret: {
    opacity: 0.55,
    marginLeft: 1,
  },
};
