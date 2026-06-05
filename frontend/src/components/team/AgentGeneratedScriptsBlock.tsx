import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listStrategyScripts } from "../../api/backend";
import type { IndicatorStrategyScriptRecord } from "../../api/types";
import { useTranslation } from "../../i18n";

export interface AgentGeneratedScriptsBlockProps {
  /**
   * 当前研究项目的默认 session id（chat_session.id）。
   * - 空：组件展示「请先选择会话」空态，不发请求
   * - 非空：组件按 sessionId + workflowRunId 拉 indicator_strategy_script
   */
  sessionId: string;
  /**
   * 当前选中的工作流 ID（workflow_run.id）。
   * - 非空：服务端按 workflow_run_id 过滤
   * - 空：组件展示「请先选择工作流」空态，不发请求
   */
  workflowRunId: string;
  defaultOpen?: boolean;
  /**
   * 渲染外壳：
   *   - "details"（默认）：`<details>` 折叠器
   *   - "bare"：去掉外壳，仅渲染 body（父级 tab 控制可见性）
   */
  chrome?: "details" | "bare";
  /** 脚本数量变化时回调，给父级 tab 显示真实徽章 count。 */
  onCountChange?: (count: number) => void;
}

/**
 * 研究团队右侧栏 — 「Agent 生成的脚本」可折叠块。
 *
 * 数据来源（不同于「策略」tab！）：
 *   indicator_strategy_script 表 —— 这是 post-fusion pipeline 里
 *   `persistStrategyScript()` 落地的可执行 Python 策略脚本（带 on_bar 签名）。
 *
 * 与「策略」(strategy_version) tab 的区分：
 *   - 「策略」tab 读 strategy_version：只有 Agent 显式调 qubit.research.version_strategy
 *     或真实 paper/live 下单触发 ensureStrategyVersionForScript 时才有数据
 *   - 本 tab 读 indicator_strategy_script：研究流水线 research/backtest_engineer slot
 *     输出 ```python on_bar(ctx, bar)``` 代码块就会落库
 *
 * 之前老的「策略与代码」details 块（MainContent.tsx 老版本）就是消费这张表的，
 * 删掉后 research 产物不可见 → 这里把它做成 4th tab 回插。
 *
 * 注意：API 走 `/api/v1/chat/sessions/{sessionId}/strategy-scripts?workflowRunId=...`，
 * 服务端已按 workflow_run_id 过滤；workflow_run_id IS NULL 的存量数据不展示。
 */
export const AgentGeneratedScriptsBlock: FC<AgentGeneratedScriptsBlockProps> = ({
  sessionId,
  workflowRunId,
  defaultOpen = true,
  chrome = "details",
  onCountChange,
}) => {
  const { t } = useTranslation();
  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!sessionId || !workflowRunId) {
      setScripts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const rows = await listStrategyScripts(sessionId, { workflowRunId });
      setScripts(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, workflowRunId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [workflowRunId, sessionId]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return scripts
      .filter((s) => {
        if (!kw) return true;
        return (
          s.name.toLowerCase().includes(kw) ||
          s.purpose.toLowerCase().includes(kw)
        );
      })
      .sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
  }, [scripts, keyword]);

  const selected = useMemo(
    () => filtered.filter((s) => selectedIds.has(s.id)),
    [filtered, selectedIds]
  );

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    onCountChange?.(scripts.length);
  }, [scripts.length, onCountChange]);

  const handleCopy = useCallback(async (script: IndicatorStrategyScriptRecord) => {
    try {
      await navigator.clipboard.writeText(script.signalCode ?? "");
      setCopiedId(script.id);
      setTimeout(() => {
        setCopiedId((cur) => (cur === script.id ? null : cur));
      }, 1500);
    } catch {
      /** 复制失败保持静默：没有 clipboard 权限场景太常见，不打扰用户 */
    }
  }, []);

  const summaryLabel =
    selected.length > 0
      ? t("team.scriptsBlock.summaryWithSelection", {
          n: filtered.length,
          selected: selected.length,
        })
      : t("team.scriptsBlock.summary", { n: filtered.length });

  const body = (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <span style={styles.scopeHint}>{t("team.scriptsBlock.scopeBadge")}</span>
        <input
          style={styles.searchInput}
          placeholder={t("team.scriptsBlock.searchPlaceholder")}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          disabled={!workflowRunId}
        />
        <button
          type="button"
          className="qb-btn-secondary"
          style={styles.refreshBtn}
          onClick={() => void reload()}
          disabled={loading || !workflowRunId}
        >
          {loading ? t("team.scriptsBlock.refreshing") : t("team.scriptsBlock.refresh")}
        </button>
      </div>

      <p style={styles.scopeMuted}>{t("team.scriptsBlock.scopeHint")}</p>

      {error ? <div style={styles.error}>{error}</div> : null}
      {!error && filtered.length === 0 ? (
        <div style={styles.empty}>
          {!sessionId
            ? t("team.scriptsBlock.emptyNoSession")
            : !workflowRunId
              ? t("team.scriptsBlock.emptyNoWorkflow")
              : t("team.scriptsBlock.emptyNoOutput")}
        </div>
      ) : null}

      <div style={styles.list}>
        {filtered.map((s) => {
          const checked = selectedIds.has(s.id);
          return (
            <label
              key={s.id}
              style={{ ...styles.row, ...(checked ? styles.rowChecked : null) }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(s.id)}
                style={styles.checkbox}
              />
              <div style={styles.rowMain}>
                <div style={styles.rowTitle}>
                  <span style={styles.rowName}>{s.name}</span>
                  <span style={styles.badge}>{s.purpose}</span>
                </div>
                <div style={styles.rowMeta}>
                  {t("team.scriptsBlock.createdAt", {
                    at: new Date(s.createdAt).toLocaleString(),
                  })}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {selected.length > 0 ? (
        <div style={styles.cards}>
          {selected.map((s) => {
            const code = s.signalCode ?? "";
            const isCopied = copiedId === s.id;
            return (
              <article key={s.id} style={styles.card}>
                <header style={styles.cardHead}>
                  <div style={styles.cardTitle}>{s.name}</div>
                  <div style={styles.cardHeadMeta}>
                    <span style={styles.badge}>{s.purpose}</span>
                  </div>
                </header>
                <div style={styles.cardSection}>
                  <div style={styles.cardLabel}>
                    {t("team.scriptsBlock.codeLabel", { n: code.length })}
                  </div>
                  <pre style={styles.codeBlock}>
                    <code>{code || "—"}</code>
                  </pre>
                </div>
                {s.aiPromptSnapshot ? (
                  <details style={styles.promptDetails}>
                    <summary style={styles.promptSummary}>
                      {t("team.scriptsBlock.promptLabel")}
                    </summary>
                    <pre style={styles.promptBlock}>{s.aiPromptSnapshot}</pre>
                  </details>
                ) : null}
                {s.artifactDir ? (
                  <div style={styles.cardSection}>
                    <div style={styles.cardLabel}>
                      {t("team.scriptsBlock.artifactLabel")}
                    </div>
                    <code style={styles.artifactPath}>{s.artifactDir}</code>
                  </div>
                ) : null}
                <div style={styles.cardFooter}>
                  <span style={styles.cardMeta}>
                    {t("team.scriptsBlock.createdAt", {
                      at: new Date(s.createdAt).toLocaleString(),
                    })}
                  </span>
                  <button
                    type="button"
                    className="qb-btn-secondary"
                    style={styles.cardBtn}
                    onClick={() => void handleCopy(s)}
                    disabled={!code}
                  >
                    {isCopied
                      ? t("team.scriptsBlock.copied")
                      : t("team.scriptsBlock.copyCode")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  if (chrome === "bare") {
    return body;
  }

  return (
    <details className="qb-mcp-details" style={styles.details} open={defaultOpen}>
      <summary style={styles.summary}>{summaryLabel}</summary>
      {body}
    </details>
  );
};

const styles: Record<string, CSSProperties> = {
  details: {
    marginBottom: 10,
    border: "1px solid var(--qb-mcp-details-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-mcp-details-bg, #111114)",
    overflow: "hidden",
  },
  summary: {
    cursor: "pointer",
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--qb-main-meta, #e4e4e7)",
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
    color: "#a1a1aa",
    background: "rgba(56, 189, 248, 0.12)",
    border: "1px solid rgba(56, 189, 248, 0.35)",
    padding: "3px 8px",
    borderRadius: 10,
    flexShrink: 0,
  },
  scopeMuted: {
    fontSize: 10,
    color: "#71717a",
    margin: "2px 0 0",
    lineHeight: 1.4,
  },
  searchInput: {
    flex: 1,
    minWidth: 80,
    background: "#0a0a0c",
    border: "1px solid #3f3f46",
    color: "#e4e4e7",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
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
    lineHeight: 1.45,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 200,
    overflow: "auto",
  },
  row: {
    display: "flex",
    gap: 6,
    alignItems: "flex-start",
    padding: "6px 6px",
    borderRadius: 6,
    cursor: "pointer",
    border: "1px solid transparent",
  },
  rowChecked: {
    background: "rgba(56, 189, 248, 0.08)",
    border: "1px solid rgba(56, 189, 248, 0.35)",
  },
  checkbox: {
    marginTop: 3,
    flexShrink: 0,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  rowTitle: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flexWrap: "wrap",
  },
  rowName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#e4e4e7",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowMeta: {
    fontSize: 10,
    color: "#71717a",
  },
  badge: {
    fontSize: 9,
    padding: "1px 6px",
    borderRadius: 10,
    background: "#27272a",
    color: "#a1a1aa",
    flexShrink: 0,
  },
  cards: {
    marginTop: 6,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  card: {
    border: "1px solid #3f3f46",
    borderRadius: 8,
    background: "#0a0a0c",
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  cardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  cardHeadMeta: {
    display: "flex",
    gap: 4,
    alignItems: "center",
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#fafafa",
  },
  cardSection: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  cardLabel: {
    fontSize: 10,
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  codeBlock: {
    margin: 0,
    background: "#050507",
    border: "1px solid #27272a",
    borderRadius: 6,
    padding: 8,
    fontSize: 11,
    color: "#e4e4e7",
    fontFamily:
      "SFMono-Regular, ui-monospace, Menlo, Consolas, 'Liberation Mono', monospace",
    maxHeight: 240,
    overflow: "auto",
    whiteSpace: "pre",
  },
  promptDetails: {
    border: "1px dashed #3f3f46",
    borderRadius: 6,
    padding: 6,
    background: "rgba(255,255,255,0.02)",
  },
  promptSummary: {
    cursor: "pointer",
    fontSize: 10,
    fontWeight: 600,
    color: "#a1a1aa",
    listStyle: "none",
  },
  promptBlock: {
    margin: "6px 0 0",
    fontSize: 10,
    color: "#a1a1aa",
    whiteSpace: "pre-wrap",
    maxHeight: 160,
    overflow: "auto",
  },
  artifactPath: {
    fontSize: 10,
    color: "#a1a1aa",
    wordBreak: "break-all",
    fontFamily:
      "SFMono-Regular, ui-monospace, Menlo, Consolas, 'Liberation Mono', monospace",
  },
  cardMeta: {
    fontSize: 10,
    color: "#71717a",
  },
  cardBtn: {
    fontSize: 10,
    padding: "3px 8px",
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
};
