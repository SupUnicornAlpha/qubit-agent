/**
 * 主题资产加载器 —— Canvas 与 Phaser 通用入口。
 *
 * - `loadThemeImage`：返回缓存的 HTMLImageElement（Canvas drawImage 用）
 * - `preloadThemeForPhaser`：用 Phaser Loader 注册 atlas，调用方负责 scene.load.start
 *
 * 同一 atlas URL 全局只加载一次（多主题共享 modern atlas 时不重复 IO）
 */

import type Phaser from "phaser";
import type { LoadedThemeAtlas, ThemeAtlasManifest, ThemeDescriptor } from "./themes/types";

const imageCache = new Map<string, HTMLImageElement>();
const loadPromises = new Map<string, Promise<HTMLImageElement>>();

export function loadThemeImage(manifest: ThemeAtlasManifest): Promise<HTMLImageElement> {
  const cached = imageCache.get(manifest.imageUrl);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return Promise.resolve(cached);
  }
  const existing = loadPromises.get(manifest.imageUrl);
  if (existing) return existing;

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      imageCache.set(manifest.imageUrl, img);
      resolve(img);
    };
    img.onerror = (err) => {
      loadPromises.delete(manifest.imageUrl);
      reject(err);
    };
    img.src = manifest.imageUrl;
  });
  loadPromises.set(manifest.imageUrl, promise);
  return promise;
}

export async function loadThemeAtlas(theme: ThemeDescriptor): Promise<LoadedThemeAtlas> {
  const image = await loadThemeImage(theme.atlas);
  return { manifest: theme.atlas, image, loaded: true };
}

/** 同步获取已加载的 atlas（若未加载返回 null，调用方自己 fallback 到程序化） */
export function getLoadedThemeAtlas(theme: ThemeDescriptor): LoadedThemeAtlas | null {
  const img = imageCache.get(theme.atlas.imageUrl);
  if (img && img.complete && img.naturalWidth > 0) {
    return { manifest: theme.atlas, image: img, loaded: true };
  }
  return null;
}

/**
 * 在 Phaser scene 中注册主题 atlas。
 * 调用方负责：在 preload() 或 boot scene 中调用 → 触发 scene.load.start()。
 * 返回 atlas key（Phaser texture 索引）。
 */
export function preloadThemeForPhaser(
  scene: Phaser.Scene,
  theme: ThemeDescriptor
): string {
  const key = `office-atlas-${theme.id}-${hashUrl(theme.atlas.imageUrl)}`;
  if (scene.textures.exists(key)) return key;
  scene.load.atlas(key, theme.atlas.imageUrl, theme.atlas.jsonUrl);
  return key;
}

/** Phaser 用：主题切换时移除旧 atlas texture（Phaser scene 在线热切换时调用） */
export function removeThemeFromPhaser(scene: Phaser.Scene, theme: ThemeDescriptor): void {
  const key = `office-atlas-${theme.id}-${hashUrl(theme.atlas.imageUrl)}`;
  if (scene.textures.exists(key)) {
    scene.textures.remove(key);
  }
}

/** Canvas: 把图集帧画到目标位置（底中锚点，配合透视缩放） */
export function drawThemeSprite(
  ctx: CanvasRenderingContext2D,
  atlas: LoadedThemeAtlas,
  spriteName: string,
  cx: number,
  by: number,
  scale: number,
  flipX = false
): boolean {
  const frame = atlas.manifest.frames[spriteName];
  if (!frame) return false;
  const dw = frame.w * scale;
  const dh = frame.h * scale;
  const dx = Math.round(cx - dw / 2);
  const dy = Math.round(by - dh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flipX) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(atlas.image, frame.x, frame.y, frame.w, frame.h, 0, 0, dw, dh);
  } else {
    ctx.drawImage(atlas.image, frame.x, frame.y, frame.w, frame.h, dx, dy, dw, dh);
  }
  ctx.restore();
  return true;
}

function hashUrl(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = (h << 5) - h + url.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}
