/**
 * Cozy 主题：复用 Modern atlas，叠加暖橙滤镜 + 增加休闲装饰密度。
 * 适合演示「下午茶时段」温馨氛围。
 */

import { anteaAtlasManifest } from "./anteaAtlas";
import type { ThemeDescriptor } from "./types";

export const cozyTheme: ThemeDescriptor = {
  id: "cozy",
  label: "暖橙午后",
  renderEngine: "legacy",
  atlas: anteaAtlasManifest,
  palette: {
    floor: "#f3e3c8",
    floorAlt: "#e7d4b2",
    wall: "#ecd9b8",
    ceiling: "#d8be94",
    ambient: "rgba(255, 215, 160, 0.0)",
  },
  filter: {
    overlayColor: "#ffb86c",
    overlayAlpha: 0.18,
    bloom: 1.3,
    ambient: 1.15,
    skylineBrightness: 1.1,
  },
  decorations: {
    deskSprites: ["Desk", "Desk-2"],
    chairSprites: ["Chair", "Chair-2"],
    loungeSofa: "Big-Sofa",
    loungeTable: "Big-Round-Table",
    coffeeMachine: "Coffee-Machine",
    cornerPlants: ["Big-Plant", "Small-Plant", "Big-Plant", "Small-Plant"],
    wallDecor: ["Wall-Clock", "Wall-Graph", "Wall-Note", "Wall-Note-2"],
    extras: ["Small-Table", "Books", "Folders", "Filing-Cabinet-Small"],
  },
};
