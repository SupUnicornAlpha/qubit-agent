import type { FC, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import type { TeamTopologyEdge } from "../../lib/researchTeamTopology";
import { buildTopologyEdgePath, type TopoRect } from "../../lib/topologyEdgeRouting";

const NODE_W = 112;
const NODE_H = 48;
const VB_W = 840;
const VB_H = 480;

function roleShortLabel(role: string): string {
  return role.replace(/^analyst_/, "").replace(/_/g, " ");
}

function nodeRect(pos: { x: number; y: number }): TopoRect {
  return { cx: pos.x, cy: pos.y, w: NODE_W, h: NODE_H };
}

export type TopologyDrawMode = "select" | "unicast" | "broadcast";

export const ResearchTopologyCanvas: FC<{
  roles: string[];
  positions: Record<string, { x: number; y: number }>;
  onPositionsChange: (next: Record<string, { x: number; y: number }>) => void;
  edges: TeamTopologyEdge[];
  onEdgesChange: (next: TeamTopologyEdge[]) => void;
  drawMode: TopologyDrawMode;
}> = ({ roles, positions, onPositionsChange, edges, onEdgesChange, drawMode }) => {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const markerId = `qb-topo-arrow-${useId().replace(/:/g, "")}`;
  const [dragRole, setDragRole] = useState<string | null>(null);
  const [uniSource, setUniSource] = useState<string | null>(null);
  const [bcFrom, setBcFrom] = useState<string | null>(null);
  const [bcPicks, setBcPicks] = useState<string[]>([]);

  useEffect(() => {
    setUniSource(null);
    setBcFrom(null);
    setBcPicks([]);
  }, [drawMode]);

  const removeEdgeAt = useCallback(
    (i: number) => {
      onEdgesChange(edges.filter((_, j) => j !== i));
    },
    [edges, onEdgesChange]
  );

  const onPointerDownRole = (role: string, e: PointerEvent<SVGRectElement>) => {
    if (drawMode === "unicast") {
      e.stopPropagation();
      if (!uniSource) {
        setUniSource(role);
        return;
      }
      if (uniSource === role) {
        setUniSource(null);
        return;
      }
      const from = uniSource;
      const to = role;
      setUniSource(null);
      if (from === to) return;
      const exists = edges.some((x) => x.kind === "unicast" && x.from === from && x.to === to);
      if (exists) {
        onEdgesChange(edges.filter((x) => !(x.kind === "unicast" && x.from === from && x.to === to)));
      } else {
        onEdgesChange([...edges, { kind: "unicast", from, to }]);
      }
      return;
    }
    if (drawMode === "broadcast") {
      e.stopPropagation();
      if (!bcFrom) {
        setBcFrom(role);
        setBcPicks([]);
        return;
      }
      if (role === bcFrom) return;
      setBcPicks((prev) => (prev.includes(role) ? prev.filter((x) => x !== role) : [...prev, role]));
      return;
    }
    if (drawMode === "select") {
      e.stopPropagation();
      svgRef.current?.setPointerCapture(e.pointerId);
      setDragRole(role);
    }
  };

  const onSvgPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!dragRole || !svgRef.current) return;
    const svg = svgRef.current;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const nx = Math.max(60, Math.min(VB_W - 60, p.x));
    const ny = Math.max(36, Math.min(VB_H - 36, p.y));
    onPositionsChange({ ...positions, [dragRole]: { x: nx, y: ny } });
  };

  const endDrag = (e: PointerEvent<SVGSVGElement>) => {
    if (dragRole && svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    setDragRole(null);
  };

  const confirmBroadcast = () => {
    if (!bcFrom || bcPicks.length === 0) return;
    const targets = [...new Set(bcPicks)].filter((t) => t !== bcFrom);
    if (targets.length === 0) return;
    const next = edges.filter((e) => !(e.kind === "broadcast" && e.from === bcFrom));
    next.push({ kind: "broadcast", from: bcFrom, targets });
    onEdgesChange(next);
    setBcFrom(null);
    setBcPicks([]);
  };

  const cancelBroadcast = () => {
    setBcFrom(null);
    setBcPicks([]);
  };

  const edgeSegments = useMemo(() => {
    const segs: Array<{ key: string; d: string; dashed?: boolean }> = [];

    for (const e of edges) {
      const p1 = positions[e.from];
      if (!p1) continue;
      const fromRect = nodeRect(p1);

      if (e.kind === "unicast") {
        const p2 = positions[e.to];
        if (!p2) continue;
        segs.push({
          key: `u-${e.from}-${e.to}`,
          d: buildTopologyEdgePath(fromRect, nodeRect(p2), { curved: true, curveStrength: 0.85 }),
        });
      } else {
        const validTargets = e.targets.filter((t) => positions[t]);
        validTargets.forEach((t, i) => {
          segs.push({
            key: `b-${e.from}-${t}-${i}`,
            d: buildTopologyEdgePath(fromRect, nodeRect(positions[t]!), {
              curved: true,
              fanIndex: i,
              fanTotal: validTargets.length,
              curveStrength: 1.1,
            }),
            dashed: true,
          });
        });
      }
    }
    return segs;
  }, [edges, positions]);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
        {drawMode === "unicast" ? (
          <span style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)" }}>
            {t("team.topology.unicastHint")}
            {uniSource ? t("team.topology.unicastSelected", { role: uniSource }) : ""}
          </span>
        ) : null}
        {drawMode === "broadcast" ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)" }}>
              {t("team.topology.broadcastHint")}
              {bcFrom
                ? t("team.topology.broadcastSelected", {
                    from: bcFrom,
                    picks:
                      bcPicks.join(", ") || t("team.topology.broadcastNoneYet"),
                  })
                : ""}
            </span>
            <button
              type="button"
              className="qb-btn-secondary"
              style={{ fontSize: 11, padding: "4px 8px" }}
              onClick={confirmBroadcast}
              disabled={!bcFrom || bcPicks.length === 0}
            >
              {t("team.topology.confirmBroadcast")}
            </button>
            <button type="button" className="qb-btn-secondary" style={{ fontSize: 11, padding: "4px 8px" }} onClick={cancelBroadcast}>
              {t("team.topology.cancel")}
            </button>
          </div>
        ) : null}
        {drawMode === "select" ? (
          <span style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)" }}>{t("team.topology.selectHint")}</span>
        ) : null}
      </div>

      <div data-qb-team-graph-host style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        data-qb-topology-canvas=""
        width="100%"
        height={VB_H}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        style={{
          display: "block",
          background: "var(--qb-team-canvas-bg, #0c0c0e)",
          border: "1px solid var(--qb-topo-canvas-border, var(--qb-team-table-row-border, #27272a))",
          borderRadius: "var(--qb-topo-canvas-radius, 8px)",
          touchAction: "none",
        }}
        onPointerMove={onSvgPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="qb-topo-edge-marker" fill="var(--qb-topo-edge-stroke, #71717a)" />
          </marker>
        </defs>

        {edgeSegments.map((s) => (
          <path
            key={s.key}
            d={s.d}
            className={`qb-topo-edge${s.dashed ? " qb-topo-edge--dashed" : ""}`}
            markerEnd={`url(#${markerId})`}
          />
        ))}

        {roles.map((role) => {
          const pos = positions[role];
          if (!pos) return null;
          const { cx, cy, w, h } = nodeRect(pos);
          const x = cx - w / 2;
          const y = cy - h / 2;
          const active = uniSource === role || bcFrom === role || (bcFrom !== null && bcPicks.includes(role));
          return (
            <g key={role}>
              <rect
                className={`qb-topo-node${active ? " qb-topo-node--active" : ""}`}
                x={x}
                y={y}
                width={w}
                height={h}
                rx={8}
                style={{ cursor: drawMode === "select" ? "grab" : "pointer" }}
                onPointerDown={(e) => onPointerDownRole(role, e)}
              />
              <text className="qb-topo-label" x={pos.x} y={pos.y - 2} textAnchor="middle">
                {roleShortLabel(role)}
              </text>
              <text className="qb-topo-sublabel" x={pos.x} y={pos.y + 12} textAnchor="middle">
                {role}
              </text>
            </g>
          );
        })}
      </svg>
      </div>

      {edges.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--qb-team-section-fg, #cbd5e1)", marginBottom: 6 }}>
            {t("team.topology.edgeListTitle")}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", lineHeight: 1.6 }}>
            {edges.map((e, i) => {
              const removeBtn: ReactNode = (
                <button type="button" className="qb-btn-secondary" style={{ fontSize: 10, padding: "2px 6px", marginLeft: 6 }} onClick={() => removeEdgeAt(i)}>
                  {t("team.topology.removeEdge")}
                </button>
              );
              return (
                <li key={`e-${i}-${e.kind}`}>
                  {e.kind === "unicast" ? (
                    <>
                      {t("team.topology.edgeUnicast")} <code style={{ fontSize: 10 }}>{e.from}</code> → <code style={{ fontSize: 10 }}>{e.to}</code>{" "}
                      {removeBtn}
                    </>
                  ) : (
                    <>
                      {t("team.topology.edgeBroadcast")} <code style={{ fontSize: 10 }}>{e.from}</code> → [{e.targets.join(", ")}]{" "}
                      {removeBtn}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};
