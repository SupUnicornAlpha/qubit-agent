/**
 * 监控 · Agent tab：从 MonitorDashboard.tsx 拆出（scope === "agent" 块）。
 * 纯机械拆分。
 */
import type { FC } from "react";
import { useMemo, useState } from "react";
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
import type { SessionAgentBoardItem } from "../../api/types";
import {
  AgentPoolSection,
  AgentRuntimeCard,
  CHART_COLORS,
  agentStatusColor,
  codeInline,
  monitorAxisTick,
  monitorGridStroke,
  monitorTooltipStyle,
  shortId,
  styles,
  type AgentCardView,
} from "./monitor-shared";
import { AgentDetailDrillDown } from "./AgentDetailDrillDown";

export type AgentTabProps = {
  graphAgentCards: AgentCardView[];
  a2aAgentCards: AgentCardView[];
  legacyAgentCards: AgentCardView[];
  latencyBarData: { name: string; p50: number; p95: number }[];
  healthPieData: { name: string; value: number }[];
  sessionFilter: string;
  sessionAgentsBoard: SessionAgentBoardItem[];
  loading: boolean;
  metricsHint: string | null;
  /** 失败实例点击 → 跳到 workflow tab 并选中 */
  onJumpToWorkflow?: (workflowRunId: string) => void;
  onRefreshMetrics: () => void | Promise<void>;
  onAggregateMetrics: () => void | Promise<void>;
};

export const AgentTab: FC<AgentTabProps> = ({
  graphAgentCards,
  a2aAgentCards,
  legacyAgentCards,
  latencyBarData,
  healthPieData,
  sessionFilter,
  sessionAgentsBoard,
  loading,
  metricsHint,
  onJumpToWorkflow,
  onRefreshMetrics,
  onAggregateMetrics,
}) => {
  /**
   * 下钻选中状态：点击 Agent 卡片 → 在下方就近展开 drill-down 面板。
   * 不抽到父组件，因为 P0 范围内只有 AgentTab 本身需要这个状态。
   */
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(null);
  const allCards = useMemo(
    () => [...graphAgentCards, ...a2aAgentCards, ...legacyAgentCards],
    [graphAgentCards, a2aAgentCards, legacyAgentCards]
  );
  const selectedCard = useMemo(
    () => (selectedDefinitionId ? allCards.find((a) => a.definitionId === selectedDefinitionId) ?? null : null),
    [allCards, selectedDefinitionId]
  );
  const toggleSelectDefinition = (defId: string) =>
    setSelectedDefinitionId((prev) => (prev === defId ? null : defId));

  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        Agent · 持久化指标
      </h3>
      <div style={styles.form}>
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

      <div className="qb-monitor__chart-grid" style={styles.chartGrid}>
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>P50 / P95 工具延迟（按 definition / 角色）</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={latencyBarData}>
              <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
              <XAxis
                dataKey="name"
                tick={{ ...monitorAxisTick, fontSize: 10 }}
                interval={0}
                angle={-18}
                dy={8}
                height={60}
              />
              <YAxis tick={monitorAxisTick} />
              <Tooltip contentStyle={monitorTooltipStyle} />
              <Legend />
              <Bar dataKey="p50" name="p50 ms" fill="#3b82f6" />
              <Bar dataKey="p95" name="p95 ms" fill="#a78bfa" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>成功 vs 错误（聚合窗口汇总）</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={healthPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={72} label>
                {healthPieData.map((_, i) => (
                  <Cell key={String(i)} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={monitorTooltipStyle} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        Agent · 注册实例（运行时列表）
      </h3>
      <p style={styles.scopeHint}>
        同一角色会在 Graph、A2A 各注册一次（两套执行通道，并非重复故障）。下方「会话工作流实例」为某次
        workflow 上的真实任务实例。
      </p>
      <div style={styles.poolSplit}>
        <AgentPoolSection
          poolKey="graph"
          agents={graphAgentCards}
          selectedDefinitionId={selectedDefinitionId}
          onSelectDefinition={toggleSelectDefinition}
        />
        <AgentPoolSection
          poolKey="a2a"
          agents={a2aAgentCards}
          selectedDefinitionId={selectedDefinitionId}
          onSelectDefinition={toggleSelectDefinition}
        />
      </div>
      {legacyAgentCards.length > 0 ? (
        <>
          <h4 style={styles.poolTitle}>未标注执行路径</h4>
          <div style={styles.agentGrid}>
            {legacyAgentCards.map((a) => (
              <AgentRuntimeCard
                key={a.id}
                agent={a}
                pathLabel="?"
                pathAccent="#a1a1aa"
                pathBadgeBg="rgba(161, 161, 170, 0.12)"
                selected={selectedDefinitionId === a.definitionId}
                onClick={() => toggleSelectDefinition(a.definitionId)}
              />
            ))}
          </div>
        </>
      ) : null}

      {selectedCard ? (
        <AgentDetailDrillDown
          definitionId={selectedCard.definitionId}
          role={selectedCard.role}
          name={selectedCard.name}
          onJumpToWorkflow={onJumpToWorkflow}
          onClose={() => setSelectedDefinitionId(null)}
        />
      ) : null}

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        会话工作流实例
      </h3>
      {!sessionFilter ? (
        <div style={styles.empty}>在「整体」页选择 Session 筛选后，此处展示该会话内各 workflow 的 Agent 实例</div>
      ) : sessionAgentsBoard.length === 0 ? (
        <div style={styles.empty}>当前 session 暂无 workflow 实例记录</div>
      ) : (
        <div style={styles.sessionBoardTable}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>角色</th>
                <th style={styles.th}>Workflow</th>
                <th style={styles.th}>状态</th>
                <th style={styles.th}>迭代</th>
                <th style={styles.th}>最近步骤</th>
                <th style={styles.th}>开始时间</th>
              </tr>
            </thead>
            <tbody>
              {sessionAgentsBoard.slice(0, 80).map((item) => (
                <tr key={item.instanceId}>
                  <td style={styles.td}>
                    <div style={styles.cardName}>{item.role}</div>
                    {item.name !== item.role ? (
                      <div style={styles.cardDescMuted}>{item.name}</div>
                    ) : null}
                  </td>
                  <td style={styles.td} title={item.workflowRunId}>
                    <code style={codeInline}>{shortId(item.workflowRunId)}</code>
                    {item.workflowMode ? ` · ${item.workflowMode}` : ""}
                    {item.workflowStatus ? ` · ${item.workflowStatus}` : ""}
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        color: agentStatusColor(item.status, item.status === "running"),
                      }}
                    >
                      {item.status}
                    </span>
                    {item.lastError ? (
                      <div style={styles.errorLine} title={item.lastError}>
                        {item.lastError.slice(0, 60)}
                        {item.lastError.length > 60 ? "…" : ""}
                      </div>
                    ) : null}
                  </td>
                  <td style={styles.td}>{item.currentIteration}</td>
                  <td style={styles.td}>
                    {item.latestStep ? `${item.latestStep.phase} #${item.latestStep.stepIndex}` : "—"}
                  </td>
                  <td style={styles.td}>
                    {item.workflowStartedAt ? new Date(item.workflowStartedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
