import type { CSSProperties, FC } from "react";
import { useMemo, useState } from "react";
import type { ResearchCanvasToolHit } from "../../lib/researchCanvasToolLink";
import {
  estimateJsonSizeLabel,
  formatLargeJsonPreview,
  stringifyJsonFull,
} from "../../lib/formatLargeJsonPreview";
import { formatRoleName } from "./conversationAvatar";

const KIND_LABEL: Record<ResearchCanvasToolHit["kind"], string> = {
  market: "行情",
  news: "新闻",
  other: "其它",
};

function formatTs(ts: string): string {
  const m = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  if (m?.[1]) return m[1];
  const d = new Date(ts);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return ts;
}

const JsonBlock: FC<{ label: string; value: unknown; defaultOpen?: boolean }> = ({
  label,
  value,
  defaultOpen = false,
}) => {
  const preview = useMemo(() => formatLargeJsonPreview(value), [value]);
  const size = useMemo(() => estimateJsonSizeLabel(value), [value]);
  const [copied, setCopied] = useState(false);

  const copyFull = async () => {
    try {
      await navigator.clipboard.writeText(stringifyJsonFull(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be denied */
    }
  };

  return (
    <details open={defaultOpen && !preview.truncated ? true : undefined}>
      <summary style={styles.detailsSummary}>
        {label}
        <span style={styles.sizeBadge}>{size}</span>
        {preview.truncated ? <span style={styles.truncBadge}>已截断预览</span> : null}
      </summary>
      <div style={styles.preWrap}>
        <div style={styles.preToolbar}>
          <button type="button" style={styles.copyBtn} onClick={() => void copyFull()}>
            {copied ? "已复制" : "复制完整 JSON"}
          </button>
          {preview.truncated ? (
            <span style={styles.truncHint}>
              预览约 {preview.lineCount} 行 / {preview.charCount.toLocaleString()} 字符，大数组已折叠
            </span>
          ) : null}
        </div>
        <pre style={styles.pre}>{preview.text || "—"}</pre>
      </div>
    </details>
  );
};

export const ResearchToolResultsPanel: FC<{
  hits: ResearchCanvasToolHit[];
  onOpenMarket?: (hit: ResearchCanvasToolHit) => void;
  onOpenNews?: (hit: ResearchCanvasToolHit) => void;
}> = ({ hits, onOpenMarket, onOpenNews }) => {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "market" | "news" | "other">("all");

  const visible = useMemo(
    () => (filter === "all" ? hits : hits.filter((h) => h.kind === filter)),
    [hits, filter]
  );

  if (hits.length === 0) {
    return (
      <div style={styles.empty}>
        暂无工具调用。Orchestrator 或专家调用行情 / 新闻等工具后，结果会出现在这里，并可联动到行情与新闻视图。
      </div>
    );
  }

  return (
    <div style={styles.root} data-qb-research-tool-results>
      <div style={styles.toolbar}>
        {(
          [
            ["all", "全部"],
            ["market", "行情"],
            ["news", "新闻"],
            ["other", "其它"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            style={{
              ...styles.chip,
              ...(filter === id ? styles.chipActive : null),
            }}
            onClick={() => setFilter(id)}
          >
            {label}
            <span style={styles.chipCount}>
              {id === "all" ? hits.length : hits.filter((h) => h.kind === id).length}
            </span>
          </button>
        ))}
      </div>
      <div style={styles.list}>
        {visible.map((hit) => {
          const open = expanded === hit.id;
          const ok = hit.status === "success";
          const failed = hit.status === "error" || hit.status === "failed";
          const respSize = estimateJsonSizeLabel(hit.responseJson);
          return (
            <div key={hit.id} style={styles.card}>
              <button
                type="button"
                style={styles.summary}
                aria-expanded={open}
                onClick={() => setExpanded((v) => (v === hit.id ? null : hit.id))}
              >
                <span style={styles.chevron}>{open ? "▾" : "▸"}</span>
                <span
                  style={{
                    ...styles.kind,
                    color: hit.kind === "market" ? "#38bdf8" : hit.kind === "news" ? "#a78bfa" : "#a1a1aa",
                  }}
                >
                  {KIND_LABEL[hit.kind]}
                </span>
                <span style={styles.toolName}>{hit.toolName}</span>
                <span
                  style={{
                    ...styles.status,
                    color: ok ? "#4ade80" : failed ? "#f87171" : "#fbbf24",
                  }}
                >
                  {hit.status}
                </span>
                {hit.symbol ? <span style={styles.symbol}>{hit.symbol}</span> : null}
                <span style={styles.sizeBadge}>{respSize}</span>
                <span style={styles.meta}>
                  {formatRoleName(hit.agentRole)} · {formatTs(hit.createdAt)}
                  {hit.latencyMs != null ? ` · ${hit.latencyMs}ms` : ""}
                </span>
              </button>
              {(hit.kind === "market" || hit.kind === "news") && hit.symbol ? (
                <div style={styles.actions}>
                  {hit.kind === "market" && onOpenMarket ? (
                    <button type="button" style={styles.linkBtn} onClick={() => onOpenMarket(hit)}>
                      在行情视图打开
                    </button>
                  ) : null}
                  {hit.kind === "news" && onOpenNews ? (
                    <button type="button" style={styles.linkBtn} onClick={() => onOpenNews(hit)}>
                      在新闻视图打开
                    </button>
                  ) : null}
                </div>
              ) : null}
              {open ? (
                <div style={styles.detail}>
                  {hit.errorMessage ? (
                    <div style={styles.error}>错误：{hit.errorMessage}</div>
                  ) : null}
                  <JsonBlock label="请求" value={hit.requestJson} defaultOpen={false} />
                  <JsonBlock label="响应" value={hit.responseJson} defaultOpen={false} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minHeight: 0,
    flex: 1,
  },
  empty: {
    padding: "28px 16px",
    color: "var(--qb-team-meta, #a1a1aa)",
    fontSize: 12,
    lineHeight: 1.55,
    border: "1px dashed var(--qb-team-live-feed-border, #3f3f46)",
    borderRadius: 8,
  },
  toolbar: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #3f3f46",
    background: "transparent",
    color: "#a1a1aa",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  chipActive: {
    borderColor: "rgba(56,189,248,0.55)",
    background: "rgba(56,189,248,0.12)",
    color: "#e0f2fe",
  },
  chipCount: {
    fontSize: 10,
    opacity: 0.8,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    overflow: "auto",
    minHeight: 0,
    flex: 1,
    paddingBottom: 8,
  },
  card: {
    border: "1px solid #2a2a30",
    borderRadius: 8,
    background: "rgba(8,8,10,0.72)",
    overflow: "hidden",
    // 默认 flex-shrink:1 会把 70+ 条卡片压成细线；禁止收缩，交给 list 滚动。
    flexShrink: 0,
  },
  summary: {
    width: "100%",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    minHeight: 40,
    background: "transparent",
    border: "none",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  },
  chevron: { fontSize: 10, color: "#71717a", width: 10 },
  kind: { fontSize: 10, fontWeight: 700, letterSpacing: "0.04em" },
  toolName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#e4e4e7",
    fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
  },
  status: { fontSize: 10, fontWeight: 600 },
  symbol: {
    fontSize: 11,
    padding: "0 6px",
    borderRadius: 4,
    border: "1px solid rgba(56,189,248,0.35)",
    color: "#7dd3fc",
  },
  meta: { marginLeft: "auto", fontSize: 10.5, color: "#71717a" },
  actions: {
    display: "flex",
    gap: 8,
    padding: "0 10px 8px",
  },
  linkBtn: {
    fontSize: 11,
    color: "#60a5fa",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    padding: 0,
    fontFamily: "inherit",
    textDecoration: "underline",
    textUnderlineOffset: 2,
  },
  detail: {
    borderTop: "1px solid rgba(255,255,255,0.05)",
    padding: "8px 10px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  error: { fontSize: 11, color: "#fca5a5" },
  detailsSummary: {
    cursor: "pointer",
    fontSize: 11,
    color: "#a1a1aa",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  },
  sizeBadge: {
    fontSize: 10,
    color: "#71717a",
    padding: "0 5px",
    borderRadius: 4,
    border: "1px solid #3f3f46",
  },
  truncBadge: {
    fontSize: 10,
    color: "#fbbf24",
    padding: "0 5px",
    borderRadius: 4,
    border: "1px solid rgba(251,191,36,0.35)",
  },
  preWrap: {
    marginTop: 6,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 0,
  },
  preToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  copyBtn: {
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 4,
    border: "1px solid #3f3f46",
    background: "rgba(255,255,255,0.04)",
    color: "#a1a1aa",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  truncHint: { fontSize: 10, color: "#71717a" },
  pre: {
    margin: 0,
    maxHeight: 200,
    overflow: "auto",
    fontSize: 11,
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: "#cbd5e1",
    fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
    background: "rgba(0,0,0,0.28)",
    border: "1px solid rgba(255,255,255,0.05)",
    borderRadius: 6,
    padding: "8px 10px",
  },
};
