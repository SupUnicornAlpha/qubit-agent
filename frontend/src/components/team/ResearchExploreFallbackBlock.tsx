import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAnalystTeamGraph } from "../../api/backend";
import type { AnalystTeamGraphInteraction } from "../../api/types";

export interface ResearchExploreFallbackBlockProps {
  /**
   * 当前选中的工作流 ID（workflow_run.id）。
   * 空时组件不渲染（侧栏其它块还会显示空态，本块默认折叠隐藏）。
   */
  workflowRunId: string;
  /** 默认是否展开；当本块**有内容**时建议默认展开，方便用户立即看到 fallback 原因。 */
  defaultOpen?: boolean;
}

/**
 * 展示 explore fallback 阶段产出的「研究方向草稿 / fallback 原因」。
 *
 * 数据来源：
 *   `research_team_interaction.payload_json.phase === "research_explore_fallback"`
 *   通过 `getAnalystTeamGraph(workflowRunId)` 一次性拉取整个 workflow 的交互流，
 *   前端再 filter。比单独建一个 API 端点便宜。
 *
 * 显示规则：
 *   - 没有 fallback 互动 → 整个 block 不渲染（不占空间）
 *   - 1+ fallback 互动 → 展示每条 fromRole=research → toRole=orchestrator 的
 *     markdown 草稿 + 可选的 `[explore fallback] 已落 X 条 draft 因子` 工具调用条目
 *
 * 这个 block 是 explore mode 在低信号场景下的**唯一用户可见产出**，没有它
 * 用户会以为"4 分钟跑下来什么都没产出"（实际上 LLM 写了草稿但只落在
 * research_team_interaction 表里，研究产出侧栏的因子/策略 block 都查不到）。
 */
export const ResearchExploreFallbackBlock: FC<ResearchExploreFallbackBlockProps> = ({
  workflowRunId,
  defaultOpen = true,
}) => {
  const [interactions, setInteractions] = useState<AnalystTeamGraphInteraction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!workflowRunId) {
      setInteractions([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const graph = await getAnalystTeamGraph(workflowRunId);
      const rows = (graph?.interactions ?? []).filter((row) => {
        const payload = row.payloadJson;
        if (!payload || typeof payload !== "object") return false;
        const phase = (payload as Record<string, unknown>)["phase"];
        return phase === "research_explore_fallback";
      });
      setInteractions(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workflowRunId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const draftFactorCount = useMemo(() => {
    /** 从 [explore fallback] 已落 N 条 ... 互动里抓汇总数字 */
    let total = 0;
    for (const row of interactions) {
      const payload = row.payloadJson;
      if (!payload || typeof payload !== "object") continue;
      const arr = (payload as Record<string, unknown>)["draftFactorIds"];
      if (Array.isArray(arr)) total += arr.length;
    }
    return total;
  }, [interactions]);

  /** 没有 fallback 互动直接不渲染 —— 不占空间 */
  if (!workflowRunId || (interactions.length === 0 && !loading && !error)) {
    return null;
  }

  const summaryLabel = `研究方向草稿（${interactions.length}${
    draftFactorCount > 0 ? ` · 已落 ${draftFactorCount} 条 draft 因子` : ""
  }）`;

  return (
    <details className="qb-mcp-details" style={styles.details} open={defaultOpen}>
      <summary style={styles.summary}>{summaryLabel}</summary>
      <div style={styles.body}>
        <div style={styles.toolbar}>
          <span style={styles.scopeHint}>explore fallback</span>
          <span style={styles.scopeHintMuted}>
            置信度不足或信息不充分时 Orchestrator 切到这条 fallback 链路，
            产出**研究方向建议**而非可执行策略
          </span>
          <button
            type="button"
            className="qb-btn-secondary"
            style={styles.refreshBtn}
            onClick={() => void reload()}
            disabled={loading}
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>

        {error ? <div style={styles.error}>{error}</div> : null}

        {interactions
          .filter((row) => row.kind === "llm_message")
          .map((row) => (
            <article key={row.id} style={styles.card}>
              <header style={styles.cardHead}>
                <span style={styles.cardBadge}>
                  {row.fromRole} → {row.toRole}
                </span>
                <span style={styles.cardTime}>{new Date(row.createdAt).toLocaleString()}</span>
              </header>
              <pre style={styles.body_md}>{stripBracketTag(row.contentText)}</pre>
            </article>
          ))}

        {interactions.some((row) => row.kind === "tool_call") ? (
          <div style={styles.draftHint}>
            部分研究方向已经被解析为 <code style={styles.codeInline}>factor.draft</code>
            ，落入「Agent 生成的因子」block（status=draft）。后续可手动转 active
            或让下一轮 research 续写表达式。
          </div>
        ) : null}
      </div>
    </details>
  );
};

/** `[explore fallback] …` 这种 LLM 互动前缀去掉，便于 markdown 阅读 */
function stripBracketTag(text: string): string {
  return text.replace(/^\s*\[[^\]]+\]\s*/, "").trim();
}

const styles: Record<string, CSSProperties> = {
  details: {
    marginBottom: 10,
    border: "1px solid rgba(245, 158, 11, 0.4)",
    borderRadius: 8,
    background: "rgba(120, 80, 0, 0.08)",
    overflow: "hidden",
  },
  summary: {
    cursor: "pointer",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fbbf24",
    userSelect: "none",
    listStyle: "none",
  },
  body: {
    padding: "0 12px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  toolbar: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flexWrap: "wrap",
  },
  scopeHint: {
    fontSize: 10,
    color: "#fbbf24",
    background: "rgba(245, 158, 11, 0.18)",
    border: "1px solid rgba(245, 158, 11, 0.5)",
    padding: "3px 8px",
    borderRadius: 10,
    flexShrink: 0,
  },
  scopeHintMuted: {
    fontSize: 10,
    color: "#a1a1aa",
    lineHeight: 1.45,
    flex: 1,
    minWidth: 100,
  },
  refreshBtn: {
    fontSize: 11,
    padding: "4px 8px",
  },
  error: {
    fontSize: 11,
    color: "#fca5a5",
    background: "#1f0c0c",
    border: "1px solid #7f1d1d",
    borderRadius: 6,
    padding: "6px 8px",
  },
  card: {
    background: "#111114",
    border: "1px solid #27272a",
    borderRadius: 6,
    padding: 8,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
  },
  cardBadge: {
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 10,
    background: "rgba(59, 130, 246, 0.18)",
    color: "#93c5fd",
    border: "1px solid rgba(59, 130, 246, 0.4)",
  },
  cardTime: {
    fontSize: 10,
    color: "#71717a",
  },
  body_md: {
    margin: 0,
    fontSize: 11,
    color: "#e4e4e7",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily:
      'ui-sans-serif, system-ui, "PingFang SC", "Helvetica Neue", Arial, sans-serif',
    maxHeight: 360,
    overflow: "auto",
  },
  draftHint: {
    fontSize: 11,
    color: "#a1a1aa",
    background: "rgba(59, 130, 246, 0.06)",
    border: "1px solid rgba(59, 130, 246, 0.25)",
    borderRadius: 6,
    padding: "6px 8px",
    lineHeight: 1.45,
  },
  codeInline: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 10,
    background: "rgba(255,255,255,0.05)",
    padding: "1px 4px",
    borderRadius: 3,
  },
};
