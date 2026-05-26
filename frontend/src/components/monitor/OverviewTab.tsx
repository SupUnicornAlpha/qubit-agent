/**
 * 监控 · 整体 tab：从 MonitorDashboard.tsx 拆出（scope === "overview" 块）。
 * 拆分纯机械、无逻辑改动。所有 state / handler 由父组件透传。
 */
import type { FC } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AgentLoopKind, WorkflowMode } from "../../api/types";
import type { MonitorSummary, listStrategyRuntimes } from "../../api/backend";
import {
  CHART_COLORS,
  Kpi,
  monitorAxisTick,
  monitorGridStroke,
  monitorTooltipStyle,
  styles,
} from "./monitor-shared";
import { FailuresPanel } from "./FailuresPanel";
import { LlmUsagePanel } from "./LlmUsagePanel";

export type StrategyRuntime = Awaited<ReturnType<typeof listStrategyRuntimes>>[number];

export type OverviewKpis = {
  total: number;
  running: number;
  failed: number;
  openAlerts: number;
  agents: number;
  strategyRunning: number;
  completed24h: number;
  failed24h: number;
  avgQuality: number | undefined;
  stuckCount: number;
};

export type OverviewTabProps = {
  kpis: OverviewKpis;
  summary: MonitorSummary | null;
  loading: boolean;
  metricsHint: string | null;
  strategyRuntimes: StrategyRuntime[];
  workflowStatusPie: { name: string; value: number }[];
  workflowModeBar: { name: string; count: number }[];
  goal: string;
  setGoal: (v: string) => void;
  mode: WorkflowMode;
  setMode: (v: WorkflowMode) => void;
  createLoopKind: AgentLoopKind;
  setCreateLoopKind: (v: AgentLoopKind) => void;
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean) => void;
  projectId: string;
  /** 用于失败列表点击行时定位 workflow（同样的 setter / 跳转回调） */
  sessionFilter?: string | undefined;
  onJumpToWorkflow?: (workflowRunId: string) => void;
  onScanStuck: () => void | Promise<void>;
  onSearch: () => void | Promise<void>;
  onRefreshMetrics: () => void | Promise<void>;
  onAggregateMetrics: () => void | Promise<void>;
  onCreate: (event: React.FormEvent) => void | Promise<void>;
};

export const OverviewTab: FC<OverviewTabProps> = ({
  kpis,
  summary,
  loading,
  metricsHint,
  strategyRuntimes,
  workflowStatusPie,
  workflowModeBar,
  goal,
  setGoal,
  mode,
  setMode,
  createLoopKind,
  setCreateLoopKind,
  autoRefresh,
  setAutoRefresh,
  projectId,
  sessionFilter,
  onJumpToWorkflow,
  onScanStuck,
  onSearch,
  onRefreshMetrics,
  onAggregateMetrics,
  onCreate,
}) => {
  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        整体 · 运行态势
      </h3>
      <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
        <Kpi label="工作流总数" value={String(kpis.total)} />
        <Kpi label="运行中" value={String(kpis.running)} accent="#22c55e" />
        <Kpi label="失败" value={String(kpis.failed)} accent="#ef4444" />
        <Kpi label="未关闭告警" value={String(kpis.openAlerts)} accent="#eab308" />
        <Kpi label="24h 完成" value={String(kpis.completed24h)} />
        <Kpi label="24h 失败" value={String(kpis.failed24h)} accent="#f97316" />
        <Kpi
          label="平均质量分"
          value={kpis.avgQuality != null ? kpis.avgQuality.toFixed(3) : "—"}
          accent="#a78bfa"
        />
        <Kpi
          label="卡住运行中"
          value={String(kpis.stuckCount)}
          accent={kpis.stuckCount > 0 ? "#ef4444" : undefined}
        />
        <Kpi label="已注册 Agent" value={String(kpis.agents)} />
        <Kpi label="策略运行时" value={String(kpis.strategyRunning)} accent="#38bdf8" />
      </div>

      {summary && summary.stuckRunning.length > 0 ? (
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>
            长时间 running 的工作流（超过 {summary.stuckThresholdMinutes} 分钟）
          </div>
          <ul style={{ margin: 0, padding: "8px 12px 8px 24px", fontSize: 12, lineHeight: 1.6 }}>
            {summary.stuckRunning.slice(0, 8).map((w) => (
              <li key={w.id}>
                {w.id.slice(0, 10)}… · {w.mode} · 始于{" "}
                {w.startedAt ? new Date(w.startedAt).toLocaleString() : "—"}
              </li>
            ))}
          </ul>
          <button className="qb-btn-secondary" type="button" disabled={loading} onClick={() => void onScanStuck()}>
            扫描并生成卡住告警
          </button>
        </div>
      ) : null}

      {strategyRuntimes.length > 0 ? (
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>策略运行时（纸面/实盘）</div>
          <ul style={{ margin: 0, padding: "8px 12px 8px 24px", fontSize: 12, lineHeight: 1.6 }}>
            {strategyRuntimes.slice(0, 12).map((r) => (
              <li key={r.id}>
                {r.symbol} · {r.market} · {r.status} · {r.executionMode}
                {r.lastSignalAt ? ` · 最近信号 ${r.lastSignalAt}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="qb-monitor__chart-grid" style={styles.chartGrid}>
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>工作流列表 · 按状态分布（当前筛选结果）</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={workflowStatusPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={72} label>
                {workflowStatusPie.map((_, i) => (
                  <Cell key={String(i)} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={monitorTooltipStyle} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>工作流列表 · 按模式数量</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={workflowModeBar}>
              <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
              <XAxis dataKey="name" tick={monitorAxisTick} />
              <YAxis allowDecimals={false} tick={monitorAxisTick} />
              <Tooltip contentStyle={monitorTooltipStyle} />
              <Bar dataKey="count" name="数量" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        整体 · 近 1h 失败列表（tool / mcp / skill / agent）
      </h3>
      <FailuresPanel
        defaultScope="all"
        defaultWindowMinutes={60}
        defaultLimit={20}
        sessionId={sessionFilter || undefined}
        autoRefreshMs={30_000}
        onSelectWorkflow={onJumpToWorkflow}
        title="跨维度失败"
      />

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        整体 · LLM 用量（24h / provider × model / cost & token / 错误 top）
      </h3>
      <LlmUsagePanel
        sessionId={sessionFilter || undefined}
        defaultWindowMinutes={1440}
        autoRefreshMs={60_000}
      />

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        整体 · 指标聚合（写入 Agent 维度指标）
      </h3>
      <div style={styles.form}>
        <button className="qb-btn-secondary" type="button" onClick={() => void onSearch()}>
          刷新工作流列表
        </button>
        <button className="qb-btn-secondary" type="button" onClick={() => void onRefreshMetrics()}>
          刷新指标
        </button>
        <button
          className="qb-btn-primary-brand"
          type="button"
          disabled={loading}
          onClick={() => void onAggregateMetrics()}
        >
          {loading ? "聚合中…" : "聚合过去24h并刷新"}
        </button>
      </div>
      {metricsHint ? <div style={styles.hint}>{metricsHint}</div> : null}

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        整体 · 新建工作流并订阅 SSE
      </h3>
      <form style={styles.form} onSubmit={(e) => void onCreate(e)}>
        <input style={styles.input} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="工作流目标" />
        <select style={styles.select} value={mode} onChange={(e) => setMode(e.target.value as WorkflowMode)}>
          <option value="research">research</option>
          <option value="backtest">backtest</option>
          <option value="simulation">simulation</option>
          <option value="live">live</option>
        </select>
        <select
          style={styles.select}
          value={createLoopKind}
          onChange={(e) => setCreateLoopKind(e.target.value as AgentLoopKind)}
          title="Agent 执行循环"
        >
          <option value="native">loop: native</option>
          <option value="claude_cli">loop: claude_cli</option>
          <option value="codex_cli">loop: codex_cli</option>
        </select>
        <button className="qb-btn-primary-brand" type="submit" disabled={!projectId}>
          创建并订阅 SSE
        </button>
        <label style={styles.check}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          每 12s 自动刷新列表
        </label>
      </form>
    </>
  );
};
