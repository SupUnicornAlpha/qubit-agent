import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { useTranslation } from "../../i18n";
import { AgentGeneratedBacktestsBlock } from "./AgentGeneratedBacktestsBlock";
import { AgentGeneratedFactorsBlock } from "./AgentGeneratedFactorsBlock";
import { AgentGeneratedRecommendationsBlock } from "./AgentGeneratedRecommendationsBlock";
import { AgentGeneratedScriptsBlock } from "./AgentGeneratedScriptsBlock";
import { AgentGeneratedStrategiesBlock } from "./AgentGeneratedStrategiesBlock";
import { ResearchExploreFallbackBlock } from "./ResearchExploreFallbackBlock";
import type {
  BacktestJobRecord,
  FactorRecord,
  StrategyCompositionRecord,
  StrategyVersionFlatRecord,
} from "../../api/backend";
import type { IndicatorStrategyScriptRecord } from "../../api/types";

type TabKey = "signals" | "drafts" | "factors" | "strategies" | "backtests" | "scripts";

export interface ResearchOutputTabsProps {
  projectId: string;
  workflowRunId: string;
  sessionId: string;
  onOpenFactorInWorkbench?: (factor: FactorRecord) => void;
  onOpenFactorInBacktest?: (factor: FactorRecord) => void;
  onOpenStrategyInComposer?: (version: StrategyVersionFlatRecord) => void;
  onOpenCompositionInBacktest?: (
    version: StrategyVersionFlatRecord,
    composition: StrategyCompositionRecord
  ) => void;
  onOpenBacktestInStudio?: (job: BacktestJobRecord) => void;
  onOpenScriptInWorkbench?: (script: IndicatorStrategyScriptRecord) => void;
  defaultTab?: TabKey;
}

export const ResearchOutputTabs: FC<ResearchOutputTabsProps> = ({
  projectId,
  workflowRunId,
  sessionId,
  onOpenFactorInWorkbench,
  onOpenFactorInBacktest,
  onOpenStrategyInComposer,
  onOpenCompositionInBacktest,
  onOpenBacktestInStudio,
  onOpenScriptInWorkbench,
  defaultTab = "signals",
}) => {
  const { t } = useTranslation();
  const [active, setActive] = useState<TabKey>(defaultTab);
  const [signalCount, setSignalCount] = useState(0);
  const [draftCount, setDraftCount] = useState(0);
  const [factorCount, setFactorCount] = useState(0);
  const [strategyCount, setStrategyCount] = useState(0);
  const [backtestCount, setBacktestCount] = useState(0);
  const [scriptCount, setScriptCount] = useState(0);

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "signals", label: t("team.outputTabs.signals"), count: signalCount },
    { key: "drafts", label: t("team.outputTabs.drafts"), count: draftCount },
    { key: "factors", label: t("team.outputTabs.factors"), count: factorCount },
    {
      key: "strategies",
      label: t("team.outputTabs.strategies"),
      count: strategyCount,
    },
    {
      key: "backtests",
      label: t("team.outputTabs.backtests"),
      count: backtestCount,
    },
    { key: "scripts", label: t("team.outputTabs.scripts"), count: scriptCount },
  ];

  return (
    <div style={styles.host}>
      <div style={styles.tabBar} role="tablist" aria-label={t("team.outputTabs.ariaLabel")}>
        {tabs.map((tab) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={isActive ? "qb-research-output-tab--active" : undefined}
              style={styles.tabBtn}
              onClick={() => setActive(tab.key)}
            >
              {tab.label}
              <span className="qb-research-output-badge" style={styles.badge}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        aria-hidden={active !== "signals"}
        style={{ ...styles.panel, display: active === "signals" ? "block" : "none" }}
      >
        <AgentGeneratedRecommendationsBlock
          workflowRunId={workflowRunId}
          chrome="bare"
          onCountChange={setSignalCount}
        />
      </div>

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
          {...(onOpenFactorInBacktest ? { onOpenInBacktest: onOpenFactorInBacktest } : {})}
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
          {...(onOpenCompositionInBacktest ? { onOpenCompositionInBacktest } : {})}
        />
      </div>

      <div
        role="tabpanel"
        aria-hidden={active !== "backtests"}
        style={{ ...styles.panel, display: active === "backtests" ? "block" : "none" }}
      >
        <AgentGeneratedBacktestsBlock
          projectId={projectId}
          workflowRunId={workflowRunId}
          chrome="bare"
          onCountChange={setBacktestCount}
          {...(onOpenBacktestInStudio ? { onOpenInStudio: onOpenBacktestInStudio } : {})}
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
          {...(onOpenScriptInWorkbench ? { onOpenInWorkbench: onOpenScriptInWorkbench } : {})}
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
    borderBottom: "1px solid var(--qb-mcp-details-border, #2d2d2d)",
    background: "var(--qb-team-titlebar-bg, #252526)",
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
    color: "var(--qb-team-meta, #858585)",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 4,
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
    background: "var(--qb-tint, rgba(255, 255, 255, 0.06))",
    color: "var(--qb-team-meta, #858585)",
  },
  panel: {
    padding: "8px 12px 12px",
  },
};
