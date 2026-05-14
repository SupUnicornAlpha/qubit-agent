import type { CSSProperties, FC, ReactNode } from "react";
import { useAppStore } from "../../store";
import { IdeIndicatorIdePanel } from "./IdeIndicatorIdePanel";

export const IdeLeftColumn: FC<{ renderChat: () => ReactNode }> = ({ renderChat }) => {
  const ideLeftTab = useAppStore((s) => s.ideLeftTab);
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);

  return (
    <div style={styles.root}>
      <div style={styles.tabsWrap} role="tablist" aria-label="左侧工作台模式">
        <div className="qb-segmented qb-segmented--inline" style={styles.segmented}>
          <button
            type="button"
            role="tab"
            aria-selected={ideLeftTab === "chat"}
            className={`qb-segmented__tab${ideLeftTab === "chat" ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setIdeLeftTab("chat")}
          >
            对话工作台
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={ideLeftTab === "indicator"}
            className={`qb-segmented__tab${ideLeftTab === "indicator" ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setIdeLeftTab("indicator")}
          >
            指标 IDE
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
    borderBottom: "1px solid #27272a",
    background: "#0c0c0e",
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
