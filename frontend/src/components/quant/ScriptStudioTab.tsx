/**
 * ScriptStudioTab — 量化工作台「脚本工坊」
 *
 * 用途：让 indicator_strategy_script（Python on_bar / signalCode）成为量化工作台
 * 的一等公民，统一在量化工作台里观察、检视、跳转编辑。与 Composer 路径（因子配方）
 * 平级。
 *
 * 三栏：
 *   左：脚本列表（按 project 跨 session 拉；过滤 purpose / sessionId / workflowRunId）
 *   中：脚本详情 hero card（元数据 + on_bar 代码只读 + signal 代码只读 + AI prompt 快照）
 *   右：动作面板（跳到 Strategy IDE 编辑 / 复制代码 / 显示与本脚本绑定的 strategy_runtime）
 *
 * 说明：这里不是脚本编辑器（编辑请走研究工作台 → 左栏 Indicator tab）。
 * 这里是「项目维度只读检视 + 路由」。Composer 路径的 `kind="script"` 引用、
 * Backtest 的 scriptId 直连、Lineage 字段补齐 都列在 docs/FACTOR_RULE_STRATEGY_DESIGN.md
 * 的 backlog 里；本 tab 先做 MVP 让用户终于能在量化工作台「看到 Python 在哪」。
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getProjectStrategyScript,
  listProjectStrategyScripts,
  type QuantStrategyScriptDetail,
  type QuantStrategyScriptSummary,
} from "../../api/backend";
import { useAppStore } from "../../store";
import { useDefaultProject } from "./useDefaultProject";

type PurposeFilter = "all" | "research" | "live_trading" | "both";

/** purpose → 颜色 token 映射；与 LineageBadge 风格保持一致 */
const PURPOSE_TONE: Record<
  "research" | "live_trading" | "both",
  { label: string; dot: string; text: string; border: string; bg: string }
> = {
  research: {
    label: "Research",
    dot: "var(--qb-quant-accent-2)",
    text: "var(--qb-quant-accent-2)",
    border: "color-mix(in srgb, var(--qb-quant-accent-2) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-2) 10%, var(--qb-bg-elevated))",
  },
  live_trading: {
    label: "Live",
    dot: "var(--qb-quant-accent-5)",
    text: "var(--qb-quant-accent-5)",
    border: "color-mix(in srgb, var(--qb-quant-accent-5) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-5) 10%, var(--qb-bg-elevated))",
  },
  both: {
    label: "Both",
    dot: "var(--qb-quant-accent-3)",
    text: "var(--qb-quant-accent-3)",
    border: "color-mix(in srgb, var(--qb-quant-accent-3) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-3) 10%, var(--qb-bg-elevated))",
  },
};

export const ScriptStudioTab: FC = () => {
  const { projectId, loading: projectLoading, error: projectError } = useDefaultProject();
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);
  const setActiveStrategyScriptId = useAppStore((s) => s.setIdeActiveStrategyScriptId);

  const [scripts, setScripts] = useState<QuantStrategyScriptSummary[]>([]);
  const [purposeFilter, setPurposeFilter] = useState<PurposeFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuantStrategyScriptDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const reloadList = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const list = await listProjectStrategyScripts({
        projectId,
        ...(purposeFilter !== "all" ? { purpose: purposeFilter } : {}),
      });
      setScripts(list);
      // 自动选中第一条；保留已选中且仍在列表中的
      if (list.length > 0) {
        const stillThere = selectedId && list.some((s) => s.id === selectedId);
        if (!stillThere) setSelectedId(list[0]!.id);
      } else {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectId, purposeFilter, selectedId]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  // 单条详情按 id 拉取（含 ideCode/signalCode 全文）
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await getProjectStrategyScript(selectedId);
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const filteredScripts = scripts;
  const selected = useMemo(
    () => filteredScripts.find((s) => s.id === selectedId) ?? null,
    [filteredScripts, selectedId]
  );

  /**
   * 跳到 Strategy IDE 编辑：写入 store 的 `ideActiveStrategyScriptId`，
   * 然后建议用户切到「研究工作台」侧边栏。IDE 那侧的 `IdeIndicatorIdePanel`
   * 会自动 applyScript() 把代码回填编辑器。
   */
  const onOpenInIde = useCallback(() => {
    if (!detail) return;
    setActiveStrategyScriptId(detail.id);
    setIdeLeftTab("indicator");
    setInfo("已切到 Indicator IDE，请在左侧导航打开「研究工作台」继续编辑");
  }, [detail, setActiveStrategyScriptId, setIdeLeftTab]);

  const onCopyCode = useCallback(async (code: string, label: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setInfo(`已复制 ${label}（${code.length} 字符）到剪贴板`);
    } catch (e) {
      setError(`复制失败：${(e as Error).message}`);
    }
  }, []);

  if (projectLoading) return <div style={styles.empty}>加载默认 project…</div>;
  if (projectError) return <div style={styles.errorPanel}>项目加载失败：{projectError}</div>;
  if (!projectId) return <div style={styles.empty}>未找到默认 project，请先在「研究工作台」初始化。</div>;

  return (
    <div className="qb-quant-tab-root qb-quant-tab-root--script" data-qb-quant-tab="script" style={styles.root}>
      <aside className="qb-quant-col qb-quant-col--left" style={styles.colLeft}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>Python 脚本</strong>
          <span style={styles.muted}>{filteredScripts.length}</span>
        </div>
        <div className="qb-quant-filter-row" style={styles.filterRow}>
          <select
            value={purposeFilter}
            onChange={(e) => setPurposeFilter(e.target.value as PurposeFilter)}
            style={styles.select}
            title="按脚本用途筛选"
          >
            <option value="all">用途: 全部</option>
            <option value="research">Research</option>
            <option value="live_trading">Live</option>
            <option value="both">Both</option>
          </select>
          <button
            type="button"
            onClick={reloadList}
            disabled={busy}
            className="qb-quant-btn qb-quant-btn--ghost"
            style={styles.btnGhost}
            title="刷新列表"
          >
            ↻
          </button>
        </div>
        <div className="qb-quant-list" style={styles.list}>
          {filteredScripts.length === 0 ? (
            <div style={styles.empty}>
              {busy ? "加载中…" : "本 project 下暂无 Python 脚本"}
              {!busy ? (
                <div style={{ marginTop: 6, color: "var(--qb-text-muted)", fontSize: 11 }}>
                  在「研究工作台」左栏 Indicator tab 编辑 on_bar 即可新建。
                </div>
              ) : null}
            </div>
          ) : null}
          {filteredScripts.map((s) => {
            const tone = PURPOSE_TONE[s.purpose];
            const isActive = s.id === selectedId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={`qb-quant-script-row${isActive ? " qb-quant-script-row--active" : ""}`}
                style={{
                  ...styles.listItem,
                  ...(isActive ? styles.listItemActive : {}),
                }}
              >
                <div style={styles.listItemTop}>
                  <span
                    className="qb-quant-status-dot"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: tone.dot,
                      flexShrink: 0,
                      boxShadow: `0 0 0 2px color-mix(in srgb, ${tone.dot} 35%, transparent)`,
                    }}
                  />
                  <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.name}
                  </span>
                  <span
                    style={{
                      ...styles.purposeChip,
                      color: tone.text,
                      borderColor: tone.border,
                      background: tone.bg,
                    }}
                  >
                    {tone.label}
                  </span>
                </div>
                <div style={styles.listItemMeta}>
                  {s.signalCodeLength > 0 ? `signal ${s.signalCodeLength}c` : null}
                  {s.signalCodeLength > 0 && s.ideCodeLength > 0 ? " · " : null}
                  {s.ideCodeLength > 0 ? `ide ${s.ideCodeLength}c` : null}
                  {s.signalCodeLength === 0 && s.ideCodeLength === 0 ? "（空）" : null}
                </div>
                <div style={styles.listItemMeta}>
                  {s.sessionTitle ? `📜 ${s.sessionTitle}` : null}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="qb-quant-col qb-quant-col--mid" style={styles.colMid}>
        {selected && detail ? (
          <div className="qb-quant-script-detail qb-quant-hero-card" style={styles.heroCard}>
            <div style={styles.detailHeader}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={styles.detailTitle}>{detail.name}</strong>
                  <span
                    style={{
                      ...styles.purposeChip,
                      color: PURPOSE_TONE[detail.purpose].text,
                      borderColor: PURPOSE_TONE[detail.purpose].border,
                      background: PURPOSE_TONE[detail.purpose].bg,
                    }}
                  >
                    {PURPOSE_TONE[detail.purpose].label}
                  </span>
                </div>
                <span style={styles.muted}>
                  session: {detail.sessionTitle ?? detail.sessionId.slice(0, 8)}
                  {" · "}
                  {detail.workflowRunId
                    ? `workflow ${detail.workflowRunId.slice(0, 8)}`
                    : "无 workflow 关联"}
                  {" · "}
                  更新于 {new Date(detail.updatedAt).toLocaleString()}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={onOpenInIde}
                  className="qb-quant-btn qb-quant-btn--primary"
                  style={styles.btnPrimary}
                  title="把该脚本灌进 IDE 编辑器（去「研究工作台」左栏切到 Indicator tab）"
                >
                  在 IDE 编辑
                </button>
              </div>
            </div>

            <div style={styles.codeSectionsWrap}>
              {detail.signalCode && detail.signalCode.trim().length > 0 ? (
                <CodeBlock
                  title="signal_code · 信号代码（python_backtest_runner.py 协议）"
                  hint="返回 buy[]/sell[] 等长数组；可作为回测的 signal 源"
                  code={detail.signalCode}
                  onCopy={() => onCopyCode(detail.signalCode, "signal_code")}
                />
              ) : null}
              {detail.ideCode && detail.ideCode.trim().length > 0 ? (
                <CodeBlock
                  title="ide_code · 主代码（python_strategy_backtest_runner.py · on_bar）"
                  hint="逐 bar 回调；ctx.buy/ctx.sell + ctx.state 跨 bar 状态"
                  code={detail.ideCode}
                  onCopy={() => onCopyCode(detail.ideCode, "ide_code")}
                />
              ) : null}
              {!detail.signalCode?.trim() && !detail.ideCode?.trim() ? (
                <div style={styles.empty}>该脚本暂无代码内容。</div>
              ) : null}
              {detail.aiPromptSnapshot && detail.aiPromptSnapshot.trim().length > 0 ? (
                <CodeBlock
                  title="ai_prompt_snapshot · 产生时的 AI 提示词"
                  hint="如果脚本由 Agent 生成，这里能看到当时的 prompt"
                  code={detail.aiPromptSnapshot}
                  onCopy={() => onCopyCode(detail.aiPromptSnapshot ?? "", "ai_prompt")}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ ...styles.empty, padding: 24 }}>
            {scripts.length === 0
              ? "本 project 暂无 Python 脚本 —— 去研究工作台左栏 Indicator tab 写一个 on_bar()"
              : "从左侧选一条脚本查看代码"}
          </div>
        )}
      </section>

      <aside className="qb-quant-col qb-quant-col--right" style={styles.colRight}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>说明</strong>
        </div>
        <div style={{ padding: 12, fontSize: 11, color: "var(--qb-text-muted)", lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4 }}>
            这里是什么？
          </div>
          量化工作台里两种"策略"并存：
          <ul style={{ paddingLeft: 18, margin: "4px 0 12px" }}>
            <li>
              <strong>组合工坊</strong>：因子配方（factor + rule + 权重） — 纯 TS 执行
            </li>
            <li>
              <strong>脚本工坊（此处）</strong>：真 Python <code>on_bar()</code> — 跑
              <code>python_strategy_backtest_runner.py</code> 子进程
            </li>
          </ul>

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            在哪里编辑？
          </div>
          研究工作台 → 左栏切换到 <strong>Indicator</strong> tab → <code>IdeIndicatorIdePanel</code> 编辑器。
          点上方「在 IDE 编辑」会把当前脚本灌进去。

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            为什么这里不能编辑？
          </div>
          编辑器复杂度（Monaco + 双 buffer + AI 助手 + 保存路径）已经存在于 Indicator IDE。
          重复实现一份没意义。这里专注：项目维度只读检视、跨 session 列表、跳转入口。

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            Backlog
          </div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>scriptId → 回测直连（扩 BacktestSignalSpec.kind=&quot;script&quot;）</li>
            <li>lineage 字段（createdBy / agentInstanceId）</li>
            <li>从这里 clone / 派生新脚本</li>
            <li>组合工坊的 kind=&quot;script&quot; 直接引用本脚本</li>
          </ul>
        </div>
      </aside>

      {error ? <div style={styles.errorToast}>{error}</div> : null}
      {info ? <div style={styles.infoToast}>{info}</div> : null}
    </div>
  );
};

/** 代码块只读展示 + 一键复制 —— 没装 syntax highlighter，先用 monospace + line-numbers off */
const CodeBlock: FC<{
  title: string;
  hint?: string;
  code: string;
  onCopy: () => void;
}> = ({ title, hint, code, onCopy }) => {
  const lines = code.split("\n").length;
  return (
    <div style={styles.codeBlock}>
      <div style={styles.codeBlockHeader}>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{title}</span>
          {hint ? <span style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>{hint}</span> : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>
            {code.length}c · {lines} lines
          </span>
          <button type="button" onClick={onCopy} style={styles.btnGhost}>
            复制
          </button>
        </div>
      </div>
      <pre style={styles.pre}>
        <code style={styles.code}>{code}</code>
      </pre>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, 320px) 1fr minmax(220px, 280px)",
    height: "100%",
    minHeight: 0,
  },
  colLeft: {
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--qb-border-subtle)",
    minHeight: 0,
  },
  colMid: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "auto",
    padding: 10,
  },
  colRight: {
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--qb-border-subtle)",
    minHeight: 0,
    overflow: "auto",
  },
  colHeader: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontSize: 12,
  },
  filterRow: {
    flex: "0 0 auto",
    display: "flex",
    gap: 6,
    padding: "6px 10px 8px",
    borderBottom: "1px solid var(--qb-border-subtle)",
  },
  list: { flex: 1, minHeight: 0, overflow: "auto" },
  listItem: {
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--qb-border-subtle)",
    cursor: "pointer",
    color: "inherit",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  listItemActive: { background: "var(--qb-bg-elevated)" },
  listItemTop: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
  },
  listItemMeta: { fontSize: 10, color: "var(--qb-text-muted)" },
  purposeChip: {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 6px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    border: "1px solid",
    letterSpacing: 0.2,
    flexShrink: 0,
  },
  heroCard: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 14,
  },
  detailHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  detailTitle: { fontSize: 14, fontWeight: 600 },
  codeSectionsWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  codeBlock: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    background: "var(--qb-bg-surface)",
    overflow: "hidden",
  },
  codeBlockHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
  },
  pre: {
    margin: 0,
    padding: "10px 12px",
    maxHeight: 480,
    overflow: "auto",
    fontSize: 11,
    lineHeight: 1.55,
    fontFamily: "var(--qb-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    background: "var(--qb-bg-surface)",
  },
  code: {
    fontFamily: "inherit",
    color: "var(--qb-text-strong)",
    whiteSpace: "pre",
  },
  select: {
    fontSize: 12,
    padding: "4px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  btnPrimary: {
    padding: "4px 10px",
    fontSize: 12,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-elevated)",
    cursor: "pointer",
    color: "inherit",
  },
  btnGhost: {
    padding: "2px 8px",
    fontSize: 11,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "transparent",
    cursor: "pointer",
    color: "var(--qb-text-muted)",
  },
  empty: {
    padding: 18,
    color: "var(--qb-text-muted)",
    fontSize: 12,
    textAlign: "center",
  },
  muted: { fontSize: 11, color: "var(--qb-text-muted)" },
  errorPanel: {
    padding: 16,
    color: "var(--qb-quant-accent-5)",
    fontSize: 12,
  },
  errorToast: {
    position: "absolute",
    bottom: 18,
    right: 18,
    padding: "8px 12px",
    background: "color-mix(in srgb, var(--qb-quant-accent-5) 12%, var(--qb-bg-elevated))",
    border: "1px solid var(--qb-quant-accent-5)",
    borderRadius: 6,
    fontSize: 11,
    color: "var(--qb-quant-accent-5)",
    maxWidth: 360,
    whiteSpace: "pre-wrap",
  },
  infoToast: {
    position: "absolute",
    bottom: 18,
    right: 18,
    padding: "8px 12px",
    background: "color-mix(in srgb, var(--qb-quant-accent-3) 12%, var(--qb-bg-elevated))",
    border: "1px solid var(--qb-quant-accent-3)",
    borderRadius: 6,
    fontSize: 11,
    color: "var(--qb-quant-accent-3)",
    maxWidth: 360,
  },
};
