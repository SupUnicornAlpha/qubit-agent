/**
 * LineageBadge / LineageTrail — 量化工作台 4 个 tab 共享的 lineage 显示组件
 *
 * 与后端 migration 0080 + /api/v1/quant/lineage 对齐。
 *   - `<LineageBadge>` 单 chip：列表里轻量提示「这条是 Agent / 用户 / Promoted」
 *   - `<LineageTrail>` 详情面板：展开来源 chip + 上游链（discovery / parent composition / agent）
 *
 * 设计 trade-off：
 *   - 不依赖任何外部 UI 库，全部 inline style，跟 quant 其他组件一致。
 *   - LineageTrail 不主动拉 children；后端单节点接口已返回了 parent + meta，
 *     如果调用方需要 children 详情，自行用 `getLineage(kind, id)` 拿 LineageNode 再传进来。
 */

import type { CSSProperties, FC } from "react";
import { useEffect, useState } from "react";
import {
  getLineage,
  type LineageAgentSummary,
  type LineageCreatedBy,
  type LineageKind,
  type LineageNode,
  type LineageWorkflowSummary,
} from "../../api/backend";

interface BadgeStyle {
  label: string;
  bg: string;
  fg: string;
  border: string;
  title: string;
}

const BADGE_STYLES: Record<string, BadgeStyle> = {
  user: {
    label: "用户",
    bg: "transparent",
    fg: "var(--qb-text-muted)",
    border: "var(--qb-border-subtle)",
    title: "由用户在 IDE / REST 创建",
  },
  agent: {
    label: "Agent",
    bg: "rgba(54, 173, 106, 0.12)",
    fg: "var(--qb-success, #36ad6a)",
    border: "rgba(54, 173, 106, 0.4)",
    title: "由 Agent 工作流生成",
  },
  discovery_promote: {
    label: "Promoted",
    bg: "rgba(220, 160, 30, 0.12)",
    fg: "#dca01e",
    border: "rgba(220, 160, 30, 0.4)",
    title: "由 Discovery 候选 promote 而来",
  },
  clone: {
    label: "Cloned",
    bg: "rgba(80, 130, 220, 0.12)",
    fg: "#5082dc",
    border: "rgba(80, 130, 220, 0.4)",
    title: "从已有 composition 克隆而来",
  },
  system: {
    label: "System",
    bg: "rgba(150, 150, 150, 0.12)",
    fg: "var(--qb-text-muted)",
    border: "var(--qb-border-subtle)",
    title: "系统内置 / 历史数据",
  },
};

function styleFor(createdBy: LineageCreatedBy): BadgeStyle {
  return BADGE_STYLES[createdBy] ?? BADGE_STYLES.user!;
}

interface BadgeProps {
  createdBy: LineageCreatedBy;
  /** 当后端 agent_instance_id 存在时给 tooltip 加一行 "Agent: <name>" */
  agentName?: string | null;
  /** workflow goal，作为 tooltip 第二行 */
  workflowGoal?: string | null;
  /** "smaller" 用于密集表格，"normal" 用于详情面板 */
  size?: "small" | "normal";
  style?: CSSProperties;
}

export const LineageBadge: FC<BadgeProps> = ({
  createdBy,
  agentName,
  workflowGoal,
  size = "small",
  style,
}) => {
  const s = styleFor(createdBy);
  const titleParts = [s.title];
  if (agentName) titleParts.push(`Agent: ${agentName}`);
  if (workflowGoal) titleParts.push(`Workflow: ${workflowGoal}`);
  return (
    <span
      className="qb-lineage-badge"
      data-qb-lineage-created-by={createdBy}
      title={titleParts.join(" · ")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: size === "small" ? "0 6px" : "2px 8px",
        fontSize: size === "small" ? 10 : 11,
        lineHeight: size === "small" ? "16px" : "18px",
        borderRadius: 999,
        border: `1px solid ${s.border}`,
        background: s.bg,
        color: s.fg,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: s.fg }} />
      {s.label}
    </span>
  );
};

interface ChainItemProps {
  label: string;
  hint?: string;
  tone?: "muted" | "strong";
}

const ChainItem: FC<ChainItemProps> = ({ label, hint, tone = "muted" }) => (
  <div
    className="qb-lineage-chain-item"
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 2,
      padding: "4px 8px",
      border: "1px solid var(--qb-border-subtle)",
      borderRadius: 4,
      background: tone === "strong" ? "var(--qb-bg-elevated)" : "transparent",
      minWidth: 0,
    }}
  >
    <span style={{ fontSize: 11, color: "var(--qb-text-strong, inherit)", fontWeight: 500 }}>
      {label}
    </span>
    {hint ? (
      <span style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>{hint}</span>
    ) : null}
  </div>
);

interface TrailProps {
  /** 已有节点（来自上层批量接口）直接传进来；不传则 lazy fetch */
  node?: LineageNode | null;
  /** 当 node 没传时通过此对 fetch */
  kind?: LineageKind;
  id?: string;
  /** 紧凑模式：只显示 badge + agent + workflow，不显示 parent/children 链 */
  compact?: boolean;
}

/**
 * <LineageTrail> — 详情面板上的 lineage 区块。
 *
 * 两种用法：
 *   1. `<LineageTrail node={node} />` —— 调用方已通过 batch 拿到 LineageNode。
 *   2. `<LineageTrail kind="factor" id={id} />` —— lazy 拉单节点。
 */
export const LineageTrail: FC<TrailProps> = ({ node, kind, id, compact = false }) => {
  const [resolved, setResolved] = useState<LineageNode | null>(node ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResolved(node ?? null);
  }, [node]);

  useEffect(() => {
    if (resolved || !kind || !id) return;
    let cancelled = false;
    setLoading(true);
    getLineage(kind, id)
      .then((n) => {
        if (!cancelled) setResolved(n);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resolved, kind, id]);

  if (loading) {
    return (
      <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>解析 lineage…</div>
    );
  }
  if (error) {
    return (
      <div style={{ fontSize: 11, color: "#c54040" }}>lineage 解析失败：{error}</div>
    );
  }
  if (!resolved) return null;

  const agent: LineageAgentSummary | null = resolved.agent;
  const workflow: LineageWorkflowSummary | null = resolved.workflow;

  return (
    <div
      className="qb-lineage-trail"
      data-qb-lineage-kind={resolved.kind}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 11,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <LineageBadge
          createdBy={resolved.createdBy}
          agentName={agent?.name}
          workflowGoal={workflow?.goal}
          size="normal"
        />
        {agent ? (
          <span style={{ color: "var(--qb-text-muted)" }}>
            Agent ·{" "}
            <span style={{ color: "var(--qb-text-strong, inherit)" }}>
              {agent.name}
            </span>{" "}
            ({agent.role})
          </span>
        ) : null}
        {workflow ? (
          <span style={{ color: "var(--qb-text-muted)" }}>
            Workflow ·{" "}
            <span style={{ color: "var(--qb-text-strong, inherit)" }}>
              {truncate(workflow.goal, 60)}
            </span>{" "}
            [{workflow.status}]
          </span>
        ) : null}
      </div>
      {!compact && resolved.parent ? (
        <ChainSection title="上游产物" parent={resolved.parent} />
      ) : null}
      {!compact && resolved.children.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ color: "var(--qb-text-muted)" }}>引用产物</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {resolved.children.map((c) => (
              <ChainItem
                key={`${c.kind}:${c.id}`}
                label={`${labelForKind(c.kind)} · ${c.label}`}
                hint={describeChild(c)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const ChainSection: FC<{ title: string; parent: LineageNode }> = ({ title, parent }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ color: "var(--qb-text-muted)" }}>{title}</span>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      <ChainItem
        label={`${labelForKind(parent.kind)} · ${parent.label}`}
        hint={describeChild(parent)}
        tone="strong"
      />
      {parent.parent ? (
        <ChainItem
          label={`↑ ${labelForKind(parent.parent.kind)} · ${parent.parent.label}`}
          hint={describeChild(parent.parent)}
        />
      ) : null}
    </div>
  </div>
);

function describeChild(n: LineageNode): string {
  const bits: string[] = [];
  if (n.createdBy && n.createdBy !== "user") bits.push(n.createdBy);
  if (n.agent) bits.push(`@${n.agent.name}`);
  if (n.meta && typeof n.meta.status === "string") bits.push(n.meta.status);
  return bits.join(" · ");
}

function labelForKind(kind: LineageKind): string {
  switch (kind) {
    case "factor":
      return "因子";
    case "rule":
      return "规则";
    case "composition":
      return "组合";
    case "discovery_job":
      return "挖掘任务";
    case "backtest_run":
      return "回测";
    default:
      return kind;
  }
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
