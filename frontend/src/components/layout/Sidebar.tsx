import type { FC } from "react";
import { PanelRight, Sparkles } from "lucide-react";
import { useAppStore, type ConfigSubPage, type ExplorerSection, type QuantTab } from "../../store";
import type { NavKey } from "../../lib/navIcons";
import { NavGlyph } from "../../lib/navIcons";
import { useTranslation } from "../../i18n";
import { ExplorerAssetsPanel } from "../../shell/pro/ExplorerAssetsPanel";
import { ExplorerSessionsPanel } from "../../shell/pro/ExplorerSessionsPanel";
import { ExplorerWorkspaceTree } from "../../shell/pro/ExplorerWorkspaceTree";
import { listPagesForShell } from "../../pages/registry";

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
  { id: "plugins", i18nKey: "sidebar.config.plugins" },
  { id: "mcp", i18nKey: "sidebar.config.mcp" },
  { id: "skills", i18nKey: "sidebar.config.skills" },
  { id: "agent", i18nKey: "sidebar.config.agent" },
  { id: "providers", i18nKey: "sidebar.config.providers" },
  { id: "integration", i18nKey: "sidebar.config.integration" },
  { id: "schedule", i18nKey: "sidebar.config.schedule" },
  { id: "env", i18nKey: "sidebar.config.env" },
];

/** 专业壳页面入口：与 registry 同源，永不露出独立对话页。 */
function proNavPages() {
  return listPagesForShell("pro").filter((p) => p.id !== "chat");
}

const ACTIVITY_BAR_WIDTH = 52;

export const Sidebar: FC<{ fill?: boolean }> = ({ fill = false }) => {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const explorerOpen = useAppStore((s) => s.explorerOpen);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const explorerSection = useAppStore((s) => s.explorerSection);
  const setExplorerSection = useAppStore((s) => s.setExplorerSection);
  const configSubPage = useAppStore((s) => s.configSubPage);
  const setConfigSubPage = useAppStore((s) => s.setConfigSubPage);
  const quantTab = useAppStore((s) => s.quantTab);
  const setQuantTab = useAppStore((s) => s.setQuantTab);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const toggleAgentPanelOpen = useAppStore((s) => s.toggleAgentPanelOpen);
  const { t } = useTranslation();
  const navPages = proNavPages();
  const activePage = navPages.find((p) => p.id === activeView) ?? navPages[0];
  const activeLabel = activePage ? t(activePage.titleKey) : t("sidebar.nav.team");

  const goNav = (key: NavKey) => {
    if (key === "chat") {
      // 对话常驻右侧 Agent，不再进独立页
      if (!agentPanelOpen) toggleAgentPanelOpen();
      setActiveView("team");
      return;
    }
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
        ...(fill
          ? styles.navFill
          : {
              width: explorerOpen ? ACTIVITY_BAR_WIDTH + 208 : ACTIVITY_BAR_WIDTH,
              minWidth: explorerOpen ? ACTIVITY_BAR_WIDTH + 208 : ACTIVITY_BAR_WIDTH,
            }),
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
        {navPages.map((page) => {
          const key = page.id as NavKey;
          const label = t(page.titleKey);
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => onActivityClick(key)}
              title={activityTitle(label, key)}
              aria-label={label}
              aria-current={activeView === page.id ? "page" : undefined}
              aria-expanded={activeView === page.id ? explorerOpen : undefined}
              className={[
                "qb-nav-activity-btn",
                activeView === page.id ? "qb-nav-activity-btn--active" : "",
                activeView === page.id && !explorerOpen ? "qb-nav-activity-btn--explorer-collapsed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span style={styles.activityIcon}>
                <NavGlyph navKey={key} size={18} />
              </span>
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className={[
            "qb-nav-activity-btn",
            agentPanelOpen ? "qb-nav-activity-btn--active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={t("proShell.agent.toggleTitle")}
          aria-label={t("proShell.agent.toggleTitle")}
          aria-pressed={agentPanelOpen}
          onClick={() => toggleAgentPanelOpen()}
        >
          <span style={styles.activityIcon}>
            <PanelRight size={18} strokeWidth={2} />
          </span>
        </button>
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
          <div className="qb-explorer-sections" role="tablist" aria-label={t("proShell.explorer.sectionsAria")}>
            {(
              [
                ["pages", t("proShell.explorer.pages")],
                ["sessions", t("proShell.explorer.sessions")],
                ["workspace", t("proShell.explorer.workspace")],
                ["assets", t("proShell.explorer.assets")],
              ] as const satisfies ReadonlyArray<readonly [ExplorerSection, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={explorerSection === id}
                onClick={() => setExplorerSection(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {explorerSection === "sessions" ? <ExplorerSessionsPanel /> : null}
          {explorerSection === "workspace" ? <ExplorerWorkspaceTree /> : null}
          {explorerSection === "assets" ? <ExplorerAssetsPanel /> : null}
          {explorerSection === "pages" ? (
            <div style={{ ...styles.pagesScroll }}>
              <div style={styles.group}>
                <div className="qb-sidebar-muted-text" style={styles.groupTitle}>
                  {t("sidebar.group.nav")}
                </div>
                {navPages.map((page) => (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => goNav(page.id as NavKey)}
                    className={`qb-nav-row${activeView === page.id ? " qb-nav-row--active" : ""}`}
                  >
                    <span style={styles.icon}>
                      <NavGlyph navKey={page.id as NavKey} size={16} />
                    </span>
                    <span style={styles.label}>{t(page.titleKey)}</span>
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
  navFill: {
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    flexShrink: 1,
    transition: "none",
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
    flex: 1,
    minWidth: 120,
    width: "auto",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  pagesScroll: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    paddingBottom: 12,
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
