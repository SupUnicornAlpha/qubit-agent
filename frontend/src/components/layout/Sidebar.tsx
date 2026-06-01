import type { FC } from "react";
import { Sparkles } from "lucide-react";
import { useAppStore, type ConfigSubPage, type QuantTab } from "../../store";
import type { NavKey } from "../../lib/navIcons";
import { NavGlyph } from "../../lib/navIcons";

const QUANT_SUB: readonly { id: QuantTab; label: string }[] = [
  { id: "factor", label: "因子工坊" },
  { id: "discovery", label: "挖掘工坊" },
  { id: "composer", label: "组合工坊" },
  { id: "backtest", label: "回测工坊" },
];

const CONFIG_CENTER_SUB: readonly { id: ConfigSubPage; label: string }[] = [
  { id: "llm", label: "LLM" },
  { id: "datasources", label: "数据源" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "agent", label: "Agent" },
  { id: "providers", label: "Providers" },
  { id: "integration", label: "集成 / IM" },
  { id: "schedule", label: "定时任务" },
  { id: "env", label: "环境管理" },
];

const NAV_ITEMS: readonly { label: string; key: NavKey }[] = [
  { label: "研究工作台", key: "ide" },
  { label: "研究团队", key: "team" },
  { label: "实时交易Agent", key: "trader" },
  { label: "量化工作台", key: "quant" },
  { label: "资讯", key: "chart" },
  { label: "对话", key: "chat" },
  { label: "运行监控", key: "monitor" },
  { label: "券商账户配置", key: "broker" },
  { label: "配置中心", key: "config" },
];

const ACTIVITY_BAR_WIDTH = 52;
const EXPLORER_WIDTH = 208;
const SIDEBAR_WIDTH_OPEN = ACTIVITY_BAR_WIDTH + EXPLORER_WIDTH;

export const Sidebar: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const explorerOpen = useAppStore((s) => s.explorerOpen);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const configSubPage = useAppStore((s) => s.configSubPage);
  const setConfigSubPage = useAppStore((s) => s.setConfigSubPage);
  const quantTab = useAppStore((s) => s.quantTab);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const activeItem = NAV_ITEMS.find((n) => n.key === activeView) ?? NAV_ITEMS[0];

  const goNav = (key: NavKey) => {
    setActiveView(key);
    if (key === "config") setConfigSubPage("llm");
  };

  /** 活动栏：仅再次点击当前图标时切换 Explorer；切换其他视图不改变 Explorer 开闭 */
  const onActivityClick = (key: NavKey) => {
    if (activeView === key) {
      setExplorerOpen(!explorerOpen);
      return;
    }
    goNav(key);
  };

  const activityTitle = (label: string, key: NavKey) => {
    if (activeView !== key) return label;
    return explorerOpen ? `${label}（再次点击收起 Explorer）` : `${label}（点击展开 Explorer）`;
  };

  return (
    <nav
      className={`qb-sidebar-shell${explorerOpen ? "" : " qb-sidebar-shell--explorer-collapsed"}`}
      style={{
        ...styles.nav,
        width: explorerOpen ? SIDEBAR_WIDTH_OPEN : ACTIVITY_BAR_WIDTH,
        minWidth: explorerOpen ? SIDEBAR_WIDTH_OPEN : ACTIVITY_BAR_WIDTH,
      }}
      aria-label="主导航"
    >
      <div className="qb-sidebar-activity" style={styles.activityBar}>
        <button
          type="button"
          className="qb-nav-activity-brand"
          title={explorerOpen ? "收起 Explorer" : "展开 Explorer"}
          aria-label={explorerOpen ? "收起 Explorer" : "展开 Explorer"}
          onClick={() => setExplorerOpen(!explorerOpen)}
        >
          <Sparkles className="qb-nav-activity-brand-icon" size={17} strokeWidth={2.25} />
        </button>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onActivityClick(item.key)}
            title={activityTitle(item.label, item.key)}
            aria-label={item.label}
            aria-current={activeView === item.key ? "page" : undefined}
            aria-expanded={activeView === item.key ? explorerOpen : undefined}
            className={[
              "qb-nav-activity-btn",
              activeView === item.key ? "qb-nav-activity-btn--active" : "",
              activeView === item.key && !explorerOpen ? "qb-nav-activity-btn--explorer-collapsed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span style={styles.activityIcon}>
              <NavGlyph navKey={item.key} size={18} />
            </span>
          </button>
        ))}
      </div>
      {explorerOpen ? (
        <div className="qb-explorer-panel" style={styles.explorer}>
          <div className="qb-sidebar-brand-line" style={styles.brand}>
            <div className="qb-sidebar-muted-text" style={styles.brandTitle}>
              Explorer
            </div>
            <div className="qb-sidebar-strong-text" style={styles.brandMeta}>
              QUBIT IDE
            </div>
          </div>
          <div style={styles.group}>
            <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
              导航
            </div>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => goNav(item.key)}
                className={`qb-nav-row${activeView === item.key ? " qb-nav-row--active" : ""}`}
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
              <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
                配置子项
              </div>
              {CONFIG_CENTER_SUB.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => {
                    setActiveView("config");
                    setConfigSubPage(sub.id);
                  }}
                  className={`qb-nav-row${configSubPage === sub.id ? " qb-nav-row--active" : ""}`}
                >
                  <span style={styles.label}>{sub.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          {activeView === "quant" ? (
            <div style={styles.group}>
              <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
                量化子项
              </div>
              {QUANT_SUB.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => {
                    setActiveView("quant");
                    setQuantTab(sub.id);
                  }}
                  className={`qb-nav-row${quantTab === sub.id ? " qb-nav-row--active" : ""}`}
                >
                  <span style={styles.label}>{sub.label}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div style={styles.group}>
            <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
              当前上下文
            </div>
            <div className="qb-context-card">
              <div className="qb-sidebar-strong-text" style={styles.contextTitle}>
                {activeItem.label}
              </div>
              <div className="qb-sidebar-muted-text" style={styles.contextMeta}>
                模块：{activeItem.label}
                {activeView === "config" ? ` · ${configSubPage}` : ""}
                {activeView === "quant" ? ` · ${quantTab}` : ""}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </nav>
  );
};

const styles: Record<string, React.CSSProperties> = {
  nav: {
    display: "flex",
    flexDirection: "row",
    padding: 0,
    flexShrink: 0,
    transition: "width 0.18s ease, min-width 0.18s ease",
  },
  activityBar: {
    width: ACTIVITY_BAR_WIDTH,
    minWidth: ACTIVITY_BAR_WIDTH,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    padding: "10px 6px",
    flexShrink: 0,
  },
  activityIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 0,
  },
  explorer: {
    width: EXPLORER_WIDTH,
    minWidth: EXPLORER_WIDTH,
    flex: "0 0 auto",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  brand: {
    padding: "10px 12px 10px",
  },
  brandTitle: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  brandMeta: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: 600,
  },
  group: { padding: "10px 8px 0" },
  groupTitle: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    padding: "0 8px 6px",
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
  contextTitle: { fontSize: 12, fontWeight: 600 },
  contextMeta: { marginTop: 4, fontSize: 11 },
};
