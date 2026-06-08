/**
 * Modern 主题：默认日间办公室皮肤。
 * 复用 Antea atlas，无后处理滤镜。
 */

import {
  modernAtlasJsonUrl,
  modernAtlasSize,
  modernAtlasUrl,
  modernAttribution,
  modernCategories,
  modernFrames,
  modernSpriteMeta,
} from "../../../assets/pixel-office/themes/modern/manifest";
import type { ThemeAtlasManifest, ThemeDescriptor } from "./types";

export const modernAtlasManifest: ThemeAtlasManifest = {
  imageUrl: modernAtlasUrl,
  jsonUrl: modernAtlasJsonUrl,
  size: modernAtlasSize,
  frames: modernFrames,
  spriteMeta: modernSpriteMeta,
  categories: modernCategories,
  attribution: modernAttribution,
};

export const modernTheme: ThemeDescriptor = {
  id: "modern",
  label: "现代日间",
  renderEngine: "legacy",
  atlas: modernAtlasManifest,
  palette: {
    floor: "#f5efe4",
    floorAlt: "#ebe3d4",
    wall: "#e8dfd0",
    ceiling: "#d6cbb6",
    ambient: "rgba(255, 248, 232, 0.0)",
  },
  filter: {
    overlayAlpha: 0,
    bloom: 1,
    ambient: 1,
    skylineBrightness: 1,
  },
  decorations: {
    deskSprites: ["Desk", "Desk-2", "Boss-Desk"],
    chairSprites: ["Chair", "Chair-2", "Boss-Chair"],
    loungeSofa: "Big-Sofa",
    loungeTable: "Big-Round-Table",
    coffeeMachine: "Coffee-Machine",
    cornerPlants: ["Big-Plant", "Small-Plant", "Big-Plant"],
    wallDecor: ["Wall-Clock", "Wall-Graph", "Wall-Note"],
    extras: [
      "Filing-Cabinet-Tall",
      "Printer-Furniture",
      "Vending-Machine",
      "Water-Dispenser",
      "Big-Filing-Cabinet",
    ],
  },
};
