import { describe, expect, test } from "bun:test";
import { getRenderConfig, setRenderTier } from "./config";
import { computeOfficeLayout } from "./officeLayout";
import { getStationFootprint } from "./stationMetrics";

describe("computeOfficeLayout", () => {
  test("desks do not overlap at hd tier", () => {
    setRenderTier("hd");
    const fp = getStationFootprint(getRenderConfig());
    const roles = Array.from({ length: 8 }, (_, i) => ({ role: `agent_${i}` }));
    const layout = computeOfficeLayout(roles, 1100, 720);
    const pts = [...layout.desks.values()];
    const gapX = layout.cellW * 0.92;
    const gapY = layout.cellH * 0.92;

    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = Math.abs(pts[i]!.x - pts[j]!.x);
        const dy = Math.abs(pts[i]!.y - pts[j]!.y);
        expect(dx >= gapX || dy >= gapY).toBe(true);
      }
    }
    expect(layout.cellW).toBeGreaterThanOrEqual(fp.minWidth * 0.85);
  });
});
