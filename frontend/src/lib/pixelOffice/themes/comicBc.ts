/**
 * Comic BC 主题：v2 PNG 美术包（漫画猫 + 暖色办公室场景）。
 */

import { modernAtlasManifest } from "./modern";
import type { ThemeDescriptor } from "./types";

export const comicBcTheme: ThemeDescriptor = {
  id: "comic_bc",
  label: "漫画办公室",
  renderEngine: "asset",
  assetBundleId: "comic_bc",
  atlas: modernAtlasManifest,
  palette: {
    floor: "#f0e6d4",
    floorAlt: "#e4d6bc",
    wall: "#e8dcc8",
    ceiling: "#d9cbb0",
    ambient: "rgba(255, 240, 210, 0.0)",
  },
  filter: {
    overlayAlpha: 0,
    bloom: 1,
    ambient: 1,
    skylineBrightness: 1,
  },
  decorations: {
    deskSprites: [],
    chairSprites: [],
    loungeSofa: "Big-Sofa",
    loungeTable: "Big-Round-Table",
    coffeeMachine: "Coffee-Machine",
    cornerPlants: [],
    wallDecor: [],
    extras: [],
  },
};
