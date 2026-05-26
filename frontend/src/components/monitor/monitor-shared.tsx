/**
 * Monitor 子组件共享：类型 / 工具函数 / 通用 styles / 小展示组件。
 *
 * 来源：原 MonitorDashboard.tsx（1481 行）拆分时抽出。
 * 拆分原则：本文件**仅**承载多个 tab 共用的内容；不放任何 useState / API 调用。
 */
import type { CSSProperties, FC } from "react";
import type {
  AgentRuntimeMetricRecord,
  AgentSummary,
} from "../../api/types";

// ------------------------------ 类型 ------------------------------

export type MonitorScope =
  | "overview"
  | "workflow"
  | "agent"
  | "skills"
  | "diagnostics"
  | "stream"
  | "alerts_eval";

export type WorkflowRow = {
  id: string;
  status: string;
  mode: string;
  loopKind?: string;
  sessionId?: string | null;
  startedAt?: string | null;
  goal?: string | null;
};

export type AgentCardView = AgentSummary & {
  metrics?: AgentRuntimeMetricRecord;
};

export const SCOPE_TABS: { id: MonitorScope; label: string; hint: string }[] = [
  { id: "overview", label: "整体", hint: "全局 KPI、工作流分布、指标聚合、跨维度失败" },
  { id: "workflow", label: "工作流", hint: "列表、详情、质量快照、按工作流过滤 SSE" },
  { id: "agent", label: "Agent", hint: "注册实例、延迟与健康度、点击卡片下钻指标" },
  { id: "skills", label: "Skills", hint: "Skill 召回成功率、失败列表（显式 agent_skill_run 归因）" },
  {
    id: "diagnostics",
    label: "工具/MCP 排障",
    hint: "按单一工具或 MCP server 下钻：错误 Top、沙箱阻断分类、熔断状态、最近调用流水",
  },
  { id: "stream", label: "实时流", hint: "全局 SSE 折叠时间线" },
  { id: "alerts_eval", label: "告警与评测", hint: "告警确认、评测数据集与 run" },
];

// ------------------------------ 工具函数 ------------------------------

export function asWorkflowRows(rows: unknown[]): WorkflowRow[] {
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      status: String(o.status ?? ""),
      mode: String(o.mode ?? ""),
      loopKind: o.loopKind != null ? String(o.loopKind) : "native",
      sessionId: o.sessionId != null ? String(o.sessionId) : null,
      startedAt: o.startedAt != null ? String(o.startedAt) : null,
      goal: o.goal != null ? String(o.goal) : null,
    };
  });
}

export function shortId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function agentStatusColor(status: string | undefined, running: boolean): string {
  if (status === "error") return "#f87171";
  if (status === "running" || running) return "#4ade80";
  if (status === "idle") return "#a1a1aa";
  return "#eab308";
}

/** API 未带 executionPath 时（旧后端）按实例 ID 推断所属长驻池 */
export function resolvePoolExecutionPath(agent: AgentSummary): "graph" | "a2a" | null {
  if (agent.executionPath === "graph" || agent.executionPath === "a2a") {
    return agent.executionPath;
  }
  if (agent.id.startsWith("graph-")) return "graph";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agent.id)) {
    return "a2a";
  }
  return null;
}

export function buildAgentCardViews(
  agents: AgentSummary[],
  metricsByDef: Map<string, AgentRuntimeMetricRecord>
): AgentCardView[] {
  return agents.map((a) => ({
    ...a,
    metrics: metricsByDef.get(a.definitionId),
  }));
}

// ------------------------------ Pool / Card 小组件 ------------------------------

export const POOL_SECTION_META = {
  graph: {
    title: "Graph 长驻池",
    hint: "LangGraph 编排：native loop 的 workflow 默认经此池按角色执行（实例 ID 形如 graph-<role>）",
    accent: "#60a5fa",
    panelBorder: "rgba(59, 130, 246, 0.45)",
    badgeBg: "rgba(59, 130, 246, 0.15)",
  },
  a2a: {
    title: "A2A 长驻池",
    hint: "A2A 消息总线：executionPath=a2a 的 workflow 经此池订阅并派发（实例 ID 为 DB 中的 UUID）",
    accent: "#c4b5fd",
    panelBorder: "rgba(167, 139, 250, 0.45)",
    badgeBg: "rgba(167, 139, 250, 0.15)",
  },
} as const;

export const AgentRuntimeCard: FC<{
  agent: AgentCardView;
  pathLabel: string;
  pathAccent: string;
  pathBadgeBg: string;
  /** 可选：选中态高亮（Agent 下钻用）；不传保持原样 */
  selected?: boolean;
  /** 可选：点击回调（Agent 下钻用） */
  onClick?: () => void;
}> = ({ agent: a, pathLabel, pathAccent, pathBadgeBg, selected, onClick }) => {
  const status = a.status ?? (a.running ? "running" : "stopped");
  const statusColor = agentStatusColor(status, a.running);
  return (
    <div
      style={{
        ...styles.agentCard,
        borderLeft: `3px solid ${pathAccent}`,
        ...(selected ? { outline: `2px solid ${pathAccent}`, outlineOffset: -1 } : {}),
        ...(onClick ? { cursor: "pointer" } : {}),
      }}
      onClick={onClick}
    >
      <div style={styles.agentCardHeader}>
        <div style={styles.cardName}>{a.role}</div>
        <span style={{ ...styles.statusBadge, color: statusColor, borderColor: statusColor }}>{status}</span>
      </div>
      <span
        style={{
          ...styles.pathBadge,
          color: pathAccent,
          background: pathBadgeBg,
          borderColor: pathAccent,
        }}
      >
        {pathLabel}
      </span>
      {a.name && a.name !== a.role ? <div style={styles.cardDesc}>{a.name}</div> : null}
      <div style={styles.cardDesc}>v{a.version || "—"}</div>
      <div style={styles.cardDesc} title={a.id}>
        实例 <code style={codeInline}>{shortId(a.id)}</code>
      </div>
      {a.metrics ? (
        <div style={styles.agentMetrics}>
          <span>24h 运行 {a.metrics.runCount ?? 0}</span>
          <span>成功 {a.metrics.successCount ?? 0}</span>
          <span>错误 {a.metrics.errorCount ?? 0}</span>
          {a.metrics.p50LatencyMs != null ? <span>p50 {Math.round(a.metrics.p50LatencyMs)}ms</span> : null}
        </div>
      ) : (
        <div style={styles.cardDescMuted}>暂无聚合指标</div>
      )}
    </div>
  );
};

export const AgentPoolSection: FC<{
  poolKey: keyof typeof POOL_SECTION_META;
  agents: AgentCardView[];
  /** 透传给每张卡：用于 Agent 下钻 selected/onClick */
  selectedDefinitionId?: string | null;
  onSelectDefinition?: (definitionId: string) => void;
}> = ({ poolKey, agents, selectedDefinitionId, onSelectDefinition }) => {
  const meta = POOL_SECTION_META[poolKey];
  const pathLabel = poolKey.toUpperCase();
  return (
    <section
      style={{
        ...styles.poolPanel,
        borderColor: meta.panelBorder,
      }}
    >
      <div style={styles.poolPanelHeader}>
        <h4 style={{ ...styles.poolTitle, color: meta.accent }}>{meta.title}</h4>
        <span style={styles.poolCount}>{agents.length} 角色</span>
      </div>
      <p style={styles.poolHint}>{meta.hint}</p>
      {agents.length === 0 ? (
        <div style={styles.empty}>该池暂无已注册角色</div>
      ) : (
        <div style={styles.agentGrid}>
          {agents.map((a) => (
            <AgentRuntimeCard
              key={`${poolKey}-${a.id}`}
              agent={a}
              pathLabel={pathLabel}
              pathAccent={meta.accent}
              pathBadgeBg={meta.badgeBg}
              selected={selectedDefinitionId === a.definitionId}
              onClick={
                onSelectDefinition
                  ? () => onSelectDefinition(a.definitionId)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </section>
  );
};

export const Kpi: FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div
    className="qb-monitor__kpi qb-a3d-tilt"
    style={{
      ...styles.kpi,
      borderColor: accent ?? "var(--qb-main-input-border, #3f3f46)",
    }}
  >
    <div style={styles.kpiLabel}>{label}</div>
    <div style={{ ...styles.kpiValue, color: accent ?? "var(--qb-body-fg, #f4f4f5)" }}>{value}</div>
  </div>
);

// ------------------------------ 通用 styles ------------------------------

export const CHART_COLORS = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#a78bfa", "#ec4899"];

export const monitorTooltipStyle: CSSProperties = {
  background: "var(--qb-main-card-bg, #18181b)",
  border: "1px solid var(--qb-main-input-border, #3f3f46)",
  color: "var(--qb-main-input-fg, #e4e4e7)",
};

export const monitorGridStroke = "var(--qb-main-input-border, #27272a)";
export const monitorAxisTick = { fill: "var(--qb-main-meta, #a1a1aa)", fontSize: 11 };

export const wrap: CSSProperties = { maxWidth: 1200, margin: "0 auto" };

export const styles: Record<string, CSSProperties> = {
  title: { fontSize: 26, fontWeight: 700, margin: "0 0 8px", color: "var(--qb-monitor-title-fg, inherit)" },
  lead: { fontSize: 13, color: "var(--qb-monitor-lead-fg, #a1a1aa)", lineHeight: 1.5, marginBottom: 16 },
  kpiRow: { display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  kpi: {
    flex: "1 1 120px",
    minWidth: 100,
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-card-bg, #111114)",
  },
  kpiLabel: { fontSize: 11, color: "var(--qb-main-meta, #71717a)", marginBottom: 4 },
  kpiValue: { fontSize: 22, fontWeight: 700 },
  form: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12, alignItems: "center" },
  input: {
    flex: 1,
    minWidth: 160,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  select: {
    minWidth: 140,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
  },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  subTitle: { fontSize: 16, margin: "18px 0 8px", fontWeight: 600, color: "var(--qb-monitor-title-fg, inherit)" },
  split: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)", gap: 20 },
  col: { minWidth: 0 },
  tableWrap: {
    maxHeight: 320,
    overflow: "auto",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: {
    textAlign: "left",
    padding: "8px 10px",
    background: "var(--qb-stream-box-bg, #1f1f23)",
    color: "var(--qb-main-meta, #a1a1aa)",
    position: "sticky",
    top: 0,
  },
  td: { padding: "8px 10px", borderTop: "1px solid var(--qb-main-input-border, #27272a)", color: "var(--qb-main-input-fg, #e4e4e7)" },
  tr: { cursor: "pointer" },
  trSelected: { background: "var(--qb-tint-strong, rgba(99, 102, 241, 0.12))" },
  empty: { padding: 16, color: "var(--qb-main-meta, #71717a)", fontSize: 13 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 },
  poolSplit: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 16,
    marginBottom: 8,
  },
  poolPanel: {
    background: "var(--qb-main-card-bg, #111114)",
    border: "1px solid",
    borderRadius: 10,
    padding: "12px 14px",
  },
  poolPanelHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  poolTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
  poolCount: { fontSize: 11, color: "var(--qb-main-meta, #71717a)" },
  poolHint: { fontSize: 11, color: "var(--qb-main-meta, #71717a)", lineHeight: 1.45, margin: "0 0 10px" },
  pathBadge: {
    display: "inline-block",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.06em",
    padding: "2px 6px",
    borderRadius: 4,
    border: "1px solid",
    marginBottom: 6,
  },
  agentGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 },
  card: {
    background: "var(--qb-main-card-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    padding: 10,
  },
  agentCard: {
    background: "var(--qb-main-card-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    padding: "10px 12px",
    minHeight: 120,
  },
  agentCardHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    padding: "2px 6px",
    borderRadius: 4,
    border: "1px solid",
    flexShrink: 0,
  },
  agentMetrics: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px 10px",
    marginTop: 8,
    fontSize: 11,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  cardDescMuted: { fontSize: 11, color: "var(--qb-main-meta, #71717a)", marginTop: 4 },
  sessionBoardTable: {
    maxHeight: 360,
    overflow: "auto",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    marginTop: 8,
  },
  errorLine: { fontSize: 11, color: "#f87171", marginTop: 4 },
  cardName: { fontWeight: 600, fontSize: 13, marginBottom: 4, color: "var(--qb-body-fg, inherit)" },
  cardDesc: { fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  chartGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 8 },
  chartBox: {
    background: "var(--qb-main-card-bg, #111114)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 10,
    padding: "10px 12px 4px",
    minHeight: 260,
  },
  chartTitle: { fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)", marginBottom: 6 },
  hint: { fontSize: 12, color: "#eab308", marginBottom: 8 },
  streamList: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 480, overflow: "auto" },
  streamBox: {
    background: "var(--qb-stream-box-bg, #0c0c0e)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    padding: 12,
    maxHeight: 280,
    overflow: "auto",
    fontSize: 11,
    color: "var(--qb-stream-box-fg, #d4d4d8)",
    whiteSpace: "pre-wrap",
  },
  tabBar: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8, alignItems: "center" },
  scopeHint: { fontSize: 12, color: "var(--qb-main-meta, #71717a)", marginBottom: 14 },
};

export const codeInline: CSSProperties = {
  margin: "0 4px",
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--qb-monitor-code-bg, #27272a)",
  fontSize: 12,
};
