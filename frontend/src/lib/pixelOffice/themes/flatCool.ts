/**
 * Flat Cool 主题：v2 PNG 美术包（扁平猫 + 冷色 tech 办公室场景）。
 */

import { anteaAtlasManifest } from "./anteaAtlas";
import type { ThemeDescriptor } from "./types";

export const flatCoolTheme: ThemeDescriptor = {
  id: "flat_cool",
  label: "扁平酷感",
  renderEngine: "asset",
  assetBundleId: "flat_cool",
  /** asset 主题不读 atlas，但 ThemeDescriptor 类型要求字段存在 */
  atlas: anteaAtlasManifest,
  palette: {
    floor: "#1e293b",
    floorAlt: "#172033",
    wall: "#0f172a",
    ceiling: "#0b1220",
    ambient: "rgba(6, 182, 212, 0.0)",
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
    loungeSofa: "Big-Sofa-2",
    loungeTable: "Small-Table",
    coffeeMachine: "Coffee-Machine",
    cornerPlants: [],
    wallDecor: [],
    extras: [],
  },
};
