/**
 * IDE 左栏默认表面：Workspace Monaco 文件编辑。
 * 从 Explorer / Assets 经 pendingWorkspaceFile 打开。
 */
import type { CSSProperties, FC } from "react";
import { useEffect, useState } from "react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { WorkspaceFilePane } from "../workspace/WorkspaceFilePane";

export const IdeEditorPane: FC = () => {
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);
  const pendingWorkspaceFile = useAppStore((s) => s.pendingWorkspaceFile);
  const setPendingWorkspaceFile = useAppStore((s) => s.setPendingWorkspaceFile);
  const setExplorerSection = useAppStore((s) => s.setExplorerSection);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const { t } = useTranslation();
  const [openFile, setOpenFile] = useState<{ workspaceId: string; path: string } | null>(null);

  useEffect(() => {
    if (!pendingWorkspaceFile) return;
    setOpenFile({
      workspaceId: pendingWorkspaceFile.workspaceId,
      path: pendingWorkspaceFile.path,
    });
    setPendingWorkspaceFile(null);
  }, [pendingWorkspaceFile, setPendingWorkspaceFile]);

  if (openFile) {
    return (
      <WorkspaceFilePane
        workspaceId={openFile.workspaceId}
        path={openFile.path}
        onClose={() => setOpenFile(null)}
      />
    );
  }

  return (
    <div style={styles.empty} data-qb-ide-editor-empty>
      <div style={styles.emptyTitle}>{t("ide.leftColumn.editorEmptyTitle")}</div>
      <p style={styles.emptyBody}>{t("ide.leftColumn.editorEmptyBody")}</p>
      {activeFsWorkspaceId ? (
        <p style={styles.emptyMeta}>
          WS {activeFsWorkspaceId.slice(0, 8)}…
        </p>
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
};

const styles: Record<string, CSSProperties> = {
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
