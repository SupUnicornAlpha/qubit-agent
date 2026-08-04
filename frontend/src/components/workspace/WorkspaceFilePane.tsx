/**
 * 中栏打开 Workspace FS 文件：Tokyo 编辑器预览/保存（Monaco 路线降级）。
 */
import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { getFsWorkspaceFile, putFsWorkspaceFile } from "../../api/backend";
import { inferTokyoLanguage } from "../../lib/tokyoSyntaxHighlight";
import { TokyoCodeEditor } from "../code/TokyoCodeEditor";

function languageFromPath(path: string) {
  const ext = path.includes(".") ? path.split(".").pop() : "";
  return inferTokyoLanguage(ext);
}

export const WorkspaceFilePane: FC<{
  workspaceId: string;
  path: string;
  onClose?: () => void;
}> = ({ workspaceId, path, onClose }) => {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirty = content !== baseline;
  const language = useMemo(() => languageFromPath(path), [path]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const file = await getFsWorkspaceFile(workspaceId, path);
        if (cancelled) return;
        setContent(file.content);
        setBaseline(file.content);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await putFsWorkspaceFile(workspaceId, path, content);
      setBaseline(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.root} data-qb-workspace-file-pane>
      <div style={styles.head}>
        <div style={styles.titleBlock}>
          <strong style={styles.title}>{path.split("/").pop()}</strong>
          <span style={styles.path}>{path}</span>
        </div>
        <div style={styles.actions}>
          {dirty ? <span style={styles.dirty}>未保存</span> : null}
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={styles.btn}
            disabled={loading || saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          {onClose ? (
            <button type="button" style={styles.link} onClick={onClose}>
              关闭
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      {loading ? (
        <div style={styles.meta}>加载中…</div>
      ) : (
        <TokyoCodeEditor
          value={content}
          onChange={setContent}
          language={language}
          filename={path}
          flex={1}
          minHeight={360}
          maxHeight="100%"
        />
      )}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 10,
    border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
    borderRadius: 8,
    background: "var(--qb-team-live-feed-bg, #08080a)",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    flexShrink: 0,
  },
  titleBlock: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  title: { color: "#e4e4e7", fontSize: 13 },
  path: { color: "#71717a", fontSize: 11, wordBreak: "break-all" },
  actions: { display: "flex", gap: 10, alignItems: "center", flexShrink: 0 },
  dirty: { color: "#fbbf24", fontSize: 11 },
  btn: { fontSize: 12, padding: "5px 10px" },
  link: {
    border: "none",
    background: "transparent",
    color: "#38bdf8",
    fontSize: 11,
    cursor: "pointer",
  },
  error: { color: "#fca5a5", fontSize: 12 },
  meta: { color: "#a1a1aa", fontSize: 12, padding: 12 },
};
