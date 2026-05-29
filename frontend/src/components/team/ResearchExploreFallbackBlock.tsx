import type { CSSProperties, FC } from "react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { getAnalystTeamGraph } from "../../api/backend";
import type { AnalystTeamGraphInteraction } from "../../api/types";
import { splitToolCallSegments } from "../../lib/toolCallSegments";
import { MarkdownBubble } from "../chat/MarkdownBubble";
import { ToolCallSegmentCard } from "./ToolCallSegmentCard";

export interface ResearchExploreFallbackBlockProps {
  /**
   * 当前选中的工作流 ID（workflow_run.id）。
   * 空时组件不渲染（侧栏其它块还会显示空态，本块默认折叠隐藏）。
   */
  workflowRunId: string;
  /** 默认是否展开；当本块**有内容**时建议默认展开，方便用户立即看到 fallback 原因。 */
  defaultOpen?: boolean;
  /**
   * 渲染外壳样式：
   *   - "details"（默认）：`<details>` 折叠器，summary 显示数量徽章
   *   - "bare"：去掉外壳，仅渲染 body —— 由父级（如 ResearchOutputTabs）控制可见性
   */
  chrome?: "details" | "bare";
  /**
   * 当条目数变化时回调上抛 —— 父级 tab 能在 tab badge 上显示真实 count，
   * 而不必重新拉一遍数据。
   */
  onCountChange?: (count: number) => void;
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
  chrome = "details",
  onCountChange,
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
    let total = 0;
    for (const row of interactions) {
      const payload = row.payloadJson;
      if (!payload || typeof payload !== "object") continue;
      const arr = (payload as Record<string, unknown>)["draftFactorIds"];
      if (Array.isArray(arr)) total += arr.length;
    }
    return total;
  }, [interactions]);

  const llmMessages = useMemo(
    () => interactions.filter((row) => row.kind === "llm_message"),
    [interactions],
  );

  /** count 上抛：tab 形态下父级用这个值显示 tab 徽章 */
  useEffect(() => {
    onCountChange?.(llmMessages.length);
  }, [llmMessages.length, onCountChange]);

  /**
   * 多条草稿之间切换：每条草稿可能很长（含 markdown 表格），同时全部
   * 渲染会出现"上一条占满屏 → 下一条只露出标题"的尴尬。
   * 用 idx 选择当前要展示的那一条；新增草稿时默认跳到最新一条。
   */
  const [activeDraftIdx, setActiveDraftIdx] = useState(0);
  useEffect(() => {
    if (llmMessages.length === 0) {
      setActiveDraftIdx(0);
      return;
    }
    setActiveDraftIdx((cur) => {
      if (cur >= llmMessages.length) return llmMessages.length - 1;
      return cur;
    });
  }, [llmMessages.length]);
  const activeDraft = llmMessages[activeDraftIdx] ?? null;

  const body = (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <span style={styles.scopeHint}>explore fallback</span>
        <span style={styles.scopeHintMuted}>
          置信度不足或信息不充分时 Orchestrator 切到这条 fallback 链路，
          产出研究方向建议而非可执行策略
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

      {!error && llmMessages.length === 0 && !loading ? (
        <div style={styles.empty}>
          {!workflowRunId
            ? "请先选择或启动一个工作流。"
            : "本工作流未触发 explore fallback。当 Orchestrator 决定不进入策略撰写时，研究方向草稿会出现在这里。"}
        </div>
      ) : null}

      {/**
       * 多草稿切换：≥2 条时上方显示 chips 切换器；只渲染当前选中的那一条
       * markdown body，避免多条叠加时 mdHost 内滚 + 整体外滚的双层尴尬。
       */}
      {llmMessages.length > 1 ? (
        <div style={styles.draftSwitcher} role="tablist" aria-label="草稿切换">
          {llmMessages.map((row, idx) => {
            const isActive = idx === activeDraftIdx;
            return (
              <button
                key={row.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveDraftIdx(idx)}
                style={{
                  ...styles.draftChip,
                  ...(isActive ? styles.draftChipActive : null),
                }}
                title={new Date(row.createdAt).toLocaleString()}
              >
                草稿 {idx + 1}
              </button>
            );
          })}
        </div>
      ) : null}

      {activeDraft ? (
        <article key={activeDraft.id} style={styles.card}>
          <header style={styles.cardHead}>
            <span style={styles.cardBadge}>
              {activeDraft.fromRole} → {activeDraft.toRole}
            </span>
            <span style={styles.cardTime}>
              {new Date(activeDraft.createdAt).toLocaleString()}
              {llmMessages.length > 1 ? (
                <span style={{ marginLeft: 6, color: "#52525b" }}>
                  ({activeDraftIdx + 1}/{llmMessages.length})
                </span>
              ) : null}
            </span>
          </header>
          {/**
           * 渲染策略：
           *   1) 先用 splitToolCallSegments 把 `<TOOL_CALL>{...}</TOOL_CALL>` 抽出来
           *      —— 否则那一坨 JSON 会以明文塞进 markdown 正文，把整段挤成乱码（产品截图反馈过）。
           *   2) 文本段走 MarkdownBubble（含 GFM 表格 / 代码块 / 列表）。
           *   3) tool_call 段走 ToolCallSegmentCard：折叠 chip + 点开看 pretty JSON。
           *
           * 用 <pre> 是不会被解析的。
           */}
          <div style={styles.mdHost}>
            {splitToolCallSegments(stripBracketTag(activeDraft.contentText)).map((seg, idx) => (
              <Fragment key={`seg-${activeDraft.id}-${idx}`}>
                {seg.kind === "text" ? (
                  <MarkdownBubble text={seg.body} />
                ) : (
                  <ToolCallSegmentCard segment={seg} />
                )}
              </Fragment>
            ))}
          </div>
        </article>
      ) : null}

      {interactions.some((row) => row.kind === "tool_call") ? (
        <div style={styles.draftHint}>
          部分研究方向已经被解析为 <code style={styles.codeInline}>factor.draft</code>
          ，落入「因子产出」tab（status=draft）。
          {draftFactorCount > 0 ? `本轮共 ${draftFactorCount} 条。` : ""}
          后续可手动转 active 或让下一轮 research 续写表达式。
        </div>
      ) : null}
    </div>
  );

  if (chrome === "bare") {
    /** 没有 workflowRunId 时 bare 也至少给一段提示，不要纯空白 */
    if (!workflowRunId) {
      return (
        <div style={styles.body}>
          <div style={styles.empty}>请先选择或启动一个工作流。</div>
        </div>
      );
    }
    return body;
  }

  /** details 形态（旧默认）：无内容时不渲染，避免占空间 */
  if (!workflowRunId || (interactions.length === 0 && !loading && !error)) {
    return null;
  }

  const summaryLabel = `研究方向草稿（${interactions.length}${
    draftFactorCount > 0 ? ` · 已落 ${draftFactorCount} 条 draft 因子` : ""
  }）`;

  return (
    <details className="qb-mcp-details" style={styles.details} open={defaultOpen}>
      <summary style={styles.summary}>{summaryLabel}</summary>
      {body}
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
  empty: {
    fontSize: 11,
    color: "#71717a",
    padding: "8px 4px",
    lineHeight: 1.5,
  },
  draftSwitcher: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    margin: "4px 0 8px",
  },
  draftChip: {
    fontSize: 11,
    fontWeight: 500,
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #3f3f46",
    background: "transparent",
    color: "#a1a1aa",
    cursor: "pointer",
    transition: "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
  },
  draftChipActive: {
    background: "rgba(245, 158, 11, 0.18)",
    color: "#fbbf24",
    borderColor: "rgba(245, 158, 11, 0.55)",
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
  mdHost: {
    /**
     * MarkdownBubble 的字号默认 14 偏大，加一层包装把字体局部缩到 12.5
     * 与侧栏其它组件 (factor list / strategy list) 视觉对齐。
     * 同时给一个 maxHeight + 内滚，避免单条草稿撑垮整个 tab。
     */
    fontSize: 12.5,
    color: "#e4e4e7",
    maxHeight: 520,
    overflow: "auto",
    paddingRight: 4,
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
