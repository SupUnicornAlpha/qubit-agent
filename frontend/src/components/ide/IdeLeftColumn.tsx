import type { CSSProperties, FC, ReactNode } from "react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { IdeIndicatorIdePanel } from "./IdeIndicatorIdePanel";

export const IdeLeftColumn: FC<{ renderChat: () => ReactNode }> = ({ renderChat }) => {
  const ideLeftTab = useAppStore((s) => s.ideLeftTab);
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);
  const { t } = useTranslation();

  return (
    <div style={styles.root}>
      <div style={styles.tabsWrap} role="tablist" aria-label={t("ide.leftColumn.ariaLabel")}>
        <div className="qb-segmented qb-segmented--inline" style={styles.segmented}>
          <button
            type="button"
            role="tab"
            aria-selected={ideLeftTab === "chat"}
            className={`qb-segmented__tab${ideLeftTab === "chat" ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setIdeLeftTab("chat")}
          >
            {t("ide.leftColumn.chat")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={ideLeftTab === "indicator"}
            className={`qb-segmented__tab${ideLeftTab === "indicator" ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setIdeLeftTab("indicator")}
          >
            {t("ide.leftColumn.indicator")}
          </button>
        </div>
      </div>
      <div style={styles.body}>
        {ideLeftTab === "chat" ? renderChat() : <IdeIndicatorIdePanel />}
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
