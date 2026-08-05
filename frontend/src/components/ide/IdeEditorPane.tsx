/**
 * IDE 左栏：Workspace 多 Tab Monaco + 相对磁盘基线的 Diff（02 U8 薄切片）。
 */
import type { CSSProperties, FC, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo } from "react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { WorkspaceFilePane } from "../workspace/WorkspaceFilePane";

export const IdeEditorPane: FC = () => {
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);
  const pendingWorkspaceFile = useAppStore((s) => s.pendingWorkspaceFile);
  const setPendingWorkspaceFile = useAppStore((s) => s.setPendingWorkspaceFile);
  const setExplorerSection = useAppStore((s) => s.setExplorerSection);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const tabs = useAppStore((s) => s.ideEditorTabs);
  const activeTabId = useAppStore((s) => s.ideActiveEditorTabId);
  const surface = useAppStore((s) => s.ideEditorSurface);
  const openIdeEditorTab = useAppStore((s) => s.openIdeEditorTab);
  const closeIdeEditorTab = useAppStore((s) => s.closeIdeEditorTab);
  const setIdeActiveEditorTabId = useAppStore((s) => s.setIdeActiveEditorTabId);
  const setIdeEditorSurface = useAppStore((s) => s.setIdeEditorSurface);
  const { t } = useTranslation();

  useEffect(() => {
    if (!pendingWorkspaceFile) return;
    openIdeEditorTab(pendingWorkspaceFile);
    setPendingWorkspaceFile(null);
  }, [pendingWorkspaceFile, openIdeEditorTab, setPendingWorkspaceFile]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId]
  );

  const onCloseTab = (e: ReactMouseEvent, tabId: string) => {
    e.stopPropagation();
    closeIdeEditorTab(tabId);
  };

  if (!activeTab) {
    return (
      <div style={styles.empty} data-qb-ide-editor-empty>
        <div style={styles.emptyTitle}>{t("ide.leftColumn.editorEmptyTitle")}</div>
        <p style={styles.emptyBody}>{t("ide.leftColumn.editorEmptyBody")}</p>
        {activeFsWorkspaceId ? (
          <p style={styles.emptyMeta}>WS {activeFsWorkspaceId.slice(0, 8)}…</p>
        ) : (
          <p style={styles.emptyMeta}>{t("ide.leftColumn.editorNeedWorkspace")}</p>
        )}
        <button
          type="button"
          className="qb-btn-secondary"
          style={styles.btn}
          onClick={() => {
            setExplorerOpen(true);
            setExplorerSection("workspace");
          }}
        >
          {t("ide.leftColumn.openExplorer")}
        </button>
      </div>
    );
  }

  return (
    <div style={styles.root} data-qb-ide-editor-pane>
      <div style={styles.tabBar} role="tablist" aria-label={t("ide.leftColumn.editorTabsAria")}>
        <div style={styles.tabsScroll}>
          {tabs.map((tab) => {
            const selected = tab.id === activeTab.id;
            const name = tab.path.split("/").pop() || tab.path;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                title={tab.path}
                style={{
                  ...styles.tab,
                  ...(selected ? styles.tabActive : null),
                }}
                onClick={() => setIdeActiveEditorTabId(tab.id)}
              >
                <span style={styles.tabLabel}>{name}</span>
                <span
                  role="button"
                  tabIndex={0}
                  style={styles.tabClose}
                  aria-label={t("ide.leftColumn.closeTab")}
                  onClick={(e) => onCloseTab(e, tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      closeIdeEditorTab(tab.id);
                    }
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
        </div>
        <div style={styles.surfaceToggle} role="group" aria-label={t("ide.leftColumn.surfaceAria")}>
          <button
            type="button"
            style={{
              ...styles.surfaceBtn,
              ...(surface === "edit" ? styles.surfaceBtnActive : null),
            }}
            onClick={() => setIdeEditorSurface("edit")}
          >
            {t("ide.leftColumn.surfaceEdit")}
          </button>
          <button
            type="button"
            style={{
              ...styles.surfaceBtn,
              ...(surface === "diff" ? styles.surfaceBtnActive : null),
            }}
            onClick={() => setIdeEditorSurface("diff")}
          >
            {t("ide.leftColumn.surfaceDiff")}
          </button>
        </div>
      </div>
      <WorkspaceFilePane
        key={activeTab.id}
        workspaceId={activeTab.workspaceId}
        path={activeTab.path}
        surface={surface}
        onClose={() => closeIdeEditorTab(activeTab.id)}
      />
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  tabBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px 0",
    borderBottom: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
    background: "var(--qb-team-stage-bg, #0c0c0e)",
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    gap: 4,
    overflowX: "auto",
    paddingBottom: 6,
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    maxWidth: 180,
    padding: "4px 8px",
    border: "1px solid transparent",
    borderRadius: "6px 6px 0 0",
    background: "transparent",
    color: "#a1a1aa",
    fontSize: 12,
    cursor: "pointer",
  },
  tabActive: {
    background: "var(--qb-team-live-feed-bg, #08080a)",
    borderColor: "var(--qb-team-live-feed-border, #2a2a30)",
    borderBottomColor: "var(--qb-team-live-feed-bg, #08080a)",
    color: "#e4e4e7",
  },
  tabLabel: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tabClose: {
    flexShrink: 0,
    width: 16,
    height: 16,
    lineHeight: "14px",
    textAlign: "center",
    borderRadius: 4,
    color: "#71717a",
    fontSize: 14,
  },
  surfaceToggle: {
    flexShrink: 0,
    display: "inline-flex",
    gap: 2,
    padding: "0 0 6px",
  },
  surfaceBtn: {
    border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
    background: "transparent",
    color: "#a1a1aa",
    fontSize: 11,
    padding: "3px 8px",
    cursor: "pointer",
    borderRadius: 4,
  },
  surfaceBtnActive: {
    background: "#27272a",
    color: "#e4e4e7",
  },
  empty: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 10,
    padding: 20,
    background: "var(--qb-team-live-feed-bg, #08080a)",
    borderTop: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--qb-text-strong, #e4e4e7)",
  },
  emptyBody: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: "var(--qb-sidebar-muted, #a1a1aa)",
    maxWidth: 360,
  },
  emptyMeta: {
    margin: 0,
    fontSize: 11,
    color: "#71717a",
  },
  btn: {
    fontSize: 12,
    marginTop: 4,
  },
};
