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

  const tabs: Array<{ key: TabKey; label: string; count: number; accent: string }> = [
    { key: "signals", label: t("team.outputTabs.signals"), count: signalCount, accent: "#fbbf24" },
    { key: "drafts", label: t("team.outputTabs.drafts"), count: draftCount, accent: "#f59e0b" },
    { key: "factors", label: t("team.outputTabs.factors"), count: factorCount, accent: "#60a5fa" },
    {
      key: "strategies",
      label: t("team.outputTabs.strategies"),
      count: strategyCount,
      accent: "#a78bfa",
    },
    {
      key: "backtests",
      label: t("team.outputTabs.backtests"),
      count: backtestCount,
      accent: "#34d399",
    },
    { key: "scripts", label: t("team.outputTabs.scripts"), count: scriptCount, accent: "#38bdf8" },
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
              style={{
                ...styles.tabBtn,
                ...(isActive
                  ? {
                      borderColor: tab.accent,
                      color: tab.accent,
                      background: `${tab.accent}14`,
                    }
                  : null),
              }}
              onClick={() => setActive(tab.key)}
            >
              {tab.label}
              <span
                style={{
                  ...styles.badge,
                  ...(isActive
                    ? {
                        background: `${tab.accent}33`,
                        color: tab.accent,
                      }
                    : null),
                }}
              >
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
