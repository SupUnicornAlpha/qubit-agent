/**
 * Workspace 记忆面板：浏览 / 钉选 / 新建 / 提议沉淀。
 */
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  deleteFsWorkspaceMemory,
  getFsWorkspaceMemory,
  listFsWorkspaceMemory,
  upsertFsWorkspaceMemory,
  type FsMemoryEntry,
} from "../../api/backend";

export const WorkspaceMemoryPanel: FC<{
  workspaceId: string;
  /** 预填沉淀正文（如从对话提议） */
  proposeBody?: string | null;
  onConsumedPropose?: () => void;
  onClose?: () => void;
}> = ({ workspaceId, proposeBody, onConsumedPropose, onClose }) => {
  const [entries, setEntries] = useState<FsMemoryEntry[]>([]);
  const [selected, setSelected] = useState<FsMemoryEntry | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const rows = await listFsWorkspaceMemory(workspaceId, q.trim() ? { q } : { limit: 40 });
    setEntries(rows);
  }, [workspaceId, q]);

  useEffect(() => {
    void refresh().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  useEffect(() => {
    if (proposeBody?.trim()) {
      setTitle("对话沉淀");
      setBody(proposeBody.trim());
    }
  }, [proposeBody]);

  const save = async (source: FsMemoryEntry["source"] = "user") => {
    if (!title.trim()) {
      setError("标题必填");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const entry = await upsertFsWorkspaceMemory(workspaceId, {
        id: selected?.id,
        title: title.trim(),
        body,
        source,
        pinned: selected?.pinned,
      });
      setSelected(entry);
      await refresh();
      onConsumedPropose?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.root} data-qb-workspace-memory-panel>
      <div style={styles.head}>
        <strong>长期记忆</strong>
        {onClose ? (
          <button type="button" style={styles.link} onClick={onClose}>
            关闭
          </button>
        ) : null}
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      <input
        style={styles.input}
        placeholder="搜索记忆…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div style={styles.list}>
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            style={{
              ...styles.item,
              ...(selected?.id === e.id ? styles.itemActive : null),
            }}
            onClick={() => {
              setSelected(e);
              setTitle(e.title);
              setBody(e.body);
            }}
          >
            {e.pinned ? "📌 " : ""}
            {e.title}
          </button>
        ))}
        {entries.length === 0 ? <div style={styles.meta}>暂无条目</div> : null}
      </div>
      <div style={styles.editor}>
        <input
          style={styles.input}
          placeholder="标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          style={styles.textarea}
          rows={6}
          placeholder="正文"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div style={styles.actions}>
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={styles.btn}
            disabled={busy}
            onClick={() => void save(proposeBody ? "agent_proposal" : "user")}
          >
            {busy ? "保存中…" : proposeBody ? "确认沉淀" : "保存"}
          </button>
          {selected ? (
            <button
              type="button"
              style={styles.link}
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    await deleteFsWorkspaceMemory(workspaceId, selected.id);
                    setSelected(null);
                    setTitle("");
                    setBody("");
                    await refresh();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              删除
            </button>
          ) : null}
          {selected ? (
            <button
              type="button"
              style={styles.link}
              disabled={busy}
              onClick={() =>
                void (async () => {
                  const full = await getFsWorkspaceMemory(workspaceId, selected.id);
                  if (!full) return;
                  await upsertFsWorkspaceMemory(workspaceId, {
                    id: full.id,
                    title: full.title,
                    body: full.body,
                    pinned: !full.pinned,
                    source: full.source,
                  });
                  await refresh();
                  setSelected({ ...full, pinned: !full.pinned });
                })()
              }
            >
              {selected.pinned ? "取消置顶" : "置顶"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 0,
    flex: 1,
    border: "1px solid #2a2a30",
    borderRadius: 8,
    padding: 10,
    background: "rgba(8,8,10,0.92)",
  },
  head: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    color: "#e4e4e7",
    fontSize: 13,
  },
  error: { color: "#fca5a5", fontSize: 11 },
  input: {
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
  },
  textarea: {
    fontSize: 12,
    padding: 8,
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    resize: "vertical",
    fontFamily: "inherit",
  },
  list: {
    maxHeight: 140,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  item: {
    textAlign: "left",
    border: "none",
    background: "transparent",
    color: "#d4d4d8",
    fontSize: 12,
    padding: "4px 6px",
    cursor: "pointer",
    borderRadius: 4,
  },
  itemActive: { background: "rgba(56,189,248,0.15)", color: "#7dd3fc" },
  meta: { fontSize: 11, color: "#71717a" },
  editor: { display: "flex", flexDirection: "column", gap: 6 },
  actions: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  btn: { fontSize: 12, padding: "6px 10px" },
  link: {
    border: "none",
    background: "transparent",
    color: "#38bdf8",
    fontSize: 11,
    cursor: "pointer",
  },
};
