import { describe, expect, test } from "bun:test";
import { setRenderTier } from "./config";
import { computeOfficeLayout } from "./officeLayout";
import { depthScale } from "./officePerspective";

describe("computeOfficeLayout", () => {
  test("perspective desks do not overlap at hd tier", () => {
    setRenderTier("hd");
    const roles = Array.from({ length: 8 }, (_, i) => ({ role: `agent_${i}` }));
    const layout = computeOfficeLayout(roles, 1100, 720);
    const pts = [...layout.desks.values()];

    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = Math.abs(pts[i]!.x - pts[j]!.x);
        const dy = Math.abs(pts[i]!.y - pts[j]!.y);
        const minD = Math.min(pts[i]!.depth, pts[j]!.depth);
        const gapX = layout.cellW * 0.85 * depthScale(minD);
        const gapY = layout.cellH * 0.85;
        expect(dx >= gapX || dy >= gapY).toBe(true);
      }
    }
    const depths = pts.map((p) => p.depth);
    expect(Math.min(...depths)).toBeLessThan(Math.max(...depths));
  });
});
