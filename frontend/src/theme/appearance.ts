/**
 * 前端外观：配色（palette）× 视觉风格（style），纯客户端，与后端无关。
 * DOM：`html[data-qb-theme]` + `html[data-qb-style]`
 */

/** 默认风格配色 */
export const DEFAULT_PALETTE_IDS = ["dark-purple", "light-white", "light-sky"] as const;
export type DefaultPaletteId = (typeof DEFAULT_PALETTE_IDS)[number];

export const UI_PALETTE_IDS = [...DEFAULT_PALETTE_IDS] as const;
export type UiPaletteId = (typeof UI_PALETTE_IDS)[number];

export const UI_STYLE_IDS = [
  "default",
  "feishu-clean",
  "industrial",
  "bauhaus",
  "sci-fi-hud",
  "comic-book",
] as const;
export type UiStyleId = (typeof UI_STYLE_IDS)[number];

/** @deprecated 使用 UiPaletteId；保留别名供旧代码引用 */
export type UiThemeId = UiPaletteId;
export const UI_THEME_IDS = UI_PALETTE_IDS;

export const PALETTE_LABELS: Record<UiPaletteId, string> = {
  "dark-purple": "黑紫",
  "light-white": "白",
  "light-sky": "天蓝",
};

/** 当前风格下 TopBar 展示的配色项 */
export function palettesForStyle(_style: UiStyleId): readonly UiPaletteId[] {
  return DEFAULT_PALETTE_IDS;
}

/** 切换风格时把 palette 落到该风格合法取值 */
export function coercePaletteForStyle(_style: UiStyleId, palette: UiPaletteId): UiPaletteId {
  if ((UI_PALETTE_IDS as readonly string[]).includes(palette)) return palette;
  return "dark-purple";
}

export const STYLE_LABELS: Record<UiStyleId, string> = {
  default: "默认",
  "feishu-clean": "简洁",
  industrial: "工业设计",
  bauhaus: "Bauhaus 包豪斯",
  "sci-fi-hud": "科幻 HUD",
  "comic-book": "Comic Book 漫画书",
};

export interface UiAppearance {
  palette: UiPaletteId;
  style: UiStyleId;
}

const STORAGE_KEY = "qubit-ui-appearance-v2";
const LEGACY_THEME_KEY = "qubit-ui-theme-v1";

const LEGACY_PALETTE_MAP: Record<string, UiPaletteId> = {
  "dark-gray": "dark-purple",
  "light-mint": "light-white",
};

/** 已下线的风格 → 回落到现存风格（多数无对应，统一回 default） */
const LEGACY_STYLE_MAP: Record<string, UiStyleId> = {};

export function isLightPalette(palette: UiPaletteId): boolean {
  return palette.startsWith("light");
}

export function applyUiAppearance(appearance: UiAppearance): void {
  if (typeof document === "undefined") return;
  const style = normalizeStyle(appearance.style) ?? "default";
  const palette = coercePaletteForStyle(style, appearance.palette);
  const root = document.documentElement;
  root.setAttribute("data-qb-theme", palette);
  root.setAttribute("data-qb-style", style);
  root.dataset.qbPalette = palette;
  root.dataset.qbUiStyle = style;
}

export function readUiAppearance(): UiAppearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<UiAppearance>;
      const palette = normalizePalette(j.palette);
      const style = normalizeStyle(j.style);
      if (palette && style) {
        return { palette: coercePaletteForStyle(style, palette), style };
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy) {
      const palette = normalizePalette(legacy) ?? "dark-purple";
      return { palette, style: "default" };
    }
  } catch {
    /* ignore */
  }

  return { palette: "dark-purple", style: "default" };
}

export function persistUiAppearance(appearance: UiAppearance): void {
  const style = normalizeStyle(appearance.style) ?? "default";
  const normalized: UiAppearance = {
    style,
    palette: coercePaletteForStyle(style, appearance.palette),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    localStorage.setItem(LEGACY_THEME_KEY, normalized.palette);
  } catch {
    /* ignore */
  }
}

function normalizePalette(v: unknown): UiPaletteId | null {
  if (typeof v !== "string") return null;
  if (UI_PALETTE_IDS.includes(v as UiPaletteId)) return v as UiPaletteId;
  return LEGACY_PALETTE_MAP[v] ?? null;
}

function normalizeStyle(v: unknown): UiStyleId | null {
  if (typeof v !== "string") return null;
  if (UI_STYLE_IDS.includes(v as UiStyleId)) return v as UiStyleId;
  return LEGACY_STYLE_MAP[v] ?? null;
}

/** index.html 防 FOUC：与 readUiAppearance 规则一致 */
export function appearanceBootScript(): string {
  const palettes = JSON.stringify([...UI_PALETTE_IDS]);
  const styles = JSON.stringify([...UI_STYLE_IDS]);
  const legacyMap = JSON.stringify(LEGACY_PALETTE_MAP);
  const legacyStyleMap = JSON.stringify(LEGACY_STYLE_MAP);
  return `(function () {
  var PALETTES = ${palettes};
  var STYLES = ${styles};
  var LEGACY = ${legacyMap};
  var LEGACY_STYLE = ${legacyStyleMap};
  var root = document.documentElement;
  function normPalette(v) {
    if (PALETTES.indexOf(v) >= 0) return v;
    if (LEGACY[v]) return LEGACY[v];
    return "dark-purple";
  }
  function normStyle(v) {
    if (LEGACY_STYLE[v]) return LEGACY_STYLE[v];
    return STYLES.indexOf(v) >= 0 ? v : "default";
  }
  function normPaletteForStyle(style, v) {
    return normPalette(v);
  }
  try {
    var raw = localStorage.getItem("qubit-ui-appearance-v2");
    if (raw) {
      var j = JSON.parse(raw);
      var style = normStyle(j.style);
      root.setAttribute("data-qb-theme", normPaletteForStyle(style, j.palette));
      root.setAttribute("data-qb-style", style);
      return;
    }
    var legacy = localStorage.getItem("qubit-ui-theme-v1");
    root.setAttribute("data-qb-theme", normPalette(legacy));
    root.setAttribute("data-qb-style", "default");
  } catch {
    root.setAttribute("data-qb-theme", "dark-purple");
    root.setAttribute("data-qb-style", "default");
  }
})();`;
}
