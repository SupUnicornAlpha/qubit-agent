/**
 * Modern Night 主题：复用 Modern atlas，叠加蓝紫 overlay + 增强显示器/灯光 bloom。
 * 适合演示「深夜赶工」氛围。
 */

import { modernAtlasManifest } from "./modern";
import type { ThemeDescriptor } from "./types";

export const modernNightTheme: ThemeDescriptor = {
  id: "modern_night",
  label: "深夜模式",
  atlas: modernAtlasManifest,
  palette: {
    floor: "#2a3142",
    floorAlt: "#22293a",
    wall: "#1f2536",
    ceiling: "#181d2b",
    ambient: "rgba(40, 50, 90, 0.0)",
  },
  filter: {
    overlayColor: "#1a1f3a",
    overlayAlpha: 0.34,
    bloom: 2.1,
    ambient: 0.35,
    skylineBrightness: 0.6,
  },
  decorations: {
    deskSprites: ["Desk", "Desk-2", "Boss-Desk"],
    chairSprites: ["Chair", "Chair-2", "Boss-Chair"],
    loungeSofa: "Big-Sofa-2",
    loungeTable: "Big-Round-Table",
    coffeeMachine: "Coffee-Machine",
    cornerPlants: ["Big-Plant", "Small-Plant"],
    wallDecor: ["Wall-Clock", "Wall-Graph"],
    extras: ["Filing-Cabinet-Tall", "Printer-Furniture", "Vending-Machine"],
  },
};
