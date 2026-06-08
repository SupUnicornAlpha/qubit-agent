/**
 * 像素办公室主题注册表（v2 重构后）。
 *
 * - 内置主题：cozy / comic_bc / flat_cool
 * - 外部可通过 registerTheme 注入额外主题
 * - 当前激活主题存入 localStorage (`qb-pixel-office-theme`)
 * - 提供监听器，UI 切换 → 引擎刷新
 */

import { getLoadedThemeAtlas, loadThemeAtlas } from "../themeAssets";
import { preloadAssetBundle } from "../assetOffice";
import { cozyTheme } from "./cozy";
import { comicBcTheme } from "./comicBc";
import { flatCoolTheme } from "./flatCool";
import type { LoadedThemeAtlas, ThemeChangeListener, ThemeDescriptor, ThemeId } from "./types";

const STORAGE_KEY = "qb-pixel-office-theme";
const DEFAULT_THEME_ID: ThemeId = "comic_bc";

const registry = new Map<string, ThemeDescriptor>();
const listeners = new Set<ThemeChangeListener>();
let active: ThemeDescriptor | null = null;

function registerBuiltin(): void {
  if (registry.size > 0) return;
  registerTheme(comicBcTheme);
  registerTheme(flatCoolTheme);
  registerTheme(cozyTheme);
}

export function registerTheme(theme: ThemeDescriptor): void {
  registry.set(theme.id, theme);
}

export function listThemes(): ThemeDescriptor[] {
  registerBuiltin();
  return [...registry.values()];
}

export function getTheme(id: string): ThemeDescriptor | undefined {
  registerBuiltin();
  return registry.get(id);
}

function readStoredId(): ThemeId | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    if (registry.has(raw)) return raw as ThemeId;
  } catch {
    /* localStorage 不可用（隐私模式 / SSR） */
  }
  return null;
}

function persistId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function getActiveTheme(): ThemeDescriptor {
  registerBuiltin();
  if (active) return active;
  const stored = readStoredId();
  active = (stored && registry.get(stored)) || registry.get(DEFAULT_THEME_ID) || comicBcTheme;
  return active;
}

export function setActiveTheme(id: string): ThemeDescriptor {
  registerBuiltin();
  const next = registry.get(id);
  if (!next) {
    console.warn(`[pixelOffice/themes] unknown theme id: ${id}`);
    return getActiveTheme();
  }
  const prev = active;
  active = next;
  persistId(id);
  for (const l of listeners) {
    try {
      l(next, prev);
    } catch (err) {
      console.error("[pixelOffice/themes] listener failed:", err);
    }
  }
  return next;
}

export function subscribeThemeChange(listener: ThemeChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 触发当前激活主题的资源异步加载（幂等）。
 * - asset 主题：preloadAssetBundle
 * - legacy 主题：loadThemeAtlas
 */
let loadInFlightUrl: string | null = null;

export function ensureActiveAtlasLoaded(): void {
  const theme = getActiveTheme();
  if (theme.renderEngine === "asset" && theme.assetBundleId) {
    preloadAssetBundle(theme.assetBundleId);
    return;
  }
  if (getLoadedThemeAtlas(theme)) return;
  if (loadInFlightUrl === theme.atlas.imageUrl) return;
  loadInFlightUrl = theme.atlas.imageUrl;
  loadThemeAtlas(theme)
    .catch((err) => {
      console.error("[pixelOffice/themes] atlas load failed:", err);
    })
    .finally(() => {
      if (loadInFlightUrl === theme.atlas.imageUrl) loadInFlightUrl = null;
    });
}

export function getActiveAtlasSync(): LoadedThemeAtlas | null {
  return getLoadedThemeAtlas(getActiveTheme());
}

/**
 * 在 Canvas 上叠加当前主题的全局滤镜（暖橙 overlay 等）。
 * 调用方应在 cats/工位/粒子之后、status 文字之前调用。
 */
export function applyThemeOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  const filter = getActiveTheme().filter;
  if (!filter.overlayColor || !filter.overlayAlpha || filter.overlayAlpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, filter.overlayAlpha);
  ctx.fillStyle = filter.overlayColor;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

export function isAssetRenderTheme(theme: ThemeDescriptor = getActiveTheme()): boolean {
  return theme.renderEngine === "asset" && Boolean(theme.assetBundleId);
}

export { cozyTheme, comicBcTheme, flatCoolTheme };
export type { ThemeDescriptor, ThemeId, ThemeChangeListener, LoadedThemeAtlas } from "./types";
