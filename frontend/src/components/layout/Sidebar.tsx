import type { FC } from "react";
import { useAppStore } from "../../store";

const NAV_ITEMS = [
  { label: "运行监控", icon: "⚡", key: "monitor" as const },
  { label: "配置中心", icon: "🛠️", key: "config" as const },
];

export const Sidebar: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  return (
    <nav style={styles.nav}>
      {NAV_ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => setActiveView(item.key)}
          style={{
            ...styles.item,
            ...(activeView === item.key ? styles.itemActive : {}),
          }}
        >
          <span style={styles.icon}>{item.icon}</span>
          <span style={styles.label}>{item.label}</span>
        </button>
      ))}
    </nav>
  );
};

const styles: Record<string, React.CSSProperties> = {
  nav: {
    width: 200,
    background: "#18181b",
    borderRight: "1px solid #27272a",
    display: "flex",
    flexDirection: "column",
    padding: "12px 0",
    flexShrink: 0,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 16px",
    textDecoration: "none",
    color: "#a1a1aa",
    fontSize: 14,
    transition: "background 0.15s, color 0.15s",
    borderRadius: 6,
    margin: "1px 8px",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    background: "transparent",
  },
  itemActive: {
    background: "#27272a",
    color: "#e4e4e7",
  },
  icon: { fontSize: 16, width: 20, textAlign: "center" },
  label: {},
};
