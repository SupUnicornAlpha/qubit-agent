import type { FC, MouseEvent } from "react";
import { useId, useMemo } from "react";
import type { AnalystTeamGraphEdge, AnalystTeamGraphNode } from "../../api/types";
import { buildTopologyEdgePath, sampleLine, type TopoRect } from "../../lib/topologyEdgeRouting";
import {
  computeTeamGraphNodePositions,
  TEAM_GRAPH_NODE_H,
  TEAM_GRAPH_NODE_W,
} from "../../lib/teamGraphLayout";

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

function nodeRect(cx: number, cy: number): TopoRect {
  return { cx, cy, w: TEAM_GRAPH_NODE_W, h: TEAM_GRAPH_NODE_H };
}

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

  const pos = useMemo(
    () => computeTeamGraphNodePositions(nodes, width, height),
    [nodes, width, height]
  );

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
      data-qb-topology-canvas=""
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        display: "block",
        maxWidth: "100%",
        cursor: "default",
        background: "var(--qb-team-canvas-bg, #0c0c0e)",
        border: "1px solid var(--qb-topo-canvas-border, var(--qb-team-table-row-border, #27272a))",
        borderRadius: "var(--qb-topo-canvas-radius, 8px)",
      }}
      onClick={onBgClick}
    >
      <defs>
        <style type="text/css">{css}</style>
        <marker id={markerId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
          <path d="M0,0 L9,4.5 L0,9 z" fill="var(--qb-topo-edge-stroke, #71717a)" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="transparent" />
      {edges.map((ed) => {
        const pa = pos.get(ed.a);
        const pb = pos.get(ed.b);
        if (!pa || !pb) return null;
        const fromRect = nodeRect(pa.x, pa.y);
        const toRect = nodeRect(pb.x, pb.y);
        const d = buildTopologyEdgePath(fromRect, toRect, { curved: true, curveStrength: 0.65 });
        const selEdge = selection?.kind === "edge" && teamGraphUndirectedKey(selection.a, selection.b) === ed.key;
        const traffic = (ed.messageCount ?? 0) + (ed.toolCount ?? 0) > 0;
        const isHot = activity.hotEdgeKeys.has(ed.key);
        const edgeClass = [
          "qb-topo-edge",
          selEdge ? "qb-topo-edge--selected" : isHot ? "qb-topo-edge--hot" : "",
          !traffic ? "qb-topo-edge--dashed" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const hitW = 14;
        const labelParts: string[] = [];
        if (ed.messageCount) labelParts.push(`对话 ${ed.messageCount}`);
        if (ed.toolCount) labelParts.push(`工具 ${ed.toolCount}`);
        const labelText = labelParts.length > 0 ? labelParts.join(" · ") : traffic ? "" : "拓扑";
        const labelPt = sampleLine(pa.x, pa.y, pb.x, pb.y, 0.45);
        return (
          <g key={ed.key}>
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={hitW}
              style={{ cursor: "pointer" }}
              onClick={(e: MouseEvent<SVGPathElement>) => {
                e.stopPropagation();
                onSelectEdge(ed.a, ed.b);
              }}
            />
            <path
              d={d}
              className={edgeClass}
              markerEnd={`url(#${markerId})`}
              style={{
                cursor: "pointer",
                pointerEvents: "none",
                animation: isHot && activity.isRunning ? "qb-team-edge-pulse 1.1s ease-in-out infinite" : undefined,
              }}
            />
            {labelText ? (
              <text
                x={labelPt.x}
                y={labelPt.y - 8}
                textAnchor="middle"
                className="qb-topo-sublabel"
                fontSize={10}
                style={{ pointerEvents: "none" }}
              >
                {labelText}
              </text>
            ) : null}
          </g>
        );
      })}
      {nodes.map((node) => {
        const p = pos.get(node.role);
        if (!p) return null;
        const sel = selection?.kind === "node" && selection.role === node.role;
        const hot = activity.hotRoles.has(node.role);
        const nodeClass = [
          "qb-topo-node",
          sel ? "qb-topo-node--selected" : hot ? "qb-topo-node--hot" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <g key={node.role}>
            <rect
              className={nodeClass}
              x={p.x - TEAM_GRAPH_NODE_W / 2}
              y={p.y - TEAM_GRAPH_NODE_H / 2}
              width={TEAM_GRAPH_NODE_W}
              height={TEAM_GRAPH_NODE_H}
              rx={8}
              style={{
                cursor: "pointer",
                animation: hot && activity.isRunning ? "qb-team-node-pulse 1.2s ease-in-out infinite" : undefined,
              }}
              onClick={(e: MouseEvent<SVGRectElement>) => {
                e.stopPropagation();
                onSelectNode(node.role);
              }}
            />
            <text className="qb-topo-label" x={p.x} y={p.y - 5} textAnchor="middle">
              {node.label.length > 11 ? `${node.label.slice(0, 10)}…` : node.label}
            </text>
            <text className="qb-topo-sublabel" x={p.x} y={p.y + 11} textAnchor="middle">
              {node.role}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
