import { describe, expect, test } from "bun:test";
import { computeTeamGraphNodePositions, TEAM_GRAPH_NODE_H, TEAM_GRAPH_NODE_W } from "./teamGraphLayout";

function minPairDistance(pos: Map<string, { x: number; y: number }>): number {
  const pts = [...pos.values()];
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = Math.abs(pts[i]!.x - pts[j]!.x);
      const dy = Math.abs(pts[i]!.y - pts[j]!.y);
      if (dx < TEAM_GRAPH_NODE_W && dy < TEAM_GRAPH_NODE_H) {
        min = Math.min(min, Math.hypot(dx, dy));
      }
    }
  }
  return min;
}

describe("computeTeamGraphNodePositions", () => {
  test("9 nodes on 720x360 have no AABB overlap", () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({ role: `role_${i}` }));
    const pos = computeTeamGraphNodePositions(nodes, 720, 360);
    expect(pos.size).toBe(9);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i]!.role)!;
        const b = pos.get(nodes[j]!.role)!;
        const overlapX = TEAM_GRAPH_NODE_W + 12 - Math.abs(b.x - a.x);
        const overlapY = TEAM_GRAPH_NODE_H + 12 - Math.abs(b.y - a.y);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
  });

  test("increases spread vs tiny circle for many nodes", () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({ role: `role_${i}` }));
    const pos = computeTeamGraphNodePositions(nodes, 720, 360);
    const minDist = minPairDistance(pos);
    expect(minDist).toBeGreaterThan(40);
  });
});
