import type { CSSProperties, FC } from "react";
import { useState } from "react";
import {
  CheckCircle2,
  Maximize2,
  Minimize2,
  Trash2,
  X,
} from "lucide-react";
import { useAppStore } from "../../store";

export const WorkspaceBottomPanel: FC<{
  maximized?: boolean;
  onToggleMaximize?: () => void;
  onClose?: () => void;
}> = ({ maximized = false, onToggleMaximize, onClose }) => {
  const proBottomTab = useAppStore((s) => s.proBottomTab);
  const setProBottomTab = useAppStore((s) => s.setProBottomTab);
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);

  const [outputLogs, setOutputLogs] = useState<
    Array<{ id: string; time: string; level: "info" | "warn" | "error"; msg: string }>
  >([
    {
      id: "1",
      time: new Date().toLocaleTimeString(),
      level: "info",
      msg: "[Engine] QUBIT Quantitative Engine initialized. Ready for research & backtest.",
    },
    {
      id: "2",
      time: new Date().toLocaleTimeString(),
      level: "info",
      msg: `[Workspace] Active workspace: ${activeFsWorkspaceId ?? "default-quant"}`,
    },
  ]);

  const [strategyLogs, setStrategyLogs] = useState<
    Array<{ id: string; time: string; symbol: string; text: string }>
  >([
    {
      id: "s1",
      time: new Date().toLocaleTimeString(),
      symbol: "BTCUSDT",
      text: "Signal generator monitoring active feeds. PIT compliance check: PASSED.",
    },
  ]);

  const clearCurrentTab = () => {
    if (proBottomTab === "output") {
      setOutputLogs([]);
    } else if (proBottomTab === "strategy_log") {
      setStrategyLogs([]);
    }
  };

  return (
    <div className="qb-bottom-panel" style={styles.container} data-qb-bottom-panel>
      <div style={styles.tabHeader}>
        <div style={styles.tabGroup} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={proBottomTab === "problems"}
            style={{
              ...styles.tabBtn,
              ...(proBottomTab === "problems" ? styles.tabBtnActive : null),
            }}
            onClick={() => setProBottomTab("problems")}
          >
            <span style={styles.tabLabel}>Problems</span>
            <span style={styles.badgeSuccess}>0</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={proBottomTab === "output"}
            style={{
              ...styles.tabBtn,
              ...(proBottomTab === "output" ? styles.tabBtnActive : null),
            }}
            onClick={() => setProBottomTab("output")}
          >
            <span style={styles.tabLabel}>Output</span>
            {outputLogs.length > 0 ? (
              <span style={styles.badgeCount}>{outputLogs.length}</span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={proBottomTab === "strategy_log"}
            style={{
              ...styles.tabBtn,
              ...(proBottomTab === "strategy_log" ? styles.tabBtnActive : null),
            }}
            onClick={() => setProBottomTab("strategy_log")}
          >
            <span style={styles.tabLabel}>Strategy Console</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={proBottomTab === "terminal"}
            style={{
              ...styles.tabBtn,
              ...(proBottomTab === "terminal" ? styles.tabBtnActive : null),
            }}
            onClick={() => setProBottomTab("terminal")}
          >
            <span style={styles.tabLabel}>Terminal</span>
          </button>
        </div>

        <div style={styles.actions}>
          <button
            type="button"
            style={styles.actionBtn}
            title="清空当前日志"
            onClick={clearCurrentTab}
          >
            <Trash2 size={13} />
          </button>
          {onToggleMaximize ? (
            <button
              type="button"
              style={styles.actionBtn}
              title={maximized ? "还原面板" : "最大化面板"}
              onClick={onToggleMaximize}
            >
              {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              style={styles.actionBtn}
              title="关闭面板 (Esc / Ctrl+`)"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div style={styles.contentArea}>
        {proBottomTab === "problems" ? (
          <div style={styles.emptyState}>
            <CheckCircle2 size={16} color="#10b981" />
            <span style={styles.emptyText}>当前 Workspace 没有检测到代码或语法问题。</span>
          </div>
        ) : null}

        {proBottomTab === "output" ? (
          <div style={styles.logList}>
            {outputLogs.map((log) => (
              <div key={log.id} style={styles.logRow}>
                <span style={styles.logTime}>[{log.time}]</span>
                <span
                  style={{
                    ...styles.logLevel,
                    color:
                      log.level === "error"
                        ? "#f87171"
                        : log.level === "warn"
                          ? "#fbbf24"
                          : "#60a5fa",
                  }}
                >
                  [{log.level.toUpperCase()}]
                </span>
                <span style={styles.logMsg}>{log.msg}</span>
              </div>
            ))}
          </div>
        ) : null}

        {proBottomTab === "strategy_log" ? (
          <div style={styles.logList}>
            {strategyLogs.map((log) => (
              <div key={log.id} style={styles.logRow}>
                <span style={styles.logTime}>[{log.time}]</span>
                <span style={styles.logSymbol}>[{log.symbol}]</span>
                <span style={styles.logMsg}>{log.text}</span>
              </div>
            ))}
          </div>
        ) : null}

        {proBottomTab === "terminal" ? (
          <div style={styles.terminalContainer}>
            <div style={styles.terminalHeader}>
              <span>QUBIT Embedded Shell · Python 3.11 / Rust Engine Target</span>
            </div>
            <div style={styles.terminalBody}>
              <p style={{ margin: "0 0 6px", color: "#a1a1aa" }}>
                $ qubit-cli --workspace {activeFsWorkspaceId ?? "default"}
              </p>
              <p style={{ margin: "0 0 6px", color: "#34d399" }}>
                ✓ Quant environment ready · PIT Database & Event Engine connected.
              </p>
              <p style={{ margin: 0, color: "#71717a" }}>
                输入代码或在上方编辑器中按 ⌘S 自动触发热重载。
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    background: "var(--qb-bg-root, #1e1e1e)",
    borderTop: "1px solid var(--qb-separator, #2d2d2d)",
    fontFamily: "var(--qb-font-body, inherit)",
    fontSize: 12,
    overflow: "hidden",
  },
  tabHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    height: 28,
    minHeight: 28,
    padding: "0 8px",
    background: "var(--qb-topbar-bg, #252526)",
    borderBottom: "1px solid var(--qb-separator, #2d2d2d)",
    userSelect: "none",
  },
  tabGroup: {
    display: "flex",
    gap: 4,
    height: "100%",
    alignItems: "flex-end",
  },
  tabBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 25,
    padding: "0 8px",
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    color: "var(--qb-body-muted, #858585)",
    fontSize: 11,
    cursor: "pointer",
    transition: "color 0.15s, border-color 0.15s",
  },
  tabBtnActive: {
    color: "var(--qb-body-fg, #ffffff)",
    borderBottom: "2px solid var(--qb-blue, #007acc)",
    fontWeight: 500,
  },
  tabLabel: {
    letterSpacing: "0.01em",
  },
  badgeCount: {
    fontSize: 10,
    lineHeight: "12px",
    padding: "0 4px",
    borderRadius: 8,
    background: "var(--qb-main-input-bg, #3c3c3c)",
    color: "var(--qb-body-fg, #cccccc)",
  },
  badgeSuccess: {
    fontSize: 10,
    lineHeight: "12px",
    padding: "0 4px",
    borderRadius: 8,
    background: "rgba(16, 185, 129, 0.15)",
    color: "#34d399",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  actionBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    padding: 0,
    border: "none",
    background: "transparent",
    color: "var(--qb-body-muted, #858585)",
    cursor: "pointer",
    borderRadius: 4,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "8px 12px",
    background: "var(--qb-bg-root, #1e1e1e)",
  },
  emptyState: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 0",
    color: "var(--qb-body-muted, #858585)",
  },
  emptyText: {
    fontSize: 12,
  },
  logList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 11,
  },
  logRow: {
    display: "flex",
    gap: 8,
    lineHeight: "18px",
  },
  logTime: {
    color: "var(--qb-body-muted, #71717a)",
  },
  logLevel: {
    fontWeight: 600,
  },
  logSymbol: {
    color: "#f59e0b",
    fontWeight: 600,
  },
  logMsg: {
    color: "var(--qb-body-fg, #cccccc)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  },
  terminalContainer: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 12,
  },
  terminalHeader: {
    color: "var(--qb-body-muted, #71717a)",
    fontSize: 11,
    marginBottom: 8,
    borderBottom: "1px dashed var(--qb-separator, #3f3f46)",
    paddingBottom: 4,
  },
  terminalBody: {
    flex: 1,
    lineHeight: "20px",
  },
};
