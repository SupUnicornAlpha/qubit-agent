/**
 * FS Workspace Explorer：列出 / 创建 / 展开课题目录树。
 * 供 pro 壳 SideBar 与研究团队左栏复用。
 */
import { ChevronDown, ChevronRight, FileCode2, Folder, Plus } from "lucide-react";
import { type CSSProperties, type FC, useCallback, useEffect, useState } from "react";
import {
  createFsWorkspaceApi,
  getFsWorkspaceTree,
  listFsWorkspaces,
  syncFsWorkspaceDecision,
  type FsWorkspaceManifest,
  type FsWorkspaceTreeNode,
} from "../../api/backend";
import { coerceChartMarketExchange, guessChartExchangeFromSymbol } from "../../lib/chartSpec";
import { useAppStore } from "../../store";
import { WorkspaceMemoryPanel } from "./WorkspaceMemoryPanel";

export type FsWorkspaceExplorerProps = {
  /** 从当前研究范围一键建课题时的默认名 / 种子 */
  createDefaults?: {
    name: string;
    mode?: string;
    symbols?: Array<{ symbol: string; exchange?: string }>;
    focus?: { symbol: string; exchange?: string };
  };
  compact?: boolean;
  onOpenWorkflowSettings?: () => void;
  /** 当前工作流 id：树上高亮对应 runs/<id> */
  activeRunId?: string | null;
  /** 同步工坊资产用的 projectId */
  projectId?: string | null;
};

export const FsWorkspaceExplorer: FC<FsWorkspaceExplorerProps> = ({
  createDefaults,
  compact = false,
  onOpenWorkflowSettings,
  activeRunId = null,
  projectId = null,
}) => {
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const requestChartReload = useAppStore((s) => s.requestChartReload);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setActiveFsWorkspaceId = useAppStore((s) => s.setActiveFsWorkspaceId);
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);

  const [list, setList] = useState<Array<{ rootPath: string; manifest: FsWorkspaceManifest }>>([]);
  const [activeId, setActiveId] = useState<string | null>(activeFsWorkspaceId);
  const [tree, setTree] = useState<FsWorkspaceTreeNode | null>(null);
  const [treeNonce, setTreeNonce] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "workspace:": true,
  });
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [showMemory, setShowMemory] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [proposeBody, setProposeBody] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const rows = await listFsWorkspaces();
    setList(rows);
    return rows;
  }, []);

  const loadTree = useCallback(async (id: string) => {
    const t = await getFsWorkspaceTree(id, { maxDepth: 5 });
    setTree(t);
    setExpanded((prev) => ({
      ...prev,
      [t.id]: true,
      ...Object.fromEntries(
        (t.children ?? []).map((c) => [c.id, ["input", "research", "decision", "memory", "runs", "output"].includes(c.name)])
      ),
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await refreshList();
        if (cancelled) return;
        const preferred =
          (activeFsWorkspaceId && rows.find((r) => r.manifest.id === activeFsWorkspaceId)) ||
          rows[0];
        if (preferred) {
          setActiveId(preferred.manifest.id);
          setActiveFsWorkspaceId(preferred.manifest.id);
          await loadTree(preferred.manifest.id);
        } else {
          setActiveId(null);
          setTree(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTree, refreshList, setActiveFsWorkspaceId]);

  useEffect(() => {
    if (!activeId) return;
    void loadTree(activeId).catch(() => undefined);
  }, [treeNonce, activeId, loadTree]);

  useEffect(() => {
    if (!activeRunId || !activeId) return;
    const t = window.setTimeout(() => setTreeNonce((n) => n + 1), 400);
    return () => window.clearTimeout(t);
  }, [activeRunId, activeId]);

  const handleCreate = async (fromScope: boolean) => {
    setCreating(true);
    setError(null);
    try {
      const name =
        (fromScope ? createDefaults?.name : newName.trim()) ||
        newName.trim() ||
        createDefaults?.name ||
        `课题 ${new Date().toLocaleDateString()}`;
      const created = await createFsWorkspaceApi({
        name,
        seedUniverse: fromScope
          ? {
              mode: createDefaults?.mode,
              symbols: createDefaults?.symbols ?? [],
            }
          : undefined,
        defaultFocus: fromScope ? createDefaults?.focus : undefined,
      });
      setNewName("");
      await refreshList();
      setActiveId(created.manifest.id);
      setActiveFsWorkspaceId(created.manifest.id);
      await loadTree(created.manifest.id);
      if (created.manifest.defaultFocus?.symbol) {
        setChartSpec({
          symbol: created.manifest.defaultFocus.symbol,
          exchange: coerceChartMarketExchange(
            created.manifest.defaultFocus.exchange ||
              guessChartExchangeFromSymbol(created.manifest.defaultFocus.symbol)
          ),
        });
        requestChartReload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const onSelectWorkspace = async (id: string) => {
    setActiveId(id);
    setActiveFsWorkspaceId(id);
    setError(null);
    try {
      await loadTree(id);
      const hit = list.find((r) => r.manifest.id === id);
      if (hit?.manifest.defaultFocus?.symbol) {
        setChartSpec({
          symbol: hit.manifest.defaultFocus.symbol,
          exchange: coerceChartMarketExchange(
            hit.manifest.defaultFocus.exchange ||
              guessChartExchangeFromSymbol(hit.manifest.defaultFocus.symbol)
          ),
        });
        requestChartReload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const onOpenNode = (node: FsWorkspaceTreeNode) => {
    if (node.kind === "folder" || (node.children && node.children.length > 0)) {
      toggle(node.id);
      return;
    }
    if (node.kind === "memory_entry" || node.relPath?.startsWith("memory/entries/")) {
      setShowMemory(true);
      return;
    }
    // universe / watchlist / 标的：尝试读 JSON 不强制；点名文件若像 ticker 则切行情
    if (node.name === "universe.json" || node.name === "watchlist.json") {
      setActiveView("team");
      return;
    }
    if (node.kind === "universe" || node.relPath?.includes("universe")) {
      setActiveView("team");
      return;
    }
    // 简单启发式：单层文件名像美股代码
    const base = node.name.replace(/\.[^.]+$/, "").toUpperCase();
    if (/^[A-Z]{1,5}$/.test(base) || /^\d{6}$/.test(base)) {
      setChartSpec({
        symbol: base,
        exchange: coerceChartMarketExchange(guessChartExchangeFromSymbol(base)),
      });
      requestChartReload();
    }
  };

  const renderNode = (node: FsWorkspaceTreeNode, depth: number) => {
    const isFolder = node.kind === "folder" || Boolean(node.children?.length);
    const isOpen = !!expanded[node.id];
    const Icon = isFolder ? Folder : FileCode2;
    const Chevron = isOpen ? ChevronDown : ChevronRight;
    const isActiveRun =
      Boolean(activeRunId) &&
      (node.relPath === `runs/${activeRunId}` ||
        node.relPath === `runs/${activeRunId}/run.json` ||
        node.name === activeRunId);
    return (
      <div key={node.id}>
        <button
          type="button"
          className="qb-explorer-tree__node"
          style={{
            ...styles.nodeBtn,
            paddingLeft: 6 + depth * 12,
            ...(isActiveRun ? styles.nodeActiveRun : null),
          }}
          onClick={() => onOpenNode(node)}
          title={node.relPath || node.name}
        >
          {isFolder ? <Chevron size={12} strokeWidth={2} /> : <span style={{ width: 12 }} />}
          <Icon size={13} strokeWidth={2} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {isActiveRun ? "▶ " : ""}
            {node.name}
          </span>
        </button>
        {isFolder && isOpen
          ? (node.children ?? []).map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  };

  return (
    <div style={styles.root} data-qb-fs-workspace-explorer>
      <div style={styles.hint}>
        本地课题树（FS）· 不依赖 DB。记忆 / 决策经 Provider 可替换。
      </div>
      {error ? <div style={styles.error}>{error}</div> : null}
      <div style={styles.toolbar}>
        <select
          style={styles.select}
          value={activeId ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            if (id) void onSelectWorkspace(id);
          }}
          disabled={loading || list.length === 0}
        >
          {list.length === 0 ? (
            <option value="">尚无课题</option>
          ) : (
            list.map((row) => (
              <option key={row.manifest.id} value={row.manifest.id}>
                {row.manifest.name}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          style={styles.iconBtn}
          disabled={creating}
          title="新建空课题"
          onClick={() => void handleCreate(false)}
        >
          <Plus size={14} />
        </button>
      </div>
      {!compact ? (
        <div style={styles.createRow}>
          <input
            style={styles.input}
            placeholder="课题名称（可选）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          {createDefaults ? (
            <button
              type="button"
              className="qb-btn-primary-brand"
              style={styles.createFromScope}
              disabled={creating}
              onClick={() => void handleCreate(true)}
            >
              {creating ? "创建中…" : "从当前研究范围建课题"}
            </button>
          ) : null}
        </div>
      ) : null}
      {onOpenWorkflowSettings ? (
        <button type="button" style={styles.linkBtn} onClick={onOpenWorkflowSettings}>
          打开工作流 / 研究设置 →
        </button>
      ) : null}
      <div style={styles.actionsRow}>
        <button
          type="button"
          style={styles.linkBtn}
          disabled={!activeId}
          onClick={() => setShowMemory((v) => !v)}
        >
          {showMemory ? "收起记忆" : "长期记忆"}
        </button>
        <button
          type="button"
          style={styles.linkBtn}
          disabled={!activeId || !projectId || syncing}
          onClick={() =>
            void (async () => {
              if (!activeId || !projectId) return;
              setSyncing(true);
              setError(null);
              try {
                const r = await syncFsWorkspaceDecision(activeId, projectId);
                setTreeNonce((n) => n + 1);
                setError(null);
                window.alert?.(
                  `已同步因子 ${r.factorCount} · 策略 ${r.strategyCount}`
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setSyncing(false);
              }
            })()
          }
        >
          {syncing ? "同步中…" : "同步工坊资产"}
        </button>
        <button
          type="button"
          style={styles.linkBtn}
          disabled={!activeId}
          onClick={() => {
            setProposeBody("（在此粘贴需沉淀的结论）");
            setShowMemory(true);
          }}
        >
          提议沉淀
        </button>
      </div>
      {showMemory && activeId ? (
        <WorkspaceMemoryPanel
          workspaceId={activeId}
          proposeBody={proposeBody}
          onConsumedPropose={() => setProposeBody(null)}
          onClose={() => setShowMemory(false)}
        />
      ) : null}
      {loading ? (
        <div style={styles.meta}>加载中…</div>
      ) : tree ? (
        <div className="qb-explorer-tree" style={styles.tree}>
          {renderNode(tree, 0)}
        </div>
      ) : (
        <div style={styles.meta}>还没有课题。点 ＋ 或「从当前研究范围建课题」。</div>
      )}
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
  },
  hint: { fontSize: 11, color: "#71717a", lineHeight: 1.4 },
  error: { fontSize: 11, color: "#fca5a5" },
  toolbar: { display: "flex", gap: 6, alignItems: "center" },
  select: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
  },
  iconBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#27272a",
    color: "#e4e4e7",
    cursor: "pointer",
  },
  createRow: { display: "flex", flexDirection: "column", gap: 6 },
  input: {
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
  },
  createFromScope: { fontSize: 12, padding: "6px 10px" },
  linkBtn: {
    alignSelf: "flex-start",
    border: "none",
    background: "transparent",
    color: "#38bdf8",
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
  },
  actionsRow: { display: "flex", flexWrap: "wrap", gap: 10 },
  meta: { fontSize: 12, color: "#a1a1aa", padding: "8px 0" },
  tree: { flex: 1, minHeight: 0, overflow: "auto" },
  nodeBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    border: "none",
    background: "transparent",
    color: "#d4d4d8",
    fontSize: 12,
    paddingTop: 3,
    paddingBottom: 3,
    paddingRight: 6,
    cursor: "pointer",
    textAlign: "left",
  },
  nodeActiveRun: {
    background: "rgba(56,189,248,0.12)",
    color: "#7dd3fc",
    borderRadius: 4,
  },
};
