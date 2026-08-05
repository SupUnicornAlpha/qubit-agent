/**
 * 专业/简洁壳共用命令面板（02 U6）：Cmd/Ctrl+K。
 * 切页、切壳、Explorer 分区、Agent 显隐、打开 FS 工作区。
 */
import {
  type CSSProperties,
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listFsWorkspaces } from "../../api/backend";
import { useTranslation } from "../../i18n";
import {
  interfaceModeToShell,
  listPagesForShell,
} from "../../pages/registry";
import { useAppStore, type ActiveView, type ExplorerSection } from "../../store";

type CommandItem = {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  run: () => void;
};

export const CommandPalette: FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [wsRows, setWsRows] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const interfaceMode = useAppStore((s) => s.interfaceMode);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const setExplorerSection = useAppStore((s) => s.setExplorerSection);
  const setActiveFsWorkspaceId = useAppStore((s) => s.setActiveFsWorkspaceId);
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("qb:open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("qb:open-command-palette", onOpen);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const tmr = window.setTimeout(() => inputRef.current?.focus(), 0);
    void (async () => {
      try {
        const rows = await listFsWorkspaces();
        setWsRows(
          rows.map((r) => ({
            id: r.manifest.id,
            name: r.manifest.name,
          }))
        );
      } catch {
        setWsRows([]);
      }
    })();
    return () => window.clearTimeout(tmr);
  }, [open]);

  const commands = useMemo((): CommandItem[] => {
    const shell = interfaceModeToShell(interfaceMode);
    const pages = listPagesForShell(shell).map((p) => ({
      id: `page:${p.id}`,
      label: t(p.titleKey),
      group: t("proShell.command.groupPages"),
      keywords: `${p.id} page ${p.titleKey}`,
      run: () => {
        setActiveView(p.id as ActiveView);
        if (p.id === "chat") setAgentPanelOpen(true);
        close();
      },
    }));

    const shellCmds: CommandItem[] = [
      {
        id: "shell:toggle",
        label:
          interfaceMode === "simple"
            ? t("proShell.command.toPro")
            : t("proShell.command.toSimple"),
        group: t("proShell.command.groupShell"),
        keywords: "simple pro advanced shell mode",
        run: () => {
          setInterfaceMode(interfaceMode === "simple" ? "advanced" : "simple");
          close();
        },
      },
      {
        id: "shell:density",
        label:
          useAppStore.getState().chromeDensity === "compact"
            ? t("proShell.status.densityDefault")
            : t("proShell.status.densityCompact"),
        group: t("proShell.command.groupShell"),
        keywords: "density compact chrome",
        run: () => {
          useAppStore.getState().toggleChromeDensity();
          close();
        },
      },
      {
        id: "agent:toggle",
        label: agentPanelOpen
          ? t("proShell.status.hideAgent")
          : t("proShell.status.showAgent"),
        group: t("proShell.command.groupShell"),
        keywords: "agent panel",
        run: () => {
          setAgentPanelOpen(!agentPanelOpen);
          close();
        },
      },
    ];

    const explorerCmds: CommandItem[] = (
      [
        ["pages", t("proShell.explorer.pages")],
        ["sessions", t("proShell.explorer.sessions")],
        ["workspace", t("proShell.explorer.workspace")],
        ["assets", t("proShell.explorer.assets")],
      ] as const
    ).map(([id, label]) => ({
      id: `explorer:${id}`,
      label: `${t("proShell.command.openExplorer")} · ${label}`,
      group: t("proShell.command.groupExplorer"),
      keywords: `explorer ${id} ${label}`,
      run: () => {
        setInterfaceMode("advanced");
        setExplorerOpen(true);
        setExplorerSection(id as ExplorerSection);
        close();
      },
    }));

    const wsCmds: CommandItem[] = wsRows.map((w) => ({
      id: `ws:${w.id}`,
      label:
        w.id === activeFsWorkspaceId
          ? `${w.name} (${t("proShell.command.current")})`
          : w.name,
      group: t("proShell.command.groupWorkspace"),
      keywords: `workspace fs ${w.name} ${w.id}`,
      run: () => {
        setInterfaceMode("advanced");
        setActiveView("team");
        setExplorerOpen(true);
        setExplorerSection("workspace");
        setActiveFsWorkspaceId(w.id);
        close();
      },
    }));

    return [...pages, ...shellCmds, ...explorerCmds, ...wsCmds];
  }, [
    interfaceMode,
    agentPanelOpen,
    wsRows,
    activeFsWorkspaceId,
    t,
    setActiveView,
    setAgentPanelOpen,
    setInterfaceMode,
    setExplorerOpen,
    setExplorerSection,
    setActiveFsWorkspaceId,
    close,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, activeIndex]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = filtered[activeIndex];
      if (hit) hit.run();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="qb-command-palette"
      style={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={t("proShell.command.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div style={styles.panel} data-qb-command-palette>
        <input
          ref={inputRef}
          style={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("proShell.command.placeholder")}
          aria-label={t("proShell.command.placeholder")}
        />
        <div style={styles.list}>
          {filtered.length === 0 ? (
            <div style={styles.empty}>{t("proShell.command.empty")}</div>
          ) : (
            filtered.map((item, idx) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {showGroup ? <div style={styles.group}>{item.group}</div> : null}
                  <button
                    type="button"
                    style={{
                      ...styles.item,
                      ...(idx === activeIndex ? styles.itemActive : null),
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => item.run()}
                  >
                    {item.label}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div style={styles.footer}>
          <span>↑↓</span>
          <span>{t("proShell.command.hintNavigate")}</span>
          <span>↵</span>
          <span>{t("proShell.command.hintRun")}</span>
          <span>esc</span>
          <span>{t("proShell.command.hintClose")}</span>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    justifyContent: "center",
    paddingTop: "12vh",
  },
  panel: {
    width: "min(560px, calc(100vw - 32px))",
    maxHeight: "min(420px, 70vh)",
    display: "flex",
    flexDirection: "column",
    borderRadius: 10,
    border: "1px solid #3f3f46",
    background: "#121214",
    boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
    overflow: "hidden",
  },
  input: {
    border: "none",
    borderBottom: "1px solid #27272a",
    background: "transparent",
    color: "#f4f4f5",
    fontSize: 15,
    padding: "14px 16px",
    outline: "none",
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflow: "auto",
    padding: "6px 0",
  },
  group: {
    fontSize: 10,
    fontWeight: 600,
    color: "#71717a",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    padding: "8px 14px 4px",
  },
  item: {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    background: "transparent",
    color: "#e4e4e7",
    fontSize: 13,
    padding: "8px 14px",
    cursor: "pointer",
  },
  itemActive: {
    background: "rgba(56,189,248,0.16)",
    color: "#7dd3fc",
  },
  empty: {
    padding: 16,
    fontSize: 12,
    color: "#71717a",
  },
  footer: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
    borderTop: "1px solid #27272a",
    padding: "8px 12px",
    fontSize: 10,
    color: "#71717a",
  },
};
