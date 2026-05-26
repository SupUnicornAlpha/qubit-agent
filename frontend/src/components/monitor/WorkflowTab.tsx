/**
 * 监控 · 工作流 tab：从 MonitorDashboard.tsx 拆出（scope === "workflow" 块）。
 * 纯机械拆分。
 */
import type { FC } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  WorkflowObservability,
  WorkflowQualitySnapshotRecord,
} from "../../api/types";
import {
  Kpi,
  monitorAxisTick,
  monitorGridStroke,
  monitorTooltipStyle,
  styles,
  type WorkflowRow,
} from "./monitor-shared";
import { groupStreamEventsByRun } from "../../lib/groupStreamEventsByRun";
import { StreamTimelineGroupCard } from "../chat/StreamTimelineGroupCard";

export type WorkflowTabProps = {
  workflowList: WorkflowRow[];
  selectedWorkflowId: string | null;
  drawerDetail: string;
  workflowObservability: WorkflowObservability | null;
  qualitySnapshots: WorkflowQualitySnapshotRecord[];
  qualityLineData: { idx: number; score: number; tools: number; errors: number }[];
  sessionFilter: string;
  setSessionFilter: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  workflowScopedStreamGroups: ReturnType<typeof groupStreamEventsByRun>;
  onSearch: () => void | Promise<void>;
  onSelectWorkflow: (workflowId: string) => void | Promise<void>;
  onCreateQuality: (workflowId: string) => void | Promise<void>;
};

export const WorkflowTab: FC<WorkflowTabProps> = ({
  workflowList,
  selectedWorkflowId,
  drawerDetail,
  workflowObservability,
  qualityLineData,
  sessionFilter,
  setSessionFilter,
  statusFilter,
  setStatusFilter,
  workflowScopedStreamGroups,
  onSearch,
  onSelectWorkflow,
  onCreateQuality,
}) => {
  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        工作流 · 筛选与列表
      </h3>
      <div style={styles.form}>
        <input
          style={styles.input}
          placeholder="sessionId"
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="status (running/failed/...)"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        />
        <button className="qb-btn-secondary" type="button" onClick={() => void onSearch()}>
          查询
        </button>
      </div>

      <div style={styles.split}>
        <section style={styles.col}>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>状态</th>
                  <th style={styles.th}>模式</th>
                  <th style={styles.th}>Loop</th>
                  <th style={styles.th}>开始时间</th>
                  <th style={styles.th}>ID</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {workflowList.map((row) => (
                  <tr
                    key={row.id}
                    style={{
                      ...styles.tr,
                      ...(selectedWorkflowId === row.id ? styles.trSelected : {}),
                    }}
                    onClick={() => void onSelectWorkflow(row.id)}
                  >
                    <td style={styles.td}>{row.status}</td>
                    <td style={styles.td}>{row.mode}</td>
                    <td style={styles.td}>{row.loopKind ?? "native"}</td>
                    <td style={styles.td}>{row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}</td>
                    <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }} title={row.id}>
                      {row.id.slice(0, 10)}…
                    </td>
                    <td style={styles.td}>
                      <button
                        type="button"
                        className="qb-btn-mini"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onCreateQuality(row.id);
                        }}
                      >
                        快照+告警
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {workflowList.length === 0 ? (
              <div style={styles.empty}>暂无数据，请调整筛选或在「整体」中新建</div>
            ) : null}
          </div>
        </section>

        <section style={styles.col}>
          <h3 style={{ ...styles.subTitle, marginTop: 0 }}>工作流 · 质量快照趋势</h3>
          {qualityLineData.length > 0 ? (
            <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
              <div style={styles.chartTitle}>
                {selectedWorkflowId ? `已选 ${selectedWorkflowId.slice(0, 8)}…` : "未选中"} · qualityScore
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={qualityLineData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
                  <XAxis dataKey="idx" tick={monitorAxisTick} />
                  <YAxis domain={[0, 1]} tick={monitorAxisTick} />
                  <Tooltip contentStyle={monitorTooltipStyle} />
                  <Legend />
                  <Line type="monotone" dataKey="score" name="质量分" stroke="#22c55e" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="tools" name="工具调用数" stroke="#3b82f6" strokeWidth={1} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={styles.hint}>选中一行并生成快照后显示趋势</div>
          )}
          <h3 className="qb-monitor__section" style={styles.subTitle}>
            工作流 · 可观测性（LLM / 工具 / MCP）
          </h3>
          {!workflowObservability ? (
            <div style={styles.hint}>选中工作流后加载 LLM、工具与 MCP 调用统计…</div>
          ) : (
            <>
              <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
                <Kpi label="LLM reason 步" value={String(workflowObservability.llm.reasonSteps)} accent="#a78bfa" />
                <Kpi
                  label="Token 合计"
                  value={
                    workflowObservability.llm.totalTokenCount != null
                      ? String(workflowObservability.llm.totalTokenCount)
                      : "—"
                  }
                />
                <Kpi
                  label="Reason 延迟(ms)"
                  value={
                    workflowObservability.llm.totalReasonLatencyMs != null
                      ? String(workflowObservability.llm.totalReasonLatencyMs)
                      : "—"
                  }
                />
                <Kpi label="工具调用" value={String(workflowObservability.tools.total)} accent="#3b82f6" />
                <Kpi label="MCP 调用" value={String(workflowObservability.mcp.total)} accent="#22c55e" />
              </div>
              {workflowObservability.byAgentRole.length > 0 ? (
                <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
                  <div style={styles.chartTitle}>按角色</div>
                  <div style={styles.tableWrap}>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>角色</th>
                          <th style={styles.th}>LLM</th>
                          <th style={styles.th}>工具</th>
                          <th style={styles.th}>MCP</th>
                          <th style={styles.th}>Tokens</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workflowObservability.byAgentRole.map((r) => (
                          <tr key={r.role} style={styles.tr}>
                            <td style={styles.td}>{r.role}</td>
                            <td style={styles.td}>{r.reasonSteps}</td>
                            <td style={styles.td}>{r.toolCalls}</td>
                            <td style={styles.td}>{r.mcpCalls}</td>
                            <td style={styles.td}>{r.tokens ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
              {workflowObservability.mcp.byServer.length > 0 ? (
                <div className="qb-monitor__panel qb-a3d-tilt" style={{ ...styles.chartBox, marginTop: 8 }}>
                  <div style={styles.chartTitle}>MCP 按服务</div>
                  <ul style={{ margin: 0, padding: "8px 12px 8px 24px", fontSize: 12, lineHeight: 1.6 }}>
                    {workflowObservability.mcp.byServer.map((s) => (
                      <li key={s.server}>
                        {s.server} · {s.count} 次 · 成功 {s.success} / 失败 {s.failed}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
          <h3 className="qb-monitor__section" style={styles.subTitle}>
            工作流 · 详情（JSON）
          </h3>
          <pre style={styles.streamBox}>{drawerDetail || "点击表格一行加载详情…"}</pre>
        </section>
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        工作流 · SSE（仅当前选中 workflow）
      </h3>
      <div style={styles.streamList}>
        {!selectedWorkflowId ? (
          <div style={styles.empty}>请先在表格中选择一条工作流</div>
        ) : workflowScopedStreamGroups.length === 0 ? (
          <div style={styles.empty}>该工作流暂无本地缓存的流事件（可在「整体」新建并订阅或从对话触发）</div>
        ) : (
          workflowScopedStreamGroups
            .slice()
            .sort((a, b) => b.at - a.at)
            .slice(0, 20)
            .map((g) => <StreamTimelineGroupCard key={`${g.workflowRunId}-${g.runId}`} item={g} />)
        )}
      </div>
    </>
  );
};
