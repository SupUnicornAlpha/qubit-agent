import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { useTranslation } from "../../i18n";
import { AgentGeneratedFactorsBlock } from "./AgentGeneratedFactorsBlock";
import { AgentGeneratedScriptsBlock } from "./AgentGeneratedScriptsBlock";
import { AgentGeneratedStrategiesBlock } from "./AgentGeneratedStrategiesBlock";
import { ResearchExploreFallbackBlock } from "./ResearchExploreFallbackBlock";
import type { FactorRecord, StrategyVersionFlatRecord } from "../../api/backend";

type TabKey = "drafts" | "factors" | "strategies" | "scripts";

export interface ResearchOutputTabsProps {
  projectId: string;
  workflowRunId: string;
  /**
   * 当前研究项目的默认 session id（chat_session.id）。
   * 用于「脚本」tab 拉 indicator_strategy_script —— 该表用 sessionId 作主键关联。
   * 空字符串则「脚本」tab 展示空态、不发请求。
   */
  sessionId: string;
  onOpenFactorInWorkbench?: (factor: FactorRecord) => void;
  onOpenStrategyInComposer?: (version: StrategyVersionFlatRecord) => void;
  /** 初始 active tab。默认 `drafts` —— 草稿块是 explore fallback 路径的唯一可见出口，优先级最高。 */
  defaultTab?: TabKey;
}

/**
 * 研究产出 tab 切换器。
 *
 * 之前右侧栏把「研究方向草稿 / Agent 生成的因子 / Agent 生成的策略」三个 block
 * 纵向堆叠在一起，屏宽窄时挤得很难看。改成 tab 后：
 *   - 一次只显示一个 block 的完整 body，垂直空间充裕（含 markdown 表格 + 代码块）
 *   - 子 block 都用 `chrome="bare"` 模式渲染，去掉自带的 details 外壳
 *   - 子 block 通过 `onCountChange` 把真实条目数上抛，tab badge 上显示 `(N)`
 *   - **不 unmount 非活跃 tab**，用 CSS `display:none` 切换：保留搜索 / 选择 / 滚动状态，
 *     切换 tab 不重新发 API 请求（除非工作流变了，子组件内部 reload 会感知）
 *
 * 四个 tab 的语义（重要！别再搞混）：
 *   - drafts     ← research_team_interaction + factor_definition.status='draft'
 *                  仅 explore fallback 路径会产
 *   - factors    ← factor_definition（workflow_run_id 严格匹配）
 *   - strategies ← strategy_version（仅 Agent 调 version_strategy 或真单触发时才有）
 *   - scripts    ← indicator_strategy_script（post-fusion pipeline 的 Python on_bar 脚本，
 *                  即 research/backtest_engineer slot 输出 ```python``` 后落库的产物。
 *                  与 strategies tab 来源不同，**别期待 research 脚本会出现在 strategies tab**）
 *
 * Tab 选择策略（自动跳转）：
 *   - 用户首次进入：保持 `defaultTab`（草稿）
 *   - 各 tab 数量变化时不自动跳转，避免「明明选了 X 突然跳到 Y」这种意外
 */
export const ResearchOutputTabs: FC<ResearchOutputTabsProps> = ({
  projectId,
  workflowRunId,
  sessionId,
  onOpenFactorInWorkbench,
  onOpenStrategyInComposer,
  defaultTab = "drafts",
}) => {
  const { t } = useTranslation();
  const [active, setActive] = useState<TabKey>(defaultTab);
  const [draftCount, setDraftCount] = useState(0);
  const [factorCount, setFactorCount] = useState(0);
  const [strategyCount, setStrategyCount] = useState(0);
  const [scriptCount, setScriptCount] = useState(0);

  const tabs: Array<{ key: TabKey; label: string; count: number; accent: string }> = [
    { key: "drafts", label: t("team.outputTabs.drafts"), count: draftCount, accent: "#f59e0b" },
    { key: "factors", label: t("team.outputTabs.factors"), count: factorCount, accent: "#60a5fa" },
    { key: "strategies", label: t("team.outputTabs.strategies"), count: strategyCount, accent: "#a78bfa" },
    { key: "scripts", label: t("team.outputTabs.scripts"), count: scriptCount, accent: "#38bdf8" },
  ];

  return (
    <div style={styles.host}>
      <div style={styles.tabBar} role="tablist" aria-label={t("team.outputTabs.ariaLabel")}>
        {tabs.map((t) => {
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(t.key)}
              style={{
                ...styles.tabBtn,
                ...(isActive
                  ? {
                      background: `${t.accent}1f`,
                      color: t.accent,
                      borderColor: `${t.accent}80`,
                    }
                  : null),
              }}
            >
              <span>{t.label}</span>
              <span
                style={{
                  ...styles.badge,
                  ...(isActive
                    ? {
                        background: `${t.accent}33`,
                        color: t.accent,
                      }
                    : null),
                }}
              >
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      {/**
       * 子 block 全部用 bare 形态挂载，display:none 切换。
       * 不 unmount 是为了保留搜索关键字 / 已选 ids / 滚动位置；
       * 副作用是初次渲染会同时拉 3 份数据，但 count 真实就拿到了。
       */}
      <div
        role="tabpanel"
        aria-hidden={active !== "drafts"}
        style={{ ...styles.panel, display: active === "drafts" ? "block" : "none" }}
      >
        <ResearchExploreFallbackBlock
          workflowRunId={workflowRunId}
          chrome="bare"
          onCountChange={setDraftCount}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={active !== "factors"}
        style={{ ...styles.panel, display: active === "factors" ? "block" : "none" }}
      >
        <AgentGeneratedFactorsBlock
          projectId={projectId}
          workflowRunId={workflowRunId}
          chrome="bare"
          onCountChange={setFactorCount}
          {...(onOpenFactorInWorkbench ? { onOpenInWorkbench: onOpenFactorInWorkbench } : {})}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={active !== "strategies"}
        style={{ ...styles.panel, display: active === "strategies" ? "block" : "none" }}
      >
        <AgentGeneratedStrategiesBlock
          projectId={projectId}
          workflowRunId={workflowRunId}
          chrome="bare"
          onCountChange={setStrategyCount}
          {...(onOpenStrategyInComposer ? { onOpenInComposer: onOpenStrategyInComposer } : {})}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={active !== "scripts"}
        style={{ ...styles.panel, display: active === "scripts" ? "block" : "none" }}
      >
        <AgentGeneratedScriptsBlock
          sessionId={sessionId}
          workflowRunId={workflowRunId}
          chrome="bare"
          onCountChange={setScriptCount}
        />
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  host: {
    display: "flex",
    flexDirection: "column",
    border: "1px solid var(--qb-mcp-details-border, #27272a)",
    borderRadius: 8,
    background: "var(--qb-mcp-details-bg, #111114)",
    marginBottom: 10,
    overflow: "hidden",
  },
  tabBar: {
    display: "flex",
    gap: 4,
    padding: "8px 8px 6px",
    borderBottom: "1px solid var(--qb-mcp-details-border, #27272a)",
    background: "rgba(255, 255, 255, 0.02)",
    flexWrap: "wrap",
  },
  tabBtn: {
    flex: 1,
    minWidth: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "5px 8px",
    fontSize: 12,
    fontWeight: 600,
    color: "#a1a1aa",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 6,
    cursor: "pointer",
    transition: "background 0.12s ease, color 0.12s ease, border-color 0.12s ease",
  },
  badge: {
    minWidth: 18,
    height: 16,
    padding: "0 6px",
    borderRadius: 8,
    fontSize: 10,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(255, 255, 255, 0.08)",
    color: "#a1a1aa",
  },
  panel: {
    padding: "8px 12px 12px",
  },
};
