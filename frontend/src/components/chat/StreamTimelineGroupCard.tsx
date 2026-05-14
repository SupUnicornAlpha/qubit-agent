import type { CSSProperties, FC } from "react";
import { useCallback, useState } from "react";

export interface StreamTimelineStep {
  ts: number;
  label: string;
  detail: string;
}

export interface StreamTimelineGroupData {
  workflowRunId: string;
  runId: string;
  at: number;
  firstTs: number;
  roleSummary: string;
  steps: StreamTimelineStep[];
}

const btnReset: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  width: "100%",
  margin: 0,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  textAlign: "left",
  font: "inherit",
};

export const StreamTimelineGroupCard: FC<{ item: StreamTimelineGroupData }> = ({ item }) => {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const last = item.steps[item.steps.length - 1];
  const timeStr = new Date(item.at).toLocaleTimeString();
  const wfShort = item.workflowRunId.length > 10 ? `${item.workflowRunId.slice(0, 8)}…` : item.workflowRunId;

  return (
    <div style={card}>
      <button type="button" onClick={toggle} style={btnReset} aria-expanded={open}>
        <div style={headerRow}>
          <span style={caret}>{open ? "▼" : "▶"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={title}>
              Stream · {timeStr} · {item.steps.length} 条 ·{" "}
              <span style={{ color: "#71717a", fontWeight: 400 }}>workflow {wfShort}</span>
            </div>
            <div style={sub}>{item.roleSummary}</div>
            {!open && last ? (
              <div style={preview}>最后：{last.label}</div>
            ) : null}
          </div>
        </div>
      </button>
      {open ? (
        <div style={bodyScroll} role="region" aria-label="Stream 详情">
          {item.steps.map((s, i) => (
            <div key={`${s.ts}-${i}`} style={stepRow}>
              <div style={stepMeta}>
                {new Date(s.ts).toLocaleTimeString()} · {s.label}
              </div>
              <pre style={pre}>{s.detail}</pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const card: CSSProperties = {
  background: "#18181b",
  border: "1px solid #27272a",
  borderRadius: 8,
  padding: "10px 12px",
};

const headerRow: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: 8,
  alignItems: "flex-start",
};

const caret: CSSProperties = {
  flexShrink: 0,
  width: 18,
  color: "#a78bfa",
  fontSize: 12,
  lineHeight: 1.6,
};

const title: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#e4e4e7",
};

const sub: CSSProperties = {
  fontSize: 12,
  color: "#a1a1aa",
  marginTop: 2,
};

const preview: CSSProperties = {
  fontSize: 11,
  color: "#71717a",
  marginTop: 6,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const bodyScroll: CSSProperties = {
  marginTop: 10,
  maxHeight: 380,
  overflow: "auto",
  borderTop: "1px solid #27272a",
  paddingTop: 8,
};

const stepRow: CSSProperties = {
  paddingBottom: 10,
  marginBottom: 8,
  borderBottom: "1px solid #1f1f23",
};

const stepMeta: CSSProperties = {
  fontSize: 11,
  color: "#71717a",
  marginBottom: 4,
};

const pre: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "#d4d4d8",
};
