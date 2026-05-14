import type { FC, MouseEvent } from "react";
import { useId, useMemo } from "react";
import type { AnalystTeamGraphEdge, AnalystTeamGraphNode } from "../../api/types";

export type TeamGraphSelection =
  | null
  | { kind: "node"; role: string }
  | { kind: "edge"; a: string; b: string };

/** 与后端 edge key 一致：无向 */
export function teamGraphUndirectedKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

export type TeamGraphActivity = {
  /** 近期有对话 / handoff 参与的角色 */
  hotRoles: ReadonlySet<string>;
  /** 近期活跃的无向边 key（a||b） */
  hotEdgeKeys: ReadonlySet<string>;
  isRunning: boolean;
};

const emptyActivity: TeamGraphActivity = {
  hotRoles: new Set(),
  hotEdgeKeys: new Set(),
  isRunning: false,
};

export const TeamAgentGraph: FC<{
  nodes: AnalystTeamGraphNode[];
  edges: AnalystTeamGraphEdge[];
  width: number;
  height: number;
  selection: TeamGraphSelection;
  onSelectNode: (role: string) => void;
  onSelectEdge: (a: string, b: string) => void;
  onClear: () => void;
  /** 由父组件根据 interactions 时间窗计算，用于高亮「正在通信」的边与节点 */
  activity?: TeamGraphActivity;
}> = ({
  nodes,
  edges,
  width,
  height,
  selection,
  onSelectNode,
  onSelectEdge,
  onClear,
  activity = emptyActivity,
}) => {
  const uid = useId().replace(/:/g, "");
  const markerId = `qb-team-arrow-${uid}`;

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.34;
  const pos = new Map<string, { x: number; y: number }>();
  const n = Math.max(nodes.length, 1);
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    pos.set(node.role, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });

  const onBgClick = (e: MouseEvent<SVGSVGElement>) => {
    if (e.target === e.currentTarget) onClear();
  };

  const css = useMemo(
    () => `
@keyframes qb-team-edge-pulse {
  0%, 100% { stroke-opacity: 0.95; stroke-width: 2.4px; }
  50% { stroke-opacity: 0.55; stroke-width: 1.8px; }
}
@keyframes qb-team-node-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.55; }
}
`,
    []
  );

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        display: "block",
        maxWidth: "100%",
        cursor: "default",
        background: "var(--qb-team-canvas-bg, #0c0c0e)",
        borderRadius: 8,
      }}
      onClick={onBgClick}
    >
      <defs>
        <style type="text/css">{css}</style>
        <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
          <path d="M0,0 L9,4.5 L0,9 z" fill="var(--qb-team-edge-fg, #71717a)" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="transparent" />
      {edges.map((ed) => {
        const pa = pos.get(ed.a);
        const pb = pos.get(ed.b);
        if (!pa || !pb) return null;
        const selEdge = selection?.kind === "edge" && teamGraphUndirectedKey(selection.a, selection.b) === ed.key;
        const traffic = (ed.messageCount ?? 0) + (ed.toolCount ?? 0) > 0;
        const isHot = activity.hotEdgeKeys.has(ed.key);
        const strokeMain = selEdge
          ? "var(--qb-team-edge-active, #3b82f6)"
          : isHot
            ? "var(--qb-team-edge-hot, #60a5fa)"
            : "var(--qb-team-edge-fg, #71717a)";
        const strokeW = selEdge ? 2.4 : isHot ? 2 : traffic ? 1.6 : 1.25;
        const dash = traffic ? undefined : "7 5";
        const opacity = traffic ? (isHot ? 1 : 0.82) : 0.42;
        const hitW = Math.max(14, strokeW + 10);
        return (
          <g key={ed.key}>
            <line
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke="transparent"
              strokeWidth={hitW}
              style={{ cursor: "pointer" }}
              onClick={(e: MouseEvent<SVGLineElement>) => {
                e.stopPropagation();
                onSelectEdge(ed.a, ed.b);
              }}
            />
            <line
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke={strokeMain}
              strokeWidth={strokeW}
              strokeDasharray={dash}
              strokeOpacity={opacity}
              markerEnd={`url(#${markerId})`}
              style={{
                cursor: "pointer",
                pointerEvents: "none",
                animation: isHot && activity.isRunning ? "qb-team-edge-pulse 1.1s ease-in-out infinite" : undefined,
              }}
            />
            <text
              x={(pa.x + pb.x) / 2}
              y={(pa.y + pb.y) / 2 - 8}
              textAnchor="middle"
              fill="var(--qb-team-meta, #a1a1aa)"
              fontSize={10}
              style={{ pointerEvents: "none" }}
            >
              {(() => {
                const parts: string[] = [];
                if (ed.messageCount) parts.push(`对话 ${ed.messageCount}`);
                if (ed.toolCount) parts.push(`工具 ${ed.toolCount}`);
                if (parts.length > 0) return parts.join(" · ");
                return traffic ? "" : "拓扑";
              })()}
            </text>
          </g>
        );
      })}
      {nodes.map((node) => {
        const p = pos.get(node.role);
        if (!p) return null;
        const sel = selection?.kind === "node" && selection.role === node.role;
        const w = 108;
        const h = 46;
        const hot = activity.hotRoles.has(node.role);
        const fill = sel
          ? "var(--qb-team-node-selected-fill, rgba(30,58,95,0.55))"
          : hot
            ? "var(--qb-team-node-hot-fill, rgba(59,130,246,0.18))"
            : "var(--qb-main-card-bg, #18181b)";
        const stroke = sel
          ? "var(--qb-team-node-selected-stroke, #3b82f6)"
          : hot
            ? "var(--qb-team-node-hot-stroke, #60a5fa)"
            : "var(--qb-main-card-border, #3f3f46)";
        const sw = sel ? 2.2 : hot ? 2 : 1;
        return (
          <g key={node.role}>
            <rect
              x={p.x - w / 2}
              y={p.y - h / 2}
              width={w}
              height={h}
              rx={10}
              fill={fill}
              stroke={stroke}
              strokeWidth={sw}
              style={{
                cursor: "pointer",
                animation: hot && activity.isRunning ? "qb-team-node-pulse 1.2s ease-in-out infinite" : undefined,
              }}
              onClick={(e: MouseEvent<SVGRectElement>) => {
                e.stopPropagation();
                onSelectNode(node.role);
              }}
            />
            <text
              x={p.x}
              y={p.y - 5}
              textAnchor="middle"
              fill="var(--qb-body-fg, #e4e4e7)"
              fontSize={11}
              fontWeight={600}
              style={{ pointerEvents: "none" }}
            >
              {node.label.length > 11 ? `${node.label.slice(0, 10)}…` : node.label}
            </text>
            <text
              x={p.x}
              y={p.y + 11}
              textAnchor="middle"
              fill="var(--qb-team-meta, #71717a)"
              fontSize={9}
              style={{ pointerEvents: "none" }}
            >
              {node.role}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
