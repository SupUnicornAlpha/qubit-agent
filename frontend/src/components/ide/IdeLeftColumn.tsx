import type { CSSProperties, FC, ReactNode } from "react";
import { useAppStore } from "../../store";
import { IdeIndicatorIdePanel } from "./IdeIndicatorIdePanel";

const tabBtn: CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  fontSize: 12,
  fontWeight: 600,
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  background: "#18181b",
  color: "#71717a",
};
const tabOn: CSSProperties = {
  background: "#27272a",
  color: "#e4e4e7",
  boxShadow: "inset 0 0 0 1px #3f3f46",
};

export const IdeLeftColumn: FC<{ renderChat: () => ReactNode }> = ({ renderChat }) => {
  const ideLeftTab = useAppStore((s) => s.ideLeftTab);
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);

  return (
    <div style={styles.root}>
      <div style={styles.tabs} role="tablist" aria-label="左侧工作台模式">
        <button
          type="button"
          role="tab"
          aria-selected={ideLeftTab === "chat"}
          style={{ ...tabBtn, ...(ideLeftTab === "chat" ? tabOn : {}) }}
          onClick={() => setIdeLeftTab("chat")}
        >
          对话工作台
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={ideLeftTab === "indicator"}
          style={{ ...tabBtn, ...(ideLeftTab === "indicator" ? tabOn : {}) }}
          onClick={() => setIdeLeftTab("indicator")}
        >
          指标 IDE
        </button>
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
  tabs: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "row",
    gap: 8,
    padding: "8px 10px 6px",
    borderBottom: "1px solid #27272a",
    background: "#0c0c0e",
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
};
