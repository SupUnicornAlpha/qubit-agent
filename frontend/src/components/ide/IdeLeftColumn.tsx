import type { CSSProperties, FC } from "react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { IdeEditorPane } from "./IdeEditorPane";
import { IdeIndicatorIdePanel } from "./IdeIndicatorIdePanel";
import { listIdeLeftTools, type IdeLeftTabId } from "./ideLeftTools";

export const IdeLeftColumn: FC = () => {
  const ideLeftTab = useAppStore((s) => s.ideLeftTab);
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);
  const { t } = useTranslation();
  const tools = listIdeLeftTools();

  return (
    <div style={styles.root} data-qb-ide-left-column>
      <div style={styles.tabsWrap} role="tablist" aria-label={t("ide.leftColumn.ariaLabel")}>
        <div className="qb-segmented qb-segmented--inline" style={styles.segmented}>
          {tools.map((tool) => (
            <button
              key={tool.id}
              type="button"
              role="tab"
              aria-selected={ideLeftTab === tool.id}
              className={`qb-segmented__tab${ideLeftTab === tool.id ? " qb-segmented__tab--active" : ""}`}
              onClick={() => setIdeLeftTab(tool.id)}
            >
              {t(tool.titleKey)}
            </button>
          ))}
        </div>
      </div>
      <div style={styles.body}>
        <IdeLeftToolBody tab={ideLeftTab} />
      </div>
    </div>
  );
};

const IdeLeftToolBody: FC<{ tab: IdeLeftTabId }> = ({ tab }) => {
  switch (tab) {
    case "editor":
      return <IdeEditorPane />;
    case "indicator":
      return <IdeIndicatorIdePanel />;
    default:
      return <IdeEditorPane />;
  }
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
