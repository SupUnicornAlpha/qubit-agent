/**
 * 研究团队编组 relations_json：边（单向 / 广播）+ 可选画布布局元数据。
 * 与后端 `parseTeamRelations` / `validateAgentGroupRelationsJson` 约定一致。
 */

export type TeamTopologyEdge =
  | { kind: "unicast"; from: string; to: string }
  | { kind: "broadcast"; from: string; targets: string[] };

export interface TopologyCanvasMeta {
  type: "topology_canvas";
  nodePositions?: Record<string, { x: number; y: number }>;
}

export function defaultNodeLayout(roles: string[]): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const n = Math.max(roles.length, 1);
  const cx = 420;
  const cy = 240;
  const rx = 200;
  const ry = 160;
  roles.forEach((role, i) => {
    const ang = (2 * Math.PI * i) / n - Math.PI / 2;
    out[role] = { x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry };
  });
  return out;
}

function asEdgeString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function parseRelationsFull(raw: unknown): {
  meta: TopologyCanvasMeta | null;
  edges: TeamTopologyEdge[];
} {
  if (!Array.isArray(raw)) return { meta: null, edges: [] };
  let meta: TopologyCanvasMeta | null = null;
  const edges: TeamTopologyEdge[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (Object.keys(r).length === 0) continue;
    if (r.type === "topology_canvas") {
      const np = r.nodePositions;
      const rawPos =
        np && typeof np === "object" && np !== null && !Array.isArray(np)
          ? (np as Record<string, unknown>)
          : {};
      const nodePositions: Record<string, { x: number; y: number }> = {};
      for (const [k, v] of Object.entries(rawPos)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const o = v as Record<string, unknown>;
        const x = typeof o.x === "number" ? o.x : Number.parseFloat(String(o.x));
        const y = typeof o.y === "number" ? o.y : Number.parseFloat(String(o.y));
        if (Number.isFinite(x) && Number.isFinite(y)) nodePositions[k] = { x, y };
      }
      meta = { type: "topology_canvas", nodePositions };
      continue;
    }
    if (r.kind === "broadcast") {
      const from = asEdgeString(r.from);
      if (from === null || !Array.isArray(r.targets)) continue;
      const targets = r.targets
        .map((t) => asEdgeString(t))
        .filter((t): t is string => t !== null && t !== from);
      if (targets.length > 0) edges.push({ kind: "broadcast", from, targets });
      continue;
    }
    const from = asEdgeString(r.from);
    const to = asEdgeString(r.to);
    if (from !== null && to !== null && from !== to) {
      edges.push({ kind: "unicast", from, to });
    }
  }
  return { meta, edges };
}

export function serializeRelationsPayload(
  meta: TopologyCanvasMeta | null,
  edges: TeamTopologyEdge[]
): unknown[] {
  const out: unknown[] = [];
  if (meta?.nodePositions && Object.keys(meta.nodePositions).length > 0) {
    const cleaned: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(meta.nodePositions)) {
      const x = typeof v?.x === "number" ? v.x : Number.parseFloat(String(v?.x));
      const y = typeof v?.y === "number" ? v.y : Number.parseFloat(String(v?.y));
      if (Number.isFinite(x) && Number.isFinite(y)) cleaned[k] = { x, y };
    }
    if (Object.keys(cleaned).length > 0) {
      out.push({ type: "topology_canvas", nodePositions: cleaned });
    }
  }
  for (const e of edges) {
    if (e.kind === "unicast") {
      out.push({ from: String(e.from), to: String(e.to), edgeKind: "unicast" });
    } else {
      const targets = e.targets.map((t) => String(t)).filter((t) => t.length > 0 && t !== e.from);
      if (targets.length === 0) continue;
      out.push({ from: String(e.from), kind: "broadcast", targets });
    }
  }
  return out;
}

export function mergeLayoutWithRoles(
  roles: string[],
  meta: TopologyCanvasMeta | null
): Record<string, { x: number; y: number }> {
  const base = defaultNodeLayout(roles);
  const saved = meta?.nodePositions ?? {};
  const out = { ...base };
  for (const role of roles) {
    const p = saved[role];
    if (!p || typeof p !== "object") continue;
    const x = typeof p.x === "number" ? p.x : Number.parseFloat(String(p.x));
    const y = typeof p.y === "number" ? p.y : Number.parseFloat(String(p.y));
    if (Number.isFinite(x) && Number.isFinite(y)) out[role] = { x, y };
  }
  return out;
}

export function pruneTopologyForRoles(
  edges: TeamTopologyEdge[],
  roles: Set<string>
): TeamTopologyEdge[] {
  return edges
    .map((e) => {
      if (e.kind === "unicast") {
        if (!roles.has(e.from) || !roles.has(e.to)) return null;
        return e;
      }
      const targets = e.targets.filter((t) => roles.has(t) && t !== e.from);
      if (!roles.has(e.from) || targets.length === 0) return null;
      return { kind: "broadcast" as const, from: e.from, targets };
    })
    .filter((x): x is TeamTopologyEdge => x !== null);
}

export function pruneLayoutForRoles(
  positions: Record<string, { x: number; y: number }>,
  roles: Set<string>
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const r of roles) {
    const p = positions[r];
    if (p) out[r] = { ...p };
  }
  return out;
}
