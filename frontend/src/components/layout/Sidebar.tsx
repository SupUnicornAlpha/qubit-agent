import type { FC } from "react";
import { Sparkles } from "lucide-react";
import { useAppStore, type ConfigSubPage, type QuantTab } from "../../store";
import type { NavKey } from "../../lib/navIcons";
import { NavGlyph } from "../../lib/navIcons";
import { useTranslation } from "../../i18n";

/** 仅承载结构（id 与 i18n key），具体 label 在渲染时通过 `t()` 解析。 */
const QUANT_SUB: readonly { id: QuantTab; i18nKey: string }[] = [
  { id: "factor", i18nKey: "sidebar.quant.factor" },
  { id: "discovery", i18nKey: "sidebar.quant.discovery" },
  { id: "composer", i18nKey: "sidebar.quant.composer" },
  { id: "backtest", i18nKey: "sidebar.quant.backtest" },
  { id: "script", i18nKey: "sidebar.quant.script" },
];

const CONFIG_CENTER_SUB: readonly { id: ConfigSubPage; i18nKey: string }[] = [
  { id: "llm", i18nKey: "sidebar.config.llm" },
  { id: "datasources", i18nKey: "sidebar.config.datasources" },
  { id: "mcp", i18nKey: "sidebar.config.mcp" },
  { id: "skills", i18nKey: "sidebar.config.skills" },
  { id: "agent", i18nKey: "sidebar.config.agent" },
  { id: "providers", i18nKey: "sidebar.config.providers" },
  { id: "integration", i18nKey: "sidebar.config.integration" },
  { id: "schedule", i18nKey: "sidebar.config.schedule" },
  { id: "env", i18nKey: "sidebar.config.env" },
];

const NAV_ITEMS: readonly { key: NavKey; i18nKey: string }[] = [
  { key: "ide", i18nKey: "sidebar.nav.ide" },
  { key: "team", i18nKey: "sidebar.nav.team" },
  { key: "trader", i18nKey: "sidebar.nav.trader" },
  { key: "quant", i18nKey: "sidebar.nav.quant" },
  { key: "chart", i18nKey: "sidebar.nav.chart" },
  { key: "chat", i18nKey: "sidebar.nav.chat" },
  { key: "monitor", i18nKey: "sidebar.nav.monitor" },
  { key: "broker", i18nKey: "sidebar.nav.broker" },
  { key: "config", i18nKey: "sidebar.nav.config" },
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
  const { t } = useTranslation();
  const activeItem = NAV_ITEMS.find((n) => n.key === activeView) ?? NAV_ITEMS[0];
  const activeLabel = t(activeItem.i18nKey);

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
    return explorerOpen
      ? t("sidebar.explorer.activityHintCollapseAgain", { label })
      : t("sidebar.explorer.activityHintExpand", { label });
  };

  return (
    <nav
      className={`qb-sidebar-shell${explorerOpen ? "" : " qb-sidebar-shell--explorer-collapsed"}`}
      style={{
        ...styles.nav,
        width: explorerOpen ? SIDEBAR_WIDTH_OPEN : ACTIVITY_BAR_WIDTH,
        minWidth: explorerOpen ? SIDEBAR_WIDTH_OPEN : ACTIVITY_BAR_WIDTH,
      }}
      aria-label={t("topbar.navAriaLabel")}
    >
      <div className="qb-sidebar-activity" style={styles.activityBar}>
        <button
          type="button"
          className="qb-nav-activity-brand"
          title={explorerOpen ? t("sidebar.explorer.collapse") : t("sidebar.explorer.expand")}
          aria-label={explorerOpen ? t("sidebar.explorer.collapse") : t("sidebar.explorer.expand")}
          onClick={() => setExplorerOpen(!explorerOpen)}
        >
          <Sparkles className="qb-nav-activity-brand-icon" size={17} strokeWidth={2.25} />
        </button>
        {NAV_ITEMS.map((item) => {
          const label = t(item.i18nKey);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onActivityClick(item.key)}
              title={activityTitle(label, item.key)}
              aria-label={label}
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
          );
        })}
      </div>
      {explorerOpen ? (
        <div className="qb-explorer-panel" style={styles.explorer}>
          <div className="qb-sidebar-brand-line" style={styles.brand}>
            <div className="qb-sidebar-muted-text" style={styles.brandTitle}>
              {t("sidebar.brand.title")}
            </div>
            <div className="qb-sidebar-strong-text" style={styles.brandMeta}>
              {t("sidebar.brand.meta")}
            </div>
          </div>
          <div style={styles.group}>
            <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
              {t("sidebar.group.nav")}
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
                <span style={styles.label}>{t(item.i18nKey)}</span>
              </button>
            ))}
          </div>
          {activeView === "config" ? (
            <div style={styles.group}>
              <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
                {t("sidebar.group.configSub")}
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
                  <span style={styles.label}>{t(sub.i18nKey)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {activeView === "quant" ? (
            <div style={styles.group}>
              <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
                {t("sidebar.group.quantSub")}
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
                  <span style={styles.label}>{t(sub.i18nKey)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div style={styles.group}>
            <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
              {t("sidebar.group.currentContext")}
            </div>
            <div className="qb-context-card">
              <div className="qb-sidebar-strong-text" style={styles.contextTitle}>
                {activeLabel}
              </div>
              <div className="qb-sidebar-muted-text" style={styles.contextMeta}>
                {t("sidebar.context.moduleLabel", { name: activeLabel })}
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
