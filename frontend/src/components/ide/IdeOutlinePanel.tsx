import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Code,
  Component,
  FileCode,
  Hash,
  Layers,
  Search,
  Table,
  Variable,
  Workflow,
} from "lucide-react";
import { getFsWorkspaceFile } from "../../api/backend";
import {
  parseCodeOutline,
  type CodeOutlineSymbol,
  type SymbolKind,
} from "../../lib/codeOutlineParser";
import { useAppStore } from "../../store";

function symbolIcon(kind: SymbolKind) {
  switch (kind) {
    case "class":
      return <Component size={13} color="#f59e0b" />;
    case "function":
    case "method":
      return <Workflow size={13} color="#60a5fa" />;
    case "interface":
    case "type":
      return <Layers size={13} color="#a78bfa" />;
    case "variable":
      return <Variable size={13} color="#34d399" />;
    case "heading":
      return <Hash size={13} color="#f472b6" />;
    case "table":
      return <Table size={13} color="#fb923c" />;
    default:
      return <Code size={13} color="#94a3b8" />;
  }
}

export const IdeOutlinePanel: FC<{
  workspaceId?: string;
  path?: string;
  onSelectSymbol?: (symbol: CodeOutlineSymbol) => void;
}> = ({ workspaceId, path, onSelectSymbol }) => {
  const storeWsId = useAppStore((s) => s.activeFsWorkspaceId);
  const storeTabs = useAppStore((s) => s.ideEditorTabs);
  const storeActiveTabId = useAppStore((s) => s.ideActiveEditorTabId);

  const activeTab = useMemo(
    () => storeTabs.find((t) => t.id === storeActiveTabId) ?? storeTabs[0] ?? null,
    [storeTabs, storeActiveTabId]
  );

  const effWsId = workspaceId ?? storeWsId;
  const effPath = path ?? activeTab?.path;

  const [rawCode, setRawCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  useEffect(() => {
    if (!effWsId || !effPath) {
      setRawCode("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    void getFsWorkspaceFile(effWsId, effPath)
      .then((res) => {
        if (!cancelled) setRawCode(res.content);
      })
      .catch(() => {
        if (!cancelled) setRawCode("");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effWsId, effPath]);

  const symbols = useMemo(() => {
    if (!rawCode || !effPath) return [];
    return parseCodeOutline(rawCode, effPath);
  }, [rawCode, effPath]);

  const filteredSymbols = useMemo(() => {
    if (!filterQuery.trim()) return symbols;
    const q = filterQuery.toLowerCase();
    const filterRec = (list: CodeOutlineSymbol[]): CodeOutlineSymbol[] => {
      return list
        .map((s) => ({
          ...s,
          children: s.children ? filterRec(s.children) : undefined,
        }))
        .filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.detail?.toLowerCase().includes(q) ||
            (s.children && s.children.length > 0)
        );
    };
    return filterRec(symbols);
  }, [symbols, filterQuery]);

  const handleJump = (s: CodeOutlineSymbol) => {
    if (onSelectSymbol) {
      onSelectSymbol(s);
    }
    window.dispatchEvent(
      new CustomEvent("qb-ide-jump-to-line", {
        detail: { line: s.line, column: s.column, path: effPath },
      })
    );
  };

  if (!effPath) {
    return (
      <div style={styles.emptyWrap}>
        <FileCode size={24} color="#71717a" />
        <span style={styles.emptyText}>请在编辑器中打开代码文件查看大纲</span>
      </div>
    );
  }

  return (
    <div style={styles.container} data-qb-ide-outline>
      <div style={styles.headerRow}>
        <div style={styles.fileTitle}>
          <span style={styles.fileName}>{effPath.split("/").pop()}</span>
          <span style={styles.symbolCount}>
            {symbols.length} {symbols.length > 1 ? "symbols" : "symbol"}
          </span>
        </div>
        <div style={styles.searchWrap}>
          <Search size={12} color="#71717a" style={styles.searchIcon} />
          <input
            type="text"
            placeholder="过滤符号 (Filter outline)..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            style={styles.searchInput}
          />
        </div>
      </div>

      <div style={styles.listArea}>
        {loading ? (
          <div style={styles.loadingText}>解析大纲中…</div>
        ) : filteredSymbols.length === 0 ? (
          <div style={styles.emptyText}>
            {filterQuery ? "未匹配到对应符号" : "未检测到函数、类或标题符号"}
          </div>
        ) : (
          filteredSymbols.map((s) => (
            <SymbolRow key={s.id} symbol={s} level={0} onJump={handleJump} />
          ))
        )}
      </div>
    </div>
  );
};

const SymbolRow: FC<{
  symbol: CodeOutlineSymbol;
  level: number;
  onJump: (s: CodeOutlineSymbol) => void;
}> = ({ symbol, level, onJump }) => {
  return (
    <div style={styles.symbolTree}>
      <button
        type="button"
        style={{
          ...styles.symbolItem,
          paddingLeft: 8 + level * 14,
        }}
        onClick={() => onJump(symbol)}
        title={`${symbol.name} (Line ${symbol.line})`}
      >
        <span style={styles.symbolIconWrap}>{symbolIcon(symbol.kind)}</span>
        <span style={styles.symbolName}>{symbol.name}</span>
        {symbol.detail ? <span style={styles.symbolDetail}>{symbol.detail}</span> : null}
        <span style={styles.symbolLine}>:{symbol.line}</span>
      </button>
      {symbol.children && symbol.children.length > 0 ? (
        <div style={styles.childGroup}>
          {symbol.children.map((child) => (
            <SymbolRow key={child.id} symbol={child} level={level + 1} onJump={onJump} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    width: "100%",
    background: "var(--qb-bg-root, #1e1e1e)",
    color: "var(--qb-body-fg, #cccccc)",
    fontSize: 12,
  },
  emptyWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 24,
    color: "var(--qb-body-muted, #71717a)",
    textAlign: "center",
  },
  emptyText: {
    fontSize: 12,
    color: "var(--qb-body-muted, #71717a)",
    padding: 12,
    textAlign: "center",
  },
  headerRow: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px",
    borderBottom: "1px solid var(--qb-separator, #2d2d2d)",
    background: "var(--qb-sidebar-nav-bg, #252526)",
  },
  fileTitle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fileName: {
    fontWeight: 600,
    color: "var(--qb-body-fg, #ffffff)",
    fontSize: 11.5,
  },
  symbolCount: {
    fontSize: 10,
    color: "var(--qb-body-muted, #858585)",
  },
  searchWrap: {
    position: "relative",
    display: "flex",
    alignItems: "center",
  },
  searchIcon: {
    position: "absolute",
    left: 6,
    pointerEvents: "none",
  },
  searchInput: {
    width: "100%",
    boxSizing: "border-box",
    height: 24,
    background: "var(--qb-main-input-bg, #3c3c3c)",
    border: "1px solid var(--qb-main-input-border, #3c3c3c)",
    borderRadius: 3,
    color: "var(--qb-body-fg, #cccccc)",
    fontSize: 11,
    paddingLeft: 22,
    paddingRight: 6,
    outline: "none",
  },
  listArea: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "4px 0",
  },
  loadingText: {
    fontSize: 11,
    color: "var(--qb-body-muted, #858585)",
    padding: 12,
    textAlign: "center",
  },
  symbolTree: {
    display: "flex",
    flexDirection: "column",
  },
  symbolItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    border: "none",
    background: "transparent",
    color: "var(--qb-body-fg, #cccccc)",
    textAlign: "left",
    paddingTop: 4,
    paddingBottom: 4,
    paddingRight: 8,
    cursor: "pointer",
    fontSize: 11.5,
    fontFamily: "inherit",
    borderRadius: 2,
    transition: "background 0.12s ease",
  },
  symbolIconWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  symbolName: {
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  symbolDetail: {
    fontSize: 10,
    color: "var(--qb-body-muted, #71717a)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flexShrink: 1,
  },
  symbolLine: {
    marginLeft: "auto",
    fontSize: 10,
    color: "var(--qb-body-muted, #71717a)",
    fontFamily: "monospace",
    flexShrink: 0,
  },
  childGroup: {
    display: "flex",
    flexDirection: "column",
  },
};
