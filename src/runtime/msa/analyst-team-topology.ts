import type { AgentRole } from "../../types/entities";

/** 与 `agent_group.relations_json` 约定一致：有向边「from 的结论先产出，并作为上下文传给 to」 */
export interface TeamRelationEdge {
  from: AgentRole;
  to: AgentRole;
}

function asEdgeString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function parseTeamRelations(
  raw: unknown,
  allowedRoles: readonly AgentRole[]
): TeamRelationEdge[] {
  const allow = new Set(allowedRoles);
  if (!Array.isArray(raw)) return [];
  const out: TeamRelationEdge[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    if (Object.keys(rec).length === 0) continue;
    if (rec.type === "topology_canvas") continue;
    if (rec.kind === "broadcast" && Array.isArray(rec.targets)) {
      const from = asEdgeString(rec.from);
      if (from === null || !allow.has(from as AgentRole)) continue;
      for (const t of rec.targets as unknown[]) {
        const to = asEdgeString(t);
        if (to === null || to === from || !allow.has(to as AgentRole)) continue;
        out.push({ from: from as AgentRole, to: to as AgentRole });
      }
      continue;
    }
    const from = asEdgeString(rec.from);
    const to = asEdgeString(rec.to);
    if (from === null || to === null || from === to) continue;
    if (!allow.has(from as AgentRole) || !allow.has(to as AgentRole)) continue;
    out.push({ from: from as AgentRole, to: to as AgentRole });
  }
  return out;
}

export interface SlotLike {
  role: AgentRole;
}

/**
 * 按有向边将 slots 分层；同层内可并行。边两端若不在 slots 内则忽略。
 * 若检测到环（无法在剩余节点中找到入度为 0 的点），将剩余节点并入下一层一次跑完（等价于打破环，并行执行）。
 */
export function partitionSlotsIntoWaves<T extends SlotLike>(
  slots: T[],
  edges: TeamRelationEdge[]
): T[][] {
  if (slots.length === 0) return [];
  const roleSet = new Set(slots.map((s) => s.role));
  const adj = new Map<AgentRole, AgentRole[]>();
  const indeg = new Map<AgentRole, number>();
  for (const s of slots) indeg.set(s.role, 0);
  for (const e of edges) {
    if (!roleSet.has(e.from) || !roleSet.has(e.to)) continue;
    const arr = adj.get(e.from) ?? [];
    arr.push(e.to);
    adj.set(e.from, arr);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const roleToSlot = new Map(slots.map((s) => [s.role, s] as const));
  const remaining = new Set(slots.map((s) => s.role));
  const waves: T[][] = [];
  while (remaining.size > 0) {
    const wave: T[] = [];
    for (const r of remaining) {
      if ((indeg.get(r) ?? 0) === 0) {
        const sl = roleToSlot.get(r);
        if (sl) wave.push(sl);
      }
    }
    if (wave.length === 0) {
      for (const r of remaining) {
        const sl = roleToSlot.get(r);
        if (sl) wave.push(sl);
      }
      waves.push(wave);
      break;
    }
    waves.push(wave);
    for (const slot of wave) {
      remaining.delete(slot.role);
      for (const nxt of adj.get(slot.role) ?? []) {
        indeg.set(nxt, Math.max(0, (indeg.get(nxt) ?? 0) - 1));
      }
    }
  }
  return waves;
}
