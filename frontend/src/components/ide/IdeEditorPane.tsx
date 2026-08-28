/**
 * IDE 左栏：Workspace 多 Tab Monaco + 相对磁盘基线的 Diff（02 U8 薄切片）。
 */
import type { CSSProperties, FC, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, FileCode, ListTree } from "lucide-react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { WorkspaceFilePane } from "../workspace/WorkspaceFilePane";
import { getFsWorkspaceFile } from "../../api/backend";
import { parseCodeOutline, type CodeOutlineSymbol } from "../../lib/codeOutlineParser";

function fileBadgeFromPath(path: string): { label: string; color: string } {
  const ext = (path.includes(".") ? path.split(".").pop() : "")?.toLowerCase() || "";
  switch (ext) {
    case "py":
      return { label: "PY", color: "#38bdf8" };
    case "ts":
    case "tsx":
      return { label: "TS", color: "#60a5fa" };
    case "js":
    case "jsx":
      return { label: "JS", color: "#facc15" };
    case "json":
      return { label: "{}", color: "#a3e635" };
    case "md":
    case "markdown":
      return { label: "MD", color: "#c084fc" };
    case "sql":
      return { label: "SQL", color: "#fb923c" };
    default:
      return { label: "FILE", color: "#9ca3af" };
  }
}

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

  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);

  const [activeFileSymbols, setActiveFileSymbols] = useState<CodeOutlineSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<CodeOutlineSymbol | null>(null);

  useEffect(() => {
    if (!activeTab) return;
    let cancelled = false;
    getFsWorkspaceFile(activeTab.workspaceId, activeTab.path)
      .then((file) => {
        if (cancelled) return;
        const syms = parseCodeOutline(file.content, activeTab.path);
        setActiveFileSymbols(syms);
        setSelectedSymbol(syms[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setActiveFileSymbols([]);
          setSelectedSymbol(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

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
            const badge = fileBadgeFromPath(tab.path);
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
                <span style={{ ...styles.tabBadge, color: badge.color }}>{badge.label}</span>
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
      <div style={styles.breadcrumbBar}>
        <div style={styles.breadcrumbPath}>
          <FileCode size={11} color="#60a5fa" style={{ flexShrink: 0 }} />
          <span style={styles.breadcrumbText}>{activeTab.path}</span>
          {selectedSymbol ? (
            <>
              <ChevronRight size={11} color="#71717a" style={{ flexShrink: 0 }} />
              <span style={styles.breadcrumbSymbol}>{selectedSymbol.name}</span>
            </>
          ) : null}
        </div>
        <button
          type="button"
          style={styles.outlineToggleBtn}
          title="在侧边栏展开符号大纲 (Outline)"
          onClick={() => setIdeLeftTab("outline")}
        >
          <ListTree size={12} color="#a1a1aa" />
          <span>大纲 ({activeFileSymbols.length})</span>
        </button>
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
  tabBadge: {
    fontSize: 9,
    fontFamily: "monospace",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    padding: "1px 3px",
    background: "rgba(255, 255, 255, 0.05)",
    borderRadius: 3,
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
  breadcrumbBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "3px 10px",
    background: "var(--qb-bg-surface, #1e1e1e)",
    borderBottom: "1px solid var(--qb-separator, #2d2d2d)",
    fontSize: 11,
    minHeight: 22,
    flexShrink: 0,
  },
  breadcrumbPath: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  breadcrumbText: {
    color: "var(--qb-body-muted, #858585)",
    fontFamily: "monospace",
  },
  breadcrumbSymbol: {
    color: "var(--qb-blue, #60a5fa)",
    fontWeight: 600,
  },
  outlineToggleBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    border: "1px solid var(--qb-separator, #2d2d2d)",
    background: "var(--qb-main-input-bg, #252526)",
    color: "var(--qb-body-fg, #cccccc)",
    borderRadius: 3,
    fontSize: 10.5,
    padding: "2px 6px",
    cursor: "pointer",
    flexShrink: 0,
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
