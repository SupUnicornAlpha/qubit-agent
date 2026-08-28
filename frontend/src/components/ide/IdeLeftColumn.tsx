import type { CSSProperties, FC } from "react";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";
import { MarketWatchlistPanel } from "../market/MarketWatchlistPanel";
import { IdeEditorPane } from "./IdeEditorPane";
import { IdeOutlinePanel } from "./IdeOutlinePanel";
import { listIdeLeftTools, type IdeLeftTabId } from "./ideLeftTools";

/**
 * IDE 左栏：默认展示自选/行情上下文；代码编辑器与符号大纲作为可切换工作表面。
 */
export const IdeLeftColumn: FC = () => {
  const { t } = useTranslation();
  const tools = listIdeLeftTools();
  const showTabs = tools.length > 1;
  const activeTab = useAppStore((s) => s.ideLeftTab) as IdeLeftTabId;
  const setActiveTab = useAppStore((s) => s.setIdeLeftTab);

  return (
    <div style={styles.root} data-qb-ide-left-column>
      {showTabs ? (
        <div style={styles.tabsWrap} role="tablist" aria-label={t("ide.leftColumn.ariaLabel")}>
          <div className="qb-segmented qb-segmented--inline" style={styles.segmented}>
            {tools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tool.id}
                onClick={() => setActiveTab(tool.id)}
                className={`qb-segmented__tab${activeTab === tool.id ? " qb-segmented__tab--active" : ""}`}
              >
                {t(tool.titleKey)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div style={styles.body}>
        {activeTab === "editor" ? (
          <IdeEditorPane />
        ) : activeTab === "outline" ? (
          <IdeOutlinePanel />
        ) : (
          <MarketWatchlistPanel compact />
        )}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  tabsWrap: {
    flexShrink: 0,
    padding: "8px 10px 6px",
    borderBottom: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-team-stage-bg, #0c0c0e)",
  },
  segmented: {
    width: "100%",
  },
  body: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
};
