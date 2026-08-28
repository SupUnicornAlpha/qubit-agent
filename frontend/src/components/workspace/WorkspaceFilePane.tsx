/**
 * Workspace 文件：Monaco 编辑 / Diff（相对打开时的磁盘基线）。
 */
import { DiffEditor } from "@monaco-editor/react";
import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getFsWorkspaceFile, putFsWorkspaceFile } from "../../api/backend";
import type { IdeEditorSurface } from "../../store";
import { WorkspaceCodeEditor } from "./WorkspaceCodeEditor";

function langFromPath(path: string): string {
  const ext = (path.includes(".") ? path.split(".").pop() : "")?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "ini";
    case "sql":
      return "sql";
    default:
      return "plaintext";
  }
}

export const WorkspaceFilePane: FC<{
  workspaceId: string;
  path: string;
  onClose?: () => void;
  /** edit = Monaco；diff = 相对磁盘基线（打开/上次保存） */
  surface?: IdeEditorSurface;
}> = ({ workspaceId, path, onClose, surface = "edit" }) => {
  const [content, setContent] = useState("");
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dirty = content !== baseline;
  const language = useMemo(() => langFromPath(path), [path]);

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

  useEffect(() => {
    if (surface !== "diff") return;
    const host = hostRef.current;
    if (!host) return;
    const apply = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      setHostSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => ro.disconnect();
  }, [surface, loading]);

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

  const pathSegments = path.split("/").filter(Boolean);
  const fileName = pathSegments[pathSegments.length - 1] || path;
  const dirSegments = pathSegments.slice(0, -1);

  return (
    <div style={styles.root} data-qb-workspace-file-pane data-surface={surface}>
      <div style={styles.head}>
        <div style={styles.titleBlock}>
          <div style={styles.breadcrumbs}>
            <span style={styles.crumbWs}>ws:{workspaceId.slice(0, 6)}</span>
            {dirSegments.map((d, i) => (
              <span key={i} style={styles.crumbSegment}>
                <span style={styles.crumbSep}>/</span>
                {d}
              </span>
            ))}
            <span style={styles.crumbSep}>/</span>
            <strong style={styles.crumbFile}>{fileName}</strong>
          </div>
          {surface === "diff" ? (
            <span style={styles.diffHint}>左：已保存基线 · 右：当前缓冲</span>
          ) : null}
        </div>
        <div style={styles.actions}>
          {dirty ? <span style={styles.dirty}>● 未保存</span> : <span style={styles.saved}>已保存</span>}
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={styles.btn}
            disabled={loading || saving || !dirty}
            title="快捷键: ⌘S / Ctrl+S"
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存 (⌘S)"}
          </button>
          {onClose ? (
            <button type="button" style={styles.link} onClick={onClose} title="关闭文件">
              关闭
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      {loading ? (
        <div style={styles.meta}>加载中…</div>
      ) : surface === "diff" ? (
        <div ref={hostRef} style={styles.diffHost}>
          <DiffEditor
            height={hostSize.h > 0 ? hostSize.h : 360}
            width={hostSize.w > 0 ? hostSize.w : undefined}
            theme="vs-dark"
            language={language}
            original={baseline}
            modified={content}
            onMount={(ed) => {
              const modified = ed.getModifiedEditor();
              modified.onDidChangeModelContent(() => {
                setContent(modified.getValue());
              });
            }}
            options={{
              readOnly: false,
              originalEditable: false,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', Consolas, monospace",
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      ) : (
        <WorkspaceCodeEditor
          value={content}
          onChange={setContent}
          path={path}
          onSave={() => void save()}
        />
      )}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    minHeight: 0,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px",
    border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
    borderRadius: 8,
    background: "var(--qb-team-live-feed-bg, #08080a)",
    overflow: "hidden",
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    flexShrink: 0,
    paddingBottom: 4,
    borderBottom: "1px solid var(--qb-hairline, rgba(255,255,255,0.06))",
  },
  titleBlock: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  breadcrumbs: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
    color: "#a1a1aa",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  crumbWs: {
    color: "var(--qb-blue, #3b82f6)",
    fontWeight: 500,
    fontSize: 11,
    padding: "1px 4px",
    background: "var(--qb-tint, rgba(59,130,246,0.1))",
    borderRadius: 4,
  },
  crumbSegment: { color: "#71717a", fontSize: 12 },
  crumbSep: { color: "#52525b", margin: "0 1px" },
  crumbFile: { color: "#f4f4f5", fontWeight: 600 },
  diffHint: { color: "#71717a", fontSize: 10 },
  actions: { display: "flex", gap: 8, alignItems: "center", flexShrink: 0 },
  dirty: { color: "#fbbf24", fontSize: 11, fontWeight: 500 },
  saved: { color: "#71717a", fontSize: 11 },
  btn: { fontSize: 11, padding: "4px 8px" },
  link: {
    border: "none",
    background: "transparent",
    color: "#a1a1aa",
    fontSize: 11,
    cursor: "pointer",
    padding: "4px",
  },
  error: { color: "#fca5a5", fontSize: 12 },
  meta: { color: "#a1a1aa", fontSize: 12, padding: 12 },
  diffHost: {
    flex: 1,
    minHeight: 360,
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid var(--qb-sidebar-border, #2a2a30)",
    background: "#1e1e1e",
  },
};
