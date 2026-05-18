/** 研究团队拓扑节点尺寸（与 TeamAgentGraph 一致） */
export const TEAM_GRAPH_NODE_W = 108;
export const TEAM_GRAPH_NODE_H = 46;
const PAD = 20;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 椭圆环布局：按节点数计算最小半径，避免 8+ 节点时圆环弦长小于节点宽度导致重叠。
 */
export function computeTeamGraphNodePositions(
  nodes: ReadonlyArray<{ role: string }>,
  width: number,
  height: number
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const n = nodes.length;
  if (n === 0) return pos;

  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) {
    pos.set(nodes[0]!.role, { x: cx, y: cy });
    return pos;
  }

  const sinHalf = Math.sin(Math.PI / n);
  const minRx = (TEAM_GRAPH_NODE_W + PAD) / (2 * sinHalf);
  const minRy = (TEAM_GRAPH_NODE_H + PAD) / (2 * sinHalf);
  const maxRx = width / 2 - TEAM_GRAPH_NODE_W / 2 - PAD;
  const maxRy = height / 2 - TEAM_GRAPH_NODE_H / 2 - PAD;

  let rx = clamp(Math.max(minRx, width * 0.38), minRx, maxRx);
  let ry = clamp(Math.max(minRy, height * 0.36), minRy, maxRy);

  if (maxRx < minRx) rx = maxRx;
  if (maxRy < minRy) ry = maxRy;

  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    pos.set(node.role, {
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    });
  });

  resolveTeamGraphOverlaps(pos, width, height);
  return pos;
}

/** 轻量排斥：消除仍重叠的节点对 */
function resolveTeamGraphOverlaps(
  pos: Map<string, { x: number; y: number }>,
  width: number,
  height: number
): void {
  const entries = [...pos.entries()];
  const minDx = TEAM_GRAPH_NODE_W + PAD;
  const minDy = TEAM_GRAPH_NODE_H + PAD;
  const marginX = TEAM_GRAPH_NODE_W / 2 + 8;
  const marginY = TEAM_GRAPH_NODE_H / 2 + 8;

  for (let iter = 0; iter < 16; iter++) {
    let moved = false;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [, p1] = entries[i]!;
        const [, p2] = entries[j]!;
        const overlapX = minDx - Math.abs(p2.x - p1.x);
        const overlapY = minDy - Math.abs(p2.y - p1.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const push = Math.min(overlapX, overlapY) * 0.55 + 1;
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        p1.x -= ux * push;
        p1.y -= uy * push;
        p2.x += ux * push;
        p2.y += uy * push;
        moved = true;
      }
    }
    for (const [, p] of entries) {
      p.x = clamp(p.x, marginX, width - marginX);
      p.y = clamp(p.y, marginY, height - marginY);
    }
    if (!moved) break;
  }
}
