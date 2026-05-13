import type { FC, MouseEvent } from "react";
import type { AnalystTeamGraphEdge, AnalystTeamGraphNode } from "../../api/types";

export type TeamGraphSelection =
  | null
  | { kind: "node"; role: string }
  | { kind: "edge"; a: string; b: string };

function edgeKeyUndirected(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
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
}> = ({ nodes, edges, width, height, selection, onSelectNode, onSelectEdge, onClear }) => {
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

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", maxWidth: "100%", cursor: "default" }}
      onClick={onBgClick}
    >
      <rect width={width} height={height} fill="transparent" />
      {edges.map((ed) => {
        const pa = pos.get(ed.a);
        const pb = pos.get(ed.b);
        if (!pa || !pb) return null;
        const selEdge =
          selection?.kind === "edge" && edgeKeyUndirected(selection.a, selection.b) === ed.key;
        return (
          <g key={ed.key}>
            <line
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke={selEdge ? "#3b82f6" : "#3f3f46"}
              strokeWidth={selEdge ? 3 : 10}
              strokeOpacity={selEdge ? 1 : 0}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEdge(ed.a, ed.b);
              }}
            />
            <line
              x1={pa.x}
              y1={pa.y}
              x2={pb.x}
              y2={pb.y}
              stroke={selEdge ? "#60a5fa" : "#52525b"}
              strokeWidth={1.5}
              style={{ cursor: "pointer", pointerEvents: "none" }}
            />
            <text
              x={(pa.x + pb.x) / 2}
              y={(pa.y + pb.y) / 2 - 6}
              textAnchor="middle"
              fill="#a1a1aa"
              fontSize={10}
              style={{ pointerEvents: "none" }}
            >
              {ed.messageCount ? `对话 ${ed.messageCount}` : ""}
              {ed.messageCount && ed.toolCount ? " · " : ""}
              {ed.toolCount ? `工具 ${ed.toolCount}` : ""}
            </text>
          </g>
        );
      })}
      {nodes.map((node) => {
        const p = pos.get(node.role);
        if (!p) return null;
        const sel = selection?.kind === "node" && selection.role === node.role;
        const w = 100;
        const h = 40;
        return (
          <g key={node.role}>
            <rect
              x={p.x - w / 2}
              y={p.y - h / 2}
              width={w}
              height={h}
              rx={8}
              fill={sel ? "#1e3a5f" : "#18181b"}
              stroke={sel ? "#3b82f6" : "#3f3f46"}
              strokeWidth={sel ? 2 : 1}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(node.role);
              }}
            />
            <text
              x={p.x}
              y={p.y - 4}
              textAnchor="middle"
              fill="#e4e4e7"
              fontSize={11}
              fontWeight={600}
              style={{ pointerEvents: "none" }}
            >
              {node.label.length > 10 ? `${node.label.slice(0, 9)}…` : node.label}
            </text>
            <text
              x={p.x}
              y={p.y + 10}
              textAnchor="middle"
              fill="#71717a"
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
