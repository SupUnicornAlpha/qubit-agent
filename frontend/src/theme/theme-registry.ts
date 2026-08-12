/**
 * 可安装 UI 主题包注册表。
 *
 * 主题包是纯声明式 JSON：token 用于所有页面，quantTokens 专门覆盖量化工作台。
 * css 为可选的、已作用域到 `html[data-qb-style="<id>"]` 的增强样式。它不加载或执行
 * JavaScript；导入主题等同于信任该主题的 CSS。
 */

export const BUILTIN_STYLE_IDS = [
  "default",
  "feishu-clean",
  "industrial",
  "bauhaus",
  "sci-fi-hud",
  "comic-book",
] as const;

export type BuiltinStyleId = (typeof BUILTIN_STYLE_IDS)[number];
export type ThemeColorScheme = "light" | "dark";

export interface ThemePackManifest {
  format: "qubit-ui-theme";
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  colorScheme: ThemeColorScheme;
  /** 页面通用 CSS custom properties，例如 --qb-bg-root。 */
  tokens: Record<string, string>;
  /** 量化工坊 CSS custom properties，例如 --qb-bg-surface / --qb-quant-accent-1。 */
  quantTokens: Record<string, string>;
  /** 可选视觉强化 CSS；必须显式包含该主题自己的 data-qb-style 作用域。 */
  css?: string;
}

export interface ThemeStyleDefinition {
  id: string;
  name: string;
  builtin: boolean;
  colorScheme?: ThemeColorScheme;
  version?: string;
}

const STORAGE_KEY = "qubit-ui-theme-packs-v1";
const STYLE_ELEMENT_PREFIX = "qb-installed-theme-";
const CHANGE_EVENT = "qb-theme-packs-change";
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const TOKEN_PATTERN = /^--qb-[a-z0-9-]+$/;

const BUILTIN_STYLES: ThemeStyleDefinition[] = [
  { id: "default", name: "默认", builtin: true },
  { id: "feishu-clean", name: "简洁", builtin: true, colorScheme: "light" },
  { id: "industrial", name: "工业设计", builtin: true, colorScheme: "dark" },
  { id: "bauhaus", name: "Bauhaus 包豪斯", builtin: true, colorScheme: "light" },
  { id: "sci-fi-hud", name: "科幻 HUD", builtin: true, colorScheme: "dark" },
  { id: "comic-book", name: "Comic Book 漫画书", builtin: true, colorScheme: "light" },
];

const hasWindow = () => typeof window !== "undefined" && typeof document !== "undefined";

function readInstalledPacks(): ThemePackManifest[] {
  if (!hasWindow()) return [];
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is ThemePackManifest => validateThemePack(entry).ok)
      : [];
  } catch {
    return [];
  }
}

function writeInstalledPacks(packs: ThemePackManifest[]): void {
  if (!hasWindow()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(packs));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function tokenDeclarations(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join("\n");
}

function themeCss(manifest: ThemePackManifest): string {
  const selector = `html[data-qb-style="${manifest.id}"]`;
  const rootTokens = { "color-scheme": manifest.colorScheme, ...manifest.tokens };
  const quantTokens = manifest.quantTokens;
  return `${selector} {\n${tokenDeclarations(rootTokens)}\n}\n${selector} [data-qb-quant-shell] {\n${tokenDeclarations(quantTokens)}\n}\n${manifest.css ?? ""}`;
}

function installStyle(manifest: ThemePackManifest): void {
  if (!hasWindow()) return;
  const elementId = `${STYLE_ELEMENT_PREFIX}${manifest.id}`;
  const element = document.getElementById(elementId) ?? document.createElement("style");
  element.id = elementId;
  element.textContent = themeCss(manifest);
  if (!element.parentNode) document.head.append(element);
}

export function validateThemePack(value: unknown):
  | { ok: true; value: ThemePackManifest }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "主题包必须是 JSON 对象" };
  const pack = value as Partial<ThemePackManifest>;
  if (pack.format !== "qubit-ui-theme" || pack.manifestVersion !== 1) {
    return { ok: false, error: "仅支持 qubit-ui-theme v1 主题包" };
  }
  if (typeof pack.id !== "string" || !ID_PATTERN.test(pack.id)) {
    return { ok: false, error: "id 必须为 2-64 位小写字母、数字或连字符" };
  }
  if ((BUILTIN_STYLE_IDS as readonly string[]).includes(pack.id)) {
    return { ok: false, error: "不能覆盖内置主题 id" };
  }
  if (typeof pack.name !== "string" || pack.name.trim().length === 0 || pack.name.length > 80) {
    return { ok: false, error: "name 必须为 1-80 个字符" };
  }
  if (typeof pack.version !== "string" || pack.version.length === 0 || pack.version.length > 32) {
    return { ok: false, error: "version 必须为 1-32 个字符" };
  }
  if (pack.colorScheme !== "light" && pack.colorScheme !== "dark") {
    return { ok: false, error: "colorScheme 必须为 light 或 dark" };
  }
  for (const section of [pack.tokens, pack.quantTokens]) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return { ok: false, error: "tokens 与 quantTokens 必须是键值对象" };
    }
    for (const [key, token] of Object.entries(section)) {
      if (!TOKEN_PATTERN.test(key) || typeof token !== "string" || token.length > 500) {
        return { ok: false, error: "主题 token 必须是 --qb-* 格式且值不超过 500 字符" };
      }
    }
  }
  if (pack.css !== undefined) {
    const selector = `html[data-qb-style="${pack.id}"]`;
    if (
      typeof pack.css !== "string" ||
      pack.css.length > 80_000 ||
      pack.css.includes("</style") ||
      /@import|url\s*\(/i.test(pack.css) ||
      !pack.css.includes(selector)
    ) {
      return { ok: false, error: "css 必须限定在本主题作用域内，且不得包含远程资源或 </style" };
    }
  }
  return { ok: true, value: pack as ThemePackManifest };
}

export function installThemePack(value: unknown): ThemePackManifest {
  const checked = validateThemePack(value);
  if (!checked.ok) throw new Error(checked.error);
  const packs = readInstalledPacks().filter((pack) => pack.id !== checked.value.id);
  packs.push(checked.value);
  installStyle(checked.value);
  writeInstalledPacks(packs);
  return checked.value;
}

export function uninstallThemePack(id: string): void {
  if ((BUILTIN_STYLE_IDS as readonly string[]).includes(id)) return;
  const packs = readInstalledPacks().filter((pack) => pack.id !== id);
  if (hasWindow()) document.getElementById(`${STYLE_ELEMENT_PREFIX}${id}`)?.remove();
  writeInstalledPacks(packs);
}

export function listThemeStyles(): ThemeStyleDefinition[] {
  const installed = readInstalledPacks().map((pack) => ({
    id: pack.id,
    name: pack.name,
    builtin: false,
    colorScheme: pack.colorScheme,
    version: pack.version,
  }));
  return [...BUILTIN_STYLES, ...installed];
}

export function isKnownThemeStyle(id: string): boolean {
  return listThemeStyles().some((style) => style.id === id);
}

export function loadInstalledThemeStyles(): void {
  for (const pack of readInstalledPacks()) installStyle(pack);
}

export function subscribeThemeStyles(listener: () => void): () => void {
  if (!hasWindow()) return () => undefined;
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
