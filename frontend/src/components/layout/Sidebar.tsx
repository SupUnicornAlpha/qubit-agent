import type { FC } from "react";
import { useAppStore, type ConfigSubPage } from "../../store";
import type { NavKey } from "../../lib/navIcons";
import { NavGlyph } from "../../lib/navIcons";

const CONFIG_CENTER_SUB: readonly { id: ConfigSubPage; label: string }[] = [
  { id: "llm", label: "LLM" },
  { id: "datasources", label: "数据源" },
  { id: "mcp", label: "MCP" },
  { id: "agent", label: "Agent" },
  { id: "integration", label: "集成 / IM" },
  { id: "schedule", label: "定时任务" },
];

const NAV_ITEMS: readonly { label: string; key: NavKey }[] = [
  { label: "研究工作台", key: "ide" },
  { label: "K 线", key: "chart" },
  { label: "对话", key: "chat" },
  { label: "研究团队", key: "team" },
  { label: "实时交易Agent", key: "trader" },
  { label: "运行监控", key: "monitor" },
  { label: "配置中心", key: "config" },
];

export const Sidebar: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const configSubPage = useAppStore((s) => s.configSubPage);
  const setConfigSubPage = useAppStore((s) => s.setConfigSubPage);
  const activeItem = NAV_ITEMS.find((n) => n.key === activeView) ?? NAV_ITEMS[0];

  const goNav = (key: NavKey) => {
    setActiveView(key);
    if (key === "config") setConfigSubPage("llm");
  };

  return (
    <nav style={styles.nav}>
      <div style={styles.activityBar}>
        <div style={styles.activityBrand}>Q</div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => goNav(item.key)}
            title={item.label}
            style={{
              ...styles.activityItem,
              ...(activeView === item.key ? styles.activityItemActive : {}),
            }}
          >
            <span style={styles.activityIcon}>
              <NavGlyph navKey={item.key} size={18} />
            </span>
          </button>
        ))}
      </div>
      <div style={styles.explorer}>
        <div style={styles.brand}>
          <div style={styles.brandTitle}>Explorer</div>
          <div style={styles.brandMeta}>IDE 工作台</div>
        </div>
        <div style={styles.group}>
          <div style={styles.groupTitle}>导航</div>
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => goNav(item.key)}
              style={{
                ...styles.item,
                ...(activeView === item.key ? styles.itemActive : {}),
              }}
            >
              <span style={styles.icon}>
                <NavGlyph navKey={item.key} size={16} />
              </span>
              <span style={styles.label}>{item.label}</span>
            </button>
          ))}
        </div>
        {activeView === "config" ? (
          <div style={styles.group}>
            <div style={styles.groupTitle}>配置子项</div>
            {CONFIG_CENTER_SUB.map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => {
                  setActiveView("config");
                  setConfigSubPage(sub.id);
                }}
                style={{
                  ...styles.item,
                  ...(configSubPage === sub.id ? styles.itemActive : {}),
                }}
              >
                <span style={styles.label}>{sub.label}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div style={styles.group}>
          <div style={styles.groupTitle}>当前上下文</div>
          <div style={styles.contextCard}>
            <div style={styles.contextTitle}>{activeItem.label}</div>
            <div style={styles.contextMeta}>
              模块：{activeItem.key}
              {activeView === "config" ? ` · ${configSubPage}` : ""}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
};

const styles: Record<string, React.CSSProperties> = {
  nav: {
    width: 260,
    minWidth: 260,
    background: "#18181b",
    borderRight: "1px solid #27272a",
    display: "flex",
    flexDirection: "row",
    padding: 0,
    flexShrink: 0,
  },
  activityBar: {
    width: 52,
    borderRight: "1px solid #27272a",
    background: "#111114",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "10px 6px",
  },
  activityBrand: {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "1px solid #3f3f46",
    color: "#a78bfa",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 800,
    marginBottom: 4,
    background: "#18181b",
  },
  activityItem: {
    width: 34,
    height: 34,
    borderRadius: 8,
    border: "1px solid transparent",
    background: "transparent",
    color: "#71717a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  activityItemActive: {
    background: "#1f2937",
    borderColor: "#3b82f6",
    color: "#e4e4e7",
  },
  activityIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 0,
  },
  explorer: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
  brand: {
    padding: "10px 12px 10px",
    borderBottom: "1px solid #27272a",
  },
  brandTitle: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#71717a",
  },
  brandMeta: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 600,
    color: "#e4e4e7",
  },
  group: { padding: "10px 8px 0" },
  groupTitle: {
    fontSize: 10,
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    padding: "0 8px 6px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    textDecoration: "none",
    color: "#a1a1aa",
    fontSize: 13,
    transition: "background 0.15s, color 0.15s",
    borderRadius: 6,
    margin: "1px 0",
    border: "none",
    textAlign: "left",
    cursor: "pointer",
    background: "transparent",
  },
  itemActive: {
    background: "#27272a",
    color: "#e4e4e7",
  },
  icon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    minWidth: 22,
    lineHeight: 0,
    color: "inherit",
  },
  label: {},
  contextCard: {
    border: "1px solid #27272a",
    background: "#111114",
    borderRadius: 8,
    padding: "8px 10px",
  },
  contextTitle: { fontSize: 12, fontWeight: 600, color: "#e4e4e7" },
  contextMeta: { marginTop: 4, fontSize: 11, color: "#71717a" },
};
