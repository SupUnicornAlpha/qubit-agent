/**
 * 监控 · 工具/MCP 排障 tab — 专门用来回答"这个工具/MCP 为什么不可用"。
 *
 * 布局：
 *   - 顶部：source 切换（工具 / MCP）+ 时间窗口选择 + 刷新按钮
 *   - 左侧：列表表（按 errorCount + sandboxBlockedCount 降序，让有问题的置顶）
 *   - 右侧：选中后展开详情面板（ToolDiagnosticsPanel / McpDiagnosticsPanel）
 *
 * 数据源：
 *   - 工具：/api/v1/monitor/tools/summary（已存在）→ /api/v1/monitor/tools/:name/detail（本次新增）
 *   - MCP：/api/v1/monitor/mcp/summary（已存在）→ /api/v1/monitor/mcp/:name/detail（本次新增）
 *
 * 与 OverviewTab 的 FailuresPanel 区别：FailuresPanel 是"跨维度失败时间线"，
 * 这里是"单一工具/MCP 维度的深入排障"。两者互补，不重复。
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listMonitorMcpSummary,
  listMonitorToolsSummary,
  type MonitorMcpSummaryRow,
  type MonitorToolKind,
  type MonitorToolSummaryRow,
} from "../../api/backend";
import { styles } from "./monitor-shared";
import { McpDiagnosticsPanel } from "./McpDiagnosticsPanel";
import { ToolDiagnosticsPanel } from "./ToolDiagnosticsPanel";

export type DiagnosticsTabProps = {
  sessionFilter?: string | undefined;
  onJumpToWorkflow?: (workflowRunId: string) => void;
};

type DiagSource = "tool" | "mcp";

type SelectedTool = { kind: "tool"; toolName: string; toolKind: MonitorToolKind };
type SelectedMcp = { kind: "mcp"; serverName: string };
type Selected = SelectedTool | SelectedMcp | null;

/**
 * 时间窗口预设。1h 最适合"刚出现的告警"; 6h / 24h / 3d 看更长趋势。
 */
const WINDOW_PRESETS = [60, 360, 1440, 4320] as const;

export const DiagnosticsTab: FC<DiagnosticsTabProps> = ({ sessionFilter, onJumpToWorkflow }) => {
  const [source, setSource] = useState<DiagSource>("tool");
  const [windowMinutes, setWindowMinutes] = useState<number>(60);
  const [toolRows, setToolRows] = useState<MonitorToolSummaryRow[]>([]);
  const [mcpRows, setMcpRows] = useState<MonitorMcpSummaryRow[]>([]);
  const [selected, setSelected] = useState<Selected>(null);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      if (source === "tool") {
        const params: Parameters<typeof listMonitorToolsSummary>[0] = { windowMinutes };
        if (sessionFilter) params.sessionId = sessionFilter;
        const data = await listMonitorToolsSummary(params);
        setToolRows(data);
        setHint(data.length === 0 ? "窗口内无工具调用记录" : null);
      } else {
        const params: Parameters<typeof listMonitorMcpSummary>[0] = { windowMinutes };
        if (sessionFilter) params.sessionId = sessionFilter;
        const data = await listMonitorMcpSummary(params);
        setMcpRows(data);
        setHint(data.length === 0 ? "窗口内无 MCP 调用记录" : null);
      }
    } catch (e) {
      setHint(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [source, windowMinutes, sessionFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  /**
   * 切换 source 时清空 selected，避免显示上一个 source 的详情。
   */
  const handleSourceChange = (s: DiagSource) => {
    setSource(s);
    setSelected(null);
  };

  /**
   * 排序：先把"有问题的"（errorCount + sandboxBlocked > 0 或 successRate < 1）顶到前面，
   * 再按 totalCalls 降序。让用户一眼看到哪个工具最有问题。
   */
  const sortedToolRows = useMemo(() => sortByProblem(toolRows), [toolRows]);
  const sortedMcpRows = useMemo(() => sortMcpByProblem(mcpRows), [mcpRows]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        工具 / MCP 排障 · 按单一工具或 MCP server 深入查看"为什么不可用"
      </h3>

      <div style={styles.form}>
        <div style={{ display: "inline-flex", gap: 4 }}>
          <button
            type="button"
            className={source === "tool" ? "qb-btn-primary" : "qb-btn-secondary"}
            onClick={() => handleSourceChange("tool")}
          >
            工具（含沙箱阻断）
          </button>
          <button
            type="button"
            className={source === "mcp" ? "qb-btn-primary" : "qb-btn-secondary"}
            onClick={() => handleSourceChange("mcp")}
          >
            MCP（含熔断状态）
          </button>
        </div>

        <select
          style={styles.select}
          value={windowMinutes}
          onChange={(e) => setWindowMinutes(Number(e.target.value))}
        >
          {WINDOW_PRESETS.map((m) => (
            <option key={m} value={m}>
              近 {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="qb-btn-secondary"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "加载中…" : "刷新"}
        </button>

        {sessionFilter ? (
          <span style={{ fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" }}>
            已锁定 session {sessionFilter.slice(0, 8)}…
          </span>
        ) : null}
      </div>

      {hint ? <div style={styles.hint}>{hint}</div> : null}

      {/**
       * 双列布局：左 列表 (minmax(380px, 0.7fr))，右 详情 (minmax(0, 1.3fr))。
       * 详情区比列表宽，因为右侧要展开 KPI + 多个表，左侧只是一张选择表。
       */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(380px, 0.85fr) minmax(0, 1.4fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          {source === "tool" ? (
            <ToolList
              rows={sortedToolRows}
              selectedToolName={selected?.kind === "tool" ? selected.toolName : null}
              onSelect={(t) =>
                setSelected({ kind: "tool", toolName: t.toolName, toolKind: t.toolKind })
              }
            />
          ) : (
            <McpList
              rows={sortedMcpRows}
              selectedServerName={selected?.kind === "mcp" ? selected.serverName : null}
              onSelect={(m) => setSelected({ kind: "mcp", serverName: m.serverName })}
            />
          )}
        </div>

        <div style={{ minWidth: 0 }}>
          {selected?.kind === "tool" ? (
            <ToolDiagnosticsPanel
              toolName={selected.toolName}
              toolKind={selected.toolKind}
              windowMinutes={windowMinutes}
              sessionId={sessionFilter || undefined}
              onJumpToWorkflow={onJumpToWorkflow}
            />
          ) : selected?.kind === "mcp" ? (
            <McpDiagnosticsPanel
              serverName={selected.serverName}
              windowMinutes={windowMinutes}
              sessionId={sessionFilter || undefined}
              onJumpToWorkflow={onJumpToWorkflow}
            />
          ) : (
            <EmptyDetailHint source={source} />
          )}
        </div>
      </div>
    </div>
  );
};

// ───────────────────────── 子组件：左侧列表 ─────────────────────────

const ToolList: FC<{
  rows: MonitorToolSummaryRow[];
  selectedToolName: string | null;
  onSelect: (t: MonitorToolSummaryRow) => void;
}> = ({ rows, selectedToolName, onSelect }) => {
  return (
    <div style={{ ...styles.tableWrap, maxHeight: 600 }}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>工具</th>
            <th style={{ ...styles.th, width: 50 }}>类型</th>
            <th style={{ ...styles.th, width: 50 }}>调用</th>
            <th style={{ ...styles.th, width: 50 }}>失败</th>
            <th style={{ ...styles.th, width: 60 }}>沙箱</th>
            <th style={{ ...styles.th, width: 70 }}>成功率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const selected = r.toolName === selectedToolName;
            const isProblematic =
              r.errorCount > 0 || r.timeoutCount > 0 || r.sandboxBlockedCount > 0;
            return (
              <tr
                key={`${r.toolKind}::${r.toolName}`}
                style={{
                  ...styles.tr,
                  ...(selected ? styles.trSelected : {}),
                }}
                onClick={() => onSelect(r)}
              >
                <td
                  style={{
                    ...styles.td,
                    fontFamily: "monospace",
                    fontSize: 11,
                    fontWeight: isProblematic ? 600 : 400,
                  }}
                  title={r.toolName}
                >
                  {r.toolName}
                </td>
                <td style={{ ...styles.td, fontSize: 10, color: "var(--qb-main-meta, #a1a1aa)" }}>
                  {shortKind(r.toolKind)}
                </td>
                <td style={styles.td}>{r.totalCalls}</td>
                <td
                  style={{
                    ...styles.td,
                    color: r.errorCount + r.timeoutCount > 0 ? "#ef4444" : undefined,
                  }}
                >
                  {r.errorCount + r.timeoutCount}
                </td>
                <td
                  style={{
                    ...styles.td,
                    color: r.sandboxBlockedCount > 0 ? "#f97316" : undefined,
                    fontWeight: r.sandboxBlockedCount > 0 ? 600 : 400,
                  }}
                >
                  {r.sandboxBlockedCount}
                </td>
                <td
                  style={{
                    ...styles.td,
                    color:
                      r.successRate >= 0.9
                        ? "#22c55e"
                        : r.successRate >= 0.5
                          ? "#eab308"
                          : "#ef4444",
                  }}
                >
                  {`${(r.successRate * 100).toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <div style={styles.empty}>无数据</div> : null}
    </div>
  );
};

const McpList: FC<{
  rows: MonitorMcpSummaryRow[];
  selectedServerName: string | null;
  onSelect: (m: MonitorMcpSummaryRow) => void;
}> = ({ rows, selectedServerName, onSelect }) => {
  return (
    <div style={{ ...styles.tableWrap, maxHeight: 600 }}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>MCP server</th>
            <th style={{ ...styles.th, width: 70 }}>熔断</th>
            <th style={{ ...styles.th, width: 50 }}>调用</th>
            <th style={{ ...styles.th, width: 50 }}>失败</th>
            <th style={{ ...styles.th, width: 70 }}>成功率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const selected = r.serverName === selectedServerName;
            const isOpen = r.health?.circuitState === "open";
            return (
              <tr
                key={r.serverName}
                style={{ ...styles.tr, ...(selected ? styles.trSelected : {}) }}
                onClick={() => onSelect(r)}
              >
                <td
                  style={{
                    ...styles.td,
                    fontFamily: "monospace",
                    fontSize: 11,
                    fontWeight: isOpen ? 600 : 400,
                  }}
                >
                  {r.serverName}
                </td>
                <td style={styles.td}>
                  <CircuitTag state={r.health?.circuitState ?? null} />
                </td>
                <td style={styles.td}>{r.totalCalls}</td>
                <td
                  style={{
                    ...styles.td,
                    color: r.failedCount + r.timeoutCount > 0 ? "#ef4444" : undefined,
                  }}
                >
                  {r.failedCount + r.timeoutCount}
                </td>
                <td
                  style={{
                    ...styles.td,
                    color:
                      r.successRate >= 0.9
                        ? "#22c55e"
                        : r.successRate >= 0.5
                          ? "#eab308"
                          : "#ef4444",
                  }}
                >
                  {`${(r.successRate * 100).toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <div style={styles.empty}>无数据</div> : null}
    </div>
  );
};

const CircuitTag: FC<{ state: "closed" | "open" | "half_open" | null }> = ({ state }) => {
  if (!state) return <span style={{ color: "var(--qb-main-meta, #71717a)" }}>—</span>;
  const map = {
    closed: { fg: "#22c55e", label: "正常" },
    half_open: { fg: "#eab308", label: "试探" },
    open: { fg: "#ef4444", label: "熔断" },
  } as const;
  const { fg, label } = map[state];
  return (
    <span
      style={{
        color: fg,
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 5px",
        border: `1px solid ${fg}`,
        borderRadius: 3,
      }}
    >
      {label}
    </span>
  );
};

const EmptyDetailHint: FC<{ source: DiagSource }> = ({ source }) => {
  return (
    <div
      style={{
        ...styles.empty,
        padding: "28px 16px",
        textAlign: "center",
        border: "1px dashed var(--qb-main-input-border, #27272a)",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        ← 从左侧选择一个{source === "tool" ? "工具" : "MCP server"}查看详情
      </div>
      <div style={{ fontSize: 11 }}>
        会展示：错误原因 Top、
        {source === "tool" ? "沙箱阻断分类" : "熔断状态 & byTool 失败分布"}、最近 50 条调用流水
      </div>
    </div>
  );
};

// ───────────────────────── 排序辅助 ─────────────────────────

/**
 * 工具行排序：有沙箱阻断 > 有失败/超时 > 调用数高 > 名字字典序。
 * 让排障人员第一眼看到「有问题的工具」，正常工具沉到底。
 */
function sortByProblem(rows: MonitorToolSummaryRow[]): MonitorToolSummaryRow[] {
  return [...rows].sort((a, b) => {
    // sandboxBlocked 优先（最具排查价值，被沙箱阻断说明配置问题）
    if (a.sandboxBlockedCount > 0 && b.sandboxBlockedCount === 0) return -1;
    if (a.sandboxBlockedCount === 0 && b.sandboxBlockedCount > 0) return 1;
    // 失败 + 超时合计
    const aFail = a.errorCount + a.timeoutCount;
    const bFail = b.errorCount + b.timeoutCount;
    if (aFail !== bFail) return bFail - aFail;
    // 调用数降序
    if (a.totalCalls !== b.totalCalls) return b.totalCalls - a.totalCalls;
    return a.toolName.localeCompare(b.toolName);
  });
}

function sortMcpByProblem(rows: MonitorMcpSummaryRow[]): MonitorMcpSummaryRow[] {
  return [...rows].sort((a, b) => {
    // 熔断 open 最优先
    const aOpen = a.health?.circuitState === "open" ? 1 : 0;
    const bOpen = b.health?.circuitState === "open" ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    // 失败 + 超时
    const aFail = a.failedCount + a.timeoutCount;
    const bFail = b.failedCount + b.timeoutCount;
    if (aFail !== bFail) return bFail - aFail;
    if (a.totalCalls !== b.totalCalls) return b.totalCalls - a.totalCalls;
    return a.serverName.localeCompare(b.serverName);
  });
}

function shortKind(k: MonitorToolKind): string {
  switch (k) {
    case "acp_connector":
      return "ACP";
    case "mcp":
      return "MCP";
    case "skill":
      return "SK";
    case "builtin":
      return "BI";
  }
}
