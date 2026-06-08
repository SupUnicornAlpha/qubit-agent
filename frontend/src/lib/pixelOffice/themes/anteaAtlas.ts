/**
 * Antea atlas manifest（CC-BY office sprite pack）。
 *
 * 这是 cozy 主题（程序化渲染路径）使用的 atlas 元数据。原本居于 `modern.ts`，
 * 在 v2 重构中 modern / modern_night 主题被移除，atlas 数据迁移到此文件，
 * 仅用于：
 *   - cozy 主题的 spriteAtlas 程序化绘制（家具/装饰）
 *   - asset 主题（comic_bc / flat_cool）作为 ThemeDescriptor.atlas 的占位（不会被读取）
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
import type { ThemeAtlasManifest } from "./types";

export const anteaAtlasManifest: ThemeAtlasManifest = {
  imageUrl: modernAtlasUrl,
  jsonUrl: modernAtlasJsonUrl,
  size: modernAtlasSize,
  frames: modernFrames,
  spriteMeta: modernSpriteMeta,
  categories: modernCategories,
  attribution: modernAttribution,
};
