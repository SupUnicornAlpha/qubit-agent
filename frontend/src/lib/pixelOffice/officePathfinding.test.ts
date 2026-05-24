import { describe, expect, test } from "bun:test";
import { setRenderTier } from "./config";
import { computeOfficeLayout } from "./officeLayout";
import { computeOfficePerspective } from "./officePerspective";
import { buildPathGrid, findPath } from "./officePathfinding";

const STAGE_W = 1280;
const STAGE_H = 720;

describe("officePathfinding", () => {
  test("findPath returns a path that avoids blocked cells", () => {
    setRenderTier("hd");
    const roles = Array.from({ length: 6 }, (_, i) => ({ role: `agent_${i}` }));
    const layout = computeOfficeLayout(roles, STAGE_W, STAGE_H);
    const persp = computeOfficePerspective(STAGE_W, STAGE_H, layout.windowH);
    const grid = buildPathGrid(layout, persp);

    // shelf 在左侧 ~6% 宽处，rack 在右侧 ~94% 宽处
    // 跨整张办公室走（最严苛路径）
    const path = findPath(grid, { x: 100, y: STAGE_H - 80 }, { x: STAGE_W - 100, y: STAGE_H - 80 });
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(1);
    // 所有中间点不能落在被阻挡的格子里
    for (let i = 1; i < path!.length - 1; i++) {
      const p = path![i]!;
      const c = Math.floor(p.x / grid.cell);
      const r = Math.floor(p.y / grid.cell);
      expect(grid.blocked[r * grid.cols + c]).toBe(0);
    }
  });

  test("path is start..end inclusive", () => {
    setRenderTier("hd");
    const layout = computeOfficeLayout([{ role: "a" }, { role: "b" }], STAGE_W, STAGE_H);
    const persp = computeOfficePerspective(STAGE_W, STAGE_H, layout.windowH);
    const grid = buildPathGrid(layout, persp);

    const start = { x: 200, y: 640 };
    const end = { x: 1000, y: 640 };
    const path = findPath(grid, start, end)!;
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(end);
  });

  test("path smoothing reduces waypoints when straight line is clear", () => {
    setRenderTier("hd");
    const layout = computeOfficeLayout([{ role: "a" }], STAGE_W, STAGE_H);
    const persp = computeOfficePerspective(STAGE_W, STAGE_H, layout.windowH);
    const grid = buildPathGrid(layout, persp);

    // 一条 X 轴上 200→500 的短距，且这一带没有家具阻挡 → 应该被压成 2 个点
    const path = findPath(grid, { x: 300, y: 660 }, { x: 500, y: 660 })!;
    expect(path.length).toBeLessThanOrEqual(3);
  });
});
