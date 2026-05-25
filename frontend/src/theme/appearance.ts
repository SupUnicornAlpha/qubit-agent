/**
 * 前端外观：配色（palette）× 视觉风格（style），纯客户端，与后端无关。
 * DOM：`html[data-qb-theme]` + `html[data-qb-style]`
 */

/** 默认风格配色 */
export const DEFAULT_PALETTE_IDS = ["dark-purple", "light-white", "light-sky"] as const;
export type DefaultPaletteId = (typeof DEFAULT_PALETTE_IDS)[number];

/** Glass Holographic 底色（冷 / 暖 / 彩虹） */
export const GLASS_PALETTE_IDS = ["glass-cool", "glass-warm", "glass-rainbow"] as const;
export type GlassPaletteId = (typeof GLASS_PALETTE_IDS)[number];

/** Biophilic 亲自然（绿植涨 / 柔和红涨） */
export const BIO_PALETTE_IDS = ["bio-green", "bio-red"] as const;
export type BioPaletteId = (typeof BIO_PALETTE_IDS)[number];

export const UI_PALETTE_IDS = [...DEFAULT_PALETTE_IDS, ...GLASS_PALETTE_IDS, ...BIO_PALETTE_IDS] as const;
export type UiPaletteId = (typeof UI_PALETTE_IDS)[number];

export const UI_STYLE_IDS = [
  "default",
  "feishu-clean",
  "glass-holographic",
  "retro-futurism",
  "industrial",
  "neon-cyberpunk",
  "bauhaus",
  "sci-fi-hud",
  "comic-book",
  "anti-design",
  "blueprint",
  "hand-drawn-fabric",
  "ambient-3d",
  "biophilic",
] as const;
export type UiStyleId = (typeof UI_STYLE_IDS)[number];

/** @deprecated 使用 UiPaletteId；保留别名供旧代码引用 */
export type UiThemeId = UiPaletteId;
export const UI_THEME_IDS = UI_PALETTE_IDS;

export const PALETTE_LABELS: Record<UiPaletteId, string> = {
  "dark-purple": "黑紫",
  "light-white": "白",
  "light-sky": "天蓝",
  "glass-cool": "冷色",
  "glass-warm": "暖色",
  "glass-rainbow": "彩虹",
  "bio-green": "绿植（绿涨）",
  "bio-red": "柔和红（红涨）",
};

export function isGlassPalette(palette: UiPaletteId): palette is GlassPaletteId {
  return (GLASS_PALETTE_IDS as readonly string[]).includes(palette);
}

export function isBioPalette(palette: UiPaletteId): palette is BioPaletteId {
  return (BIO_PALETTE_IDS as readonly string[]).includes(palette);
}

/** 当前风格下 TopBar 展示的配色项 */
export function palettesForStyle(style: UiStyleId): readonly UiPaletteId[] {
  if (style === "glass-holographic") return GLASS_PALETTE_IDS;
  if (style === "biophilic") return BIO_PALETTE_IDS;
  return DEFAULT_PALETTE_IDS;
}

/** 切换风格时把 palette 落到该风格合法取值 */
export function coercePaletteForStyle(style: UiStyleId, palette: UiPaletteId): UiPaletteId {
  if (style === "glass-holographic") {
    if (isGlassPalette(palette)) return palette;
    return "glass-cool";
  }
  if (style === "biophilic") {
    if (isBioPalette(palette)) return palette;
    return "bio-green";
  }
  if (isBioPalette(palette)) return "dark-purple";
  if (isGlassPalette(palette)) return "dark-purple";
  if (style === "hand-drawn-fabric") {
    if (palette === "dark-purple" || isGlassPalette(palette) || isBioPalette(palette)) return "light-white";
  }
  if (style === "ambient-3d") {
    if (isBioPalette(palette) || isGlassPalette(palette) || palette.startsWith("light")) return "dark-purple";
  }
  return palette;
}

export const STYLE_LABELS: Record<UiStyleId, string> = {
  default: "默认",
  "feishu-clean": "简洁",
  "glass-holographic": "Glass Holographic",
  "retro-futurism": "复古未来主义 · CLI",
  industrial: "工业设计",
  "neon-cyberpunk": "霓虹赛博朋克",
  bauhaus: "Bauhaus 包豪斯",
  "sci-fi-hud": "科幻 HUD",
  "comic-book": "Comic Book 漫画书",
  "anti-design": "反设计 Anti-Design",
  blueprint: "Blueprint 工程蓝图",
  "hand-drawn-fabric": "手绘涂鸦 · 织物",
  "ambient-3d": "Ambient 3D · 柔光空间",
  biophilic: "Biophilic 亲自然",
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

const LEGACY_STYLE_MAP: Record<string, UiStyleId> = {
  "generative-art": "retro-futurism",
  glassmorphism: "glass-holographic",
  holographic: "glass-holographic",
  "hand-drawn-sketch": "hand-drawn-fabric",
  claymorphism: "ambient-3d",
  "neo-brutalism": "ambient-3d",
};

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
  var GLASS_PALETTES = ${JSON.stringify([...GLASS_PALETTE_IDS])};
  var BIO_PALETTES = ${JSON.stringify([...BIO_PALETTE_IDS])};
  function normStyle(v) {
    if (LEGACY_STYLE[v]) return LEGACY_STYLE[v];
    return STYLES.indexOf(v) >= 0 ? v : "default";
  }
  function normPaletteForStyle(style, v) {
    var p = normPalette(v);
    if (style === "glass-holographic") {
      if (GLASS_PALETTES.indexOf(p) >= 0) return p;
      return "glass-cool";
    }
    if (style === "biophilic") {
      if (BIO_PALETTES.indexOf(p) >= 0) return p;
      return "bio-green";
    }
    if (BIO_PALETTES.indexOf(p) >= 0) return "dark-purple";
    if (GLASS_PALETTES.indexOf(p) >= 0) return "dark-purple";
    return p;
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
