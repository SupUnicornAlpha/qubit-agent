/**
 * 失败列表面板：跨 tool / mcp / skill / agent 的近窗口失败。
 *
 * 设计见 docs/MONITORING_V2_DESIGN.md §4.1.2 / §5.2。
 * 用于在 Overview / Agent / Skills tab 内嵌入；自身维护 scope、windowMinutes、limit 与 polling。
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listMonitorFailures,
  type MonitorFailureRow,
  type MonitorFailureScope,
} from "../../api/backend";
import { styles } from "./monitor-shared";

export type FailuresPanelProps = {
  /** 默认查询 scope；不传时 = 全部 4 类合并 */
  defaultScope?: MonitorFailureScope | "all";
  /** 默认时间窗口（分钟），缺省 60 */
  defaultWindowMinutes?: number;
  /** 默认 limit，缺省 20，上限由后端 clamp 到 100 */
  defaultLimit?: number;
  /** session 过滤，传入后只显示该 session 失败 */
  sessionId?: string | undefined;
  /** 自动轮询间隔（毫秒），缺省 30000；传 0 关闭 */
  autoRefreshMs?: number;
  /** 点击失败行时回调（接 workflow detail 跳转用，例如 setSelectedWorkflowId） */
  onSelectWorkflow?: (workflowRunId: string) => void;
  /** 标题；默认「失败列表」 */
  title?: string;
};

const ALL_SCOPES: ("all" | MonitorFailureScope)[] = ["all", "tool", "mcp", "skill", "agent"];

const SCOPE_LABEL: Record<"all" | MonitorFailureScope, string> = {
  all: "全部",
  tool: "工具",
  mcp: "MCP",
  skill: "Skill",
  agent: "Agent",
};

const SCOPE_COLOR: Record<MonitorFailureScope, string> = {
  tool: "#3b82f6",
  mcp: "#22c55e",
  skill: "#a78bfa",
  agent: "#f97316",
};

const WINDOW_PRESETS = [15, 60, 240, 1440] as const;

export const FailuresPanel: FC<FailuresPanelProps> = ({
  defaultScope = "all",
  defaultWindowMinutes = 60,
  defaultLimit = 20,
  sessionId,
  autoRefreshMs = 30_000,
  onSelectWorkflow,
  title = "失败列表",
}) => {
  const [scope, setScope] = useState<"all" | MonitorFailureScope>(defaultScope);
  const [windowMinutes, setWindowMinutes] = useState<number>(defaultWindowMinutes);
  const [limit, setLimit] = useState<number>(defaultLimit);
  const [rows, setRows] = useState<MonitorFailureRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params: Parameters<typeof listMonitorFailures>[0] = {
        windowMinutes,
        limit,
      };
      if (scope !== "all") params.scope = scope;
      if (sessionId) params.sessionId = sessionId;
      const data = await listMonitorFailures(params);
      setRows(data);
      setHint(data.length === 0 ? "窗口内无失败事件" : null);
    } catch (e) {
      setHint(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [scope, windowMinutes, limit, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = window.setInterval(() => {
      void refresh();
    }, autoRefreshMs);
    return () => window.clearInterval(t);
  }, [refresh, autoRefreshMs]);

  const grouped = useMemo(() => {
    const counts: Record<MonitorFailureScope, number> = { tool: 0, mcp: 0, skill: 0, agent: 0 };
    for (const r of rows) counts[r.scope]++;
    return counts;
  }, [rows]);

  return (
    <section className="qb-monitor__panel qb-a3d-tilt" style={panelStyle}>
      <header style={headerStyle}>
        <div style={titleStyle}>{title}</div>
        <div style={countsStyle}>
          {(["tool", "mcp", "skill", "agent"] as MonitorFailureScope[]).map((s) => (
            <span key={s} style={{ color: SCOPE_COLOR[s] }} title={`${SCOPE_LABEL[s]}失败 ${grouped[s]} 条`}>
              {SCOPE_LABEL[s]} {grouped[s]}
            </span>
          ))}
        </div>
      </header>

      <div style={styles.form}>
        <select
          style={styles.select}
          value={scope}
          onChange={(e) => setScope(e.target.value as "all" | MonitorFailureScope)}
          aria-label="失败维度"
        >
          {ALL_SCOPES.map((s) => (
            <option key={s} value={s}>
              {SCOPE_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          style={styles.select}
          value={windowMinutes}
          onChange={(e) => setWindowMinutes(Number(e.target.value))}
          aria-label="时间窗口"
        >
          {WINDOW_PRESETS.map((m) => (
            <option key={m} value={m}>
              近 {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={1}
          max={100}
          step={5}
          style={{ ...styles.input, flex: "0 0 110px", minWidth: 90 }}
          value={limit}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) setLimit(Math.min(100, Math.max(1, v)));
          }}
          aria-label="返回上限"
        />
        <button className="qb-btn-secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>
      {hint ? <div style={styles.hint}>{hint}</div> : null}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>时间</th>
              <th style={styles.th}>维度</th>
              <th style={styles.th}>名称</th>
              <th style={styles.th}>状态</th>
              <th style={styles.th}>错误摘要</th>
              <th style={styles.th}>Step</th>
              <th style={styles.th}>Workflow</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.scope}-${r.id}`}
                style={{
                  ...styles.tr,
                  ...(onSelectWorkflow && r.workflowRunId ? {} : { cursor: "default" }),
                }}
                onClick={() => {
                  if (onSelectWorkflow && r.workflowRunId) {
                    onSelectWorkflow(r.workflowRunId);
                  }
                }}
                title={r.errorMessage ?? ""}
              >
                <td style={{ ...styles.td, whiteSpace: "nowrap" }}>{formatTs(r.ts)}</td>
                <td style={styles.td}>
                  <span
                    style={{
                      ...scopeBadgeStyle,
                      color: SCOPE_COLOR[r.scope],
                      borderColor: SCOPE_COLOR[r.scope],
                    }}
                  >
                    {SCOPE_LABEL[r.scope]}
                  </span>
                </td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>{r.name}</td>
                <td style={styles.td}>{r.status}</td>
                <td style={{ ...styles.td, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {truncate(r.errorMessage, 120) || "—"}
                </td>
                <td style={styles.td}>{r.stepIndex ?? "—"}</td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }} title={r.workflowRunId ?? ""}>
                  {r.workflowRunId ? `${r.workflowRunId.slice(0, 10)}…` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading ? <div style={styles.empty}>暂无失败事件</div> : null}
      </div>
    </section>
  );
};

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function truncate(text: string | null, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ─────────────────────────── styles ───────────────────────────

const panelStyle = {
  background: "var(--qb-main-card-bg, #111114)",
  border: "1px solid var(--qb-main-input-border, #27272a)",
  borderRadius: 10,
  padding: "12px 14px",
  marginTop: 12,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
  flexWrap: "wrap" as const,
};

const titleStyle = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--qb-monitor-title-fg, inherit)",
};

const countsStyle = {
  display: "flex",
  gap: 14,
  fontSize: 11,
  fontWeight: 600,
};

const scopeBadgeStyle = {
  display: "inline-block",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.04em",
  padding: "2px 6px",
  borderRadius: 4,
  border: "1px solid",
};
