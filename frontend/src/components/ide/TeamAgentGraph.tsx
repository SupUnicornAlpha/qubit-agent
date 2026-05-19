import type { FC, MouseEvent } from "react";
import { useId, useMemo } from "react";
import type { AnalystTeamGraphEdge, AnalystTeamGraphNode } from "../../api/types";
import {
  edgeMessagesAtoB,
  edgeMessagesBtoA,
  formatEdgeLabel,
  isToolGraphEdge,
  toolAgentOnEdge,
  toolEdgeStroke,
} from "../../lib/teamGraphEdgeVisual";
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

type DrawnEdge = {
  key: string;
  d: string;
  className: string;
  dashed: boolean;
  stroke?: string;
  showArrow: boolean;
  label: string;
  labelPt: { x: number; y: number };
};

function buildDrawnEdges(
  ed: AnalystTeamGraphEdge,
  pa: { x: number; y: number },
  pb: { x: number; y: number }
): DrawnEdge[] {
  const fromRectA = nodeRect(pa.x, pa.y);
  const toRectB = nodeRect(pb.x, pb.y);
  const traffic = (ed.messageCount ?? 0) + (ed.toolCount ?? 0) > 0;
  const label = formatEdgeLabel(ed);

  if (isToolGraphEdge(ed)) {
    const agent = toolAgentOnEdge(ed);
    const agentPos = agent === ed.a ? pa : pb;
    const toolsPos = agent === ed.a ? pb : pa;
    const d = buildTopologyEdgePath(nodeRect(agentPos.x, agentPos.y), nodeRect(toolsPos.x, toolsPos.y), {
      curved: true,
      curveStrength: 0.55,
    });
    const labelPt = sampleLine(agentPos.x, agentPos.y, toolsPos.x, toolsPos.y, 0.42);
    return [
      {
        key: `${ed.key}-tool`,
        d,
        className: "qb-topo-edge qb-topo-edge--tool",
        dashed: !traffic,
        stroke: toolEdgeStroke(ed),
        showArrow: true,
        label,
        labelPt,
      },
    ];
  }

  const ab = edgeMessagesAtoB(ed);
  const ba = edgeMessagesBtoA(ed);
  const out: DrawnEdge[] = [];

  const addDirected = (from: { x: number; y: number }, to: { x: number; y: number }, suffix: string, fanIndex: number, fanTotal: number) => {
    const d = buildTopologyEdgePath(nodeRect(from.x, from.y), nodeRect(to.x, to.y), {
      curved: true,
      curveStrength: 0.65,
      fanIndex,
      fanTotal,
    });
    const labelPt = sampleLine(from.x, from.y, to.x, to.y, 0.45);
    out.push({
      key: `${ed.key}-${suffix}`,
      d,
      className: "qb-topo-edge",
      dashed: !traffic,
      showArrow: true,
      label: fanTotal > 1 ? "" : label,
      labelPt,
    });
  };

  if (ab > 0 && ba > 0) {
    addDirected(pa, pb, "ab", 0, 2);
    addDirected(pb, pa, "ba", 1, 2);
    const labelPt = sampleLine(pa.x, pa.y, pb.x, pb.y, 0.5);
    out[0]!.label = label;
    out[0]!.labelPt = labelPt;
    out[1]!.label = "";
  } else if (ab > 0) {
    addDirected(pa, pb, "ab", 0, 1);
  } else if (ba > 0) {
    addDirected(pb, pa, "ba", 0, 1);
  } else {
    const d = buildTopologyEdgePath(fromRectA, toRectB, { curved: true, curveStrength: 0.65 });
    const labelPt = sampleLine(pa.x, pa.y, pb.x, pb.y, 0.45);
    out.push({
      key: `${ed.key}-plan`,
      d,
      className: "qb-topo-edge",
      dashed: !traffic,
      showArrow: false,
      label,
      labelPt,
    });
  }

  return out;
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
  const markerSuccessId = `qb-team-arrow-ok-${uid}`;
  const markerFailId = `qb-team-arrow-fail-${uid}`;

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
        <marker id={markerSuccessId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
          <path d="M0,0 L9,4.5 L0,9 z" fill="var(--qb-topo-edge-success, #4ade80)" />
        </marker>
        <marker id={markerFailId} markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
          <path d="M0,0 L9,4.5 L0,9 z" fill="var(--qb-topo-edge-fail, #f87171)" />
        </marker>
      </defs>
      <rect width={width} height={height} fill="transparent" />
      {edges.map((ed) => {
        const pa = pos.get(ed.a);
        const pb = pos.get(ed.b);
        if (!pa || !pb) return null;
        const selEdge =
          selection?.kind === "edge" && teamGraphUndirectedKey(selection.a, selection.b) === ed.key;
        const isHot = activity.hotEdgeKeys.has(ed.key);
        const hitW = 14;
        const drawn = buildDrawnEdges(ed, pa, pb);
        const toolEdge = isToolGraphEdge(ed);

        return (
          <g key={ed.key}>
            <path
              d={drawn[0]?.d ?? buildTopologyEdgePath(nodeRect(pa.x, pa.y), nodeRect(pb.x, pb.y))}
              fill="none"
              stroke="transparent"
              strokeWidth={hitW}
              style={{ cursor: "pointer" }}
              onClick={(e: MouseEvent<SVGPathElement>) => {
                e.stopPropagation();
                onSelectEdge(ed.a, ed.b);
              }}
            />
            {drawn.map((seg) => {
              const edgeClass = [
                seg.className,
                selEdge ? "qb-topo-edge--selected" : isHot ? "qb-topo-edge--hot" : "",
                seg.dashed ? "qb-topo-edge--dashed" : "",
                toolEdge && seg.stroke ? "qb-topo-edge--tool-status" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const markerEnd = seg.showArrow
                ? toolEdge
                  ? seg.stroke?.includes("f87171")
                    ? `url(#${markerFailId})`
                    : seg.stroke?.includes("fbbf24")
                      ? `url(#${markerId})`
                      : `url(#${markerSuccessId})`
                  : `url(#${markerId})`
                : undefined;
              return (
                <g key={seg.key}>
                  <path
                    d={seg.d}
                    className={edgeClass}
                    markerEnd={markerEnd}
                    style={{
                      cursor: "pointer",
                      pointerEvents: "none",
                      stroke: seg.stroke,
                      animation:
                        isHot && activity.isRunning ? "qb-team-edge-pulse 1.1s ease-in-out infinite" : undefined,
                    }}
                  />
                  {seg.label ? (
                    <text
                      x={seg.labelPt.x}
                      y={seg.labelPt.y - 8}
                      textAnchor="middle"
                      className="qb-topo-sublabel"
                      fontSize={10}
                      style={{ pointerEvents: "none" }}
                    >
                      {seg.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
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
