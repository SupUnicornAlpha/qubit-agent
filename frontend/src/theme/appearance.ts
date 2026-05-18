/**
 * 前端外观：配色（palette）× 视觉风格（style），纯客户端，与后端无关。
 * DOM：`html[data-qb-theme]` + `html[data-qb-style]`
 */

export const UI_PALETTE_IDS = ["dark-purple", "light-white", "light-sky"] as const;
export type UiPaletteId = (typeof UI_PALETTE_IDS)[number];

export const UI_STYLE_IDS = [
  "default",
  "glassmorphism",
  "retro-futurism",
  "industrial",
  "neon-cyberpunk",
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

export const STYLE_LABELS: Record<UiStyleId, string> = {
  default: "默认",
  glassmorphism: "Glassmorphism",
  "retro-futurism": "复古未来主义",
  industrial: "工业设计",
  "neon-cyberpunk": "霓虹赛博朋克",
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

export function isLightPalette(palette: UiPaletteId): boolean {
  return palette.startsWith("light");
}

export function applyUiAppearance({ palette, style }: UiAppearance): void {
  if (typeof document === "undefined") return;
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
      if (palette && style) return { palette, style };
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    localStorage.setItem(LEGACY_THEME_KEY, appearance.palette);
  } catch {
    /* ignore */
  }
}

function normalizePalette(v: unknown): UiPaletteId | null {
  if (typeof v !== "string") return null;
  if (UI_PALETTE_IDS.includes(v as UiPaletteId)) return v as UiPaletteId;
  return LEGACY_PALETTE_MAP[v] ?? null;
}

const LEGACY_STYLE_MAP: Record<string, UiStyleId> = {
  "generative-art": "retro-futurism",
};

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
  return `(function () {
  var PALETTES = ${palettes};
  var STYLES = ${styles};
  var LEGACY = ${legacyMap};
  var root = document.documentElement;
  function normPalette(v) {
    if (PALETTES.indexOf(v) >= 0) return v;
    if (LEGACY[v]) return LEGACY[v];
    return "dark-purple";
  }
  function normStyle(v) {
    return STYLES.indexOf(v) >= 0 ? v : "default";
  }
  try {
    var raw = localStorage.getItem("qubit-ui-appearance-v2");
    if (raw) {
      var j = JSON.parse(raw);
      root.setAttribute("data-qb-theme", normPalette(j.palette));
      root.setAttribute("data-qb-style", normStyle(j.style));
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
