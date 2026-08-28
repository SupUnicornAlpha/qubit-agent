/**
 * 监控 · 工作流 tab：从 MonitorDashboard.tsx 拆出（scope === "workflow" 块）。
 * 纯机械拆分。
 */
import type { FC } from "react";
import { Fragment } from "react";
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
  WorkflowTimeline,
} from "../../api/types";
import {
  Kpi,
  monitorAxisTick,
  monitorGridStroke,
  monitorTooltipStyle,
  styles,
  type WorkflowRow,
  type WorkflowSessionGroup,
} from "./monitor-shared";
import { groupStreamEventsByRun } from "../../lib/groupStreamEventsByRun";
import { StreamTimelineGroupCard } from "../chat/StreamTimelineGroupCard";
import { WorkflowEvalPanel } from "./WorkflowEvalPanel";
import { SessionEvalRollupPanel } from "./SessionEvalRollupPanel";

export type WorkflowTabProps = {
  workflowList: WorkflowRow[];
  workflowGroups: WorkflowSessionGroup[];
  unboundWorkflows: WorkflowRow[];
  selectedWorkflowId: string | null;
  drawerDetail: string;
  workflowObservability: WorkflowObservability | null;
  workflowTimeline: WorkflowTimeline | null;
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
  workflowGroups,
  unboundWorkflows,
  selectedWorkflowId,
  drawerDetail,
  workflowObservability,
  workflowTimeline,
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
  const groupedView = workflowGroups.length > 0 || unboundWorkflows.length > 0;

  const renderWorkflowRow = (row: WorkflowRow) => (
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
      <td style={styles.td}>{row.source ?? "—"}</td>
      <td style={styles.td}>{row.loopKind ?? "native"}</td>
      <td style={styles.td} title={row.goal ?? undefined}>
        {(row.goal ?? "—").slice(0, 48)}
        {(row.goal?.length ?? 0) > 48 ? "…" : ""}
      </td>
      <td style={styles.td}>
        {row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}
      </td>
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
  );

  const traceItems = workflowTimeline
    ? [
        ...workflowTimeline.conversationMessages.map((message) => ({
          id: `conversation-${message.id}`,
          at: message.createdAt,
          label: `${message.role === "user" ? "用户" : message.sender} · ${message.status}`,
          kind: "会话",
          detail: message.content,
          traceId: message.traceId,
        })),
        ...workflowTimeline.a2aMessages.map((message) => ({
          id: `a2a-${message.id}`,
          at: message.createdAt,
          label: `${message.senderRole} → ${message.receiverRole ?? "broadcast"} · ${message.messageType}`,
          kind: "A2A",
          detail: JSON.stringify(message.payloadJson, null, 2),
          traceId: message.traceId,
        })),
        ...workflowTimeline.steps.map((step) => ({
          id: `step-${step.id}`,
          at: step.createdAt,
          label: `${step.phase}${step.stepIndex != null ? ` · #${step.stepIndex}` : ""}`,
          kind: "执行",
          detail:
            [step.thought, step.observation].filter(Boolean).join("\n\n") ||
            `${step.toolCalls.length} 次工具调用`,
          traceId: "",
        })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    : [];

  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        工作流 · 筛选与列表（按会话分组）
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

      <SessionEvalRollupPanel
        sessionId={sessionFilter}
        onSelectWorkflow={(id) => void onSelectWorkflow(id)}
      />

      <div style={styles.split}>
        <section style={styles.col}>
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>状态</th>
                  <th style={styles.th}>模式</th>
                  <th style={styles.th}>来源</th>
                  <th style={styles.th}>Loop</th>
                  <th style={styles.th}>目标</th>
                  <th style={styles.th}>开始时间</th>
                  <th style={styles.th}>ID</th>
                  <th style={styles.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {groupedView
                  ? workflowGroups.map((group) => (
                      <Fragment key={`session-${group.sessionId}`}>
                        <tr style={styles.tr}>
                          <td colSpan={8} style={{ ...styles.td, fontWeight: 600, background: "var(--qb-panel-muted, rgba(255,255,255,0.03))" }}>
                            会话 · {group.sessionTitle ?? group.sessionId.slice(0, 12) + "…"}
                            <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--qb-main-meta, #71717a)" }}>
                              {group.workflows.length} workflow · {group.sessionId.slice(0, 8)}…
                            </span>
                          </td>
                        </tr>
                        {group.workflows.map((row) => renderWorkflowRow(row))}
                      </Fragment>
                    ))
                  : workflowList.map((row) => renderWorkflowRow(row))}
                {groupedView && unboundWorkflows.length > 0 ? (
                  <>
                    <tr key="session-unbound" style={styles.tr}>
                      <td colSpan={8} style={{ ...styles.td, fontWeight: 600, background: "var(--qb-panel-muted, rgba(255,255,255,0.03))" }}>
                        未绑定会话
                        <span style={{ marginLeft: 8, fontWeight: 400, color: "var(--qb-main-meta, #71717a)" }}>
                          {unboundWorkflows.length} workflow
                        </span>
                      </td>
                    </tr>
                    {unboundWorkflows.map((row) => renderWorkflowRow(row))}
                  </>
                ) : null}
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
              {/* P0-05：KPI 新增 "LLM 调用" + "成本"；都来自 llm_call_log，含内部直调 */}
              <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
                <Kpi label="LLM 调用" value={String(workflowObservability.llm.llmCalls)} accent="#a78bfa" />
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
                  label="成本(USD)"
                  value={
                    workflowObservability.llm.totalCostUsd != null
                      ? workflowObservability.llm.totalCostUsd.toFixed(4)
                      : workflowObservability.llm.llmCalls > 0
                        ? "0.0000"
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
                          <th style={styles.th}>成本(USD)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workflowObservability.byAgentRole.map((r) => (
                          <tr key={r.role} style={styles.tr}>
                            <td style={styles.td}>{r.role}</td>
                            {/* P0-05：从 reasonSteps 改为 llmCalls——后者含内部直调（更准） */}
                            <td style={styles.td}>{r.llmCalls}</td>
                            <td style={styles.td}>{r.toolCalls}</td>
                            <td style={styles.td}>{r.mcpCalls}</td>
                            <td style={styles.td}>{r.tokens ?? "—"}</td>
                            <td style={styles.td}>
                              {r.tokens != null || r.llmCalls > 0
                                ? (r.llmCostUsd ?? 0).toFixed(4)
                                : "—"}
                            </td>
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
            工作流 · Eval 平台（Score / 标注 / Golden）
          </h3>
          <WorkflowEvalPanel workflowRunId={selectedWorkflowId} />
          <h3 className="qb-monitor__section" style={styles.subTitle}>
            工作流 · 详情（JSON）
          </h3>
          <pre style={styles.streamBox}>{drawerDetail || "点击表格一行加载详情…"}</pre>
        </section>
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        工作流 · 对话 Trace（持久化）
      </h3>
      <div style={styles.streamList}>
        {!selectedWorkflowId ? (
          <div style={styles.empty}>请先在表格中选择一条工作流</div>
        ) : !workflowTimeline ? (
          <div style={styles.empty}>正在加载该工作流的会话、A2A 与执行记录…</div>
        ) : traceItems.length === 0 ? (
          <div style={styles.empty}>该工作流暂无可追溯记录</div>
        ) : (
          traceItems.slice(-200).map((item) => (
            <article key={item.id} style={styles.streamBox}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <strong>{item.kind}</strong>
                <span>{item.label}</span>
                <time style={{ marginLeft: "auto", color: "var(--qb-main-meta, #71717a)" }}>
                  {new Date(item.at).toLocaleString()}
                </time>
              </div>
              {item.traceId ? (
                <div style={{ color: "var(--qb-main-meta, #71717a)", marginBottom: 6 }}>
                  trace: {item.traceId}
                </div>
              ) : null}
              <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {item.detail.slice(0, 4000)}
              </div>
            </article>
          ))
        )}
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        工作流 · 实时 Trace（仅当前选中 workflow）
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
