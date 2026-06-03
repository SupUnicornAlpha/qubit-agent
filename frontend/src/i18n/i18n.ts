/**
 * 前端 i18n 运行时：
 * - `useI18nStore`：基于 zustand 的语言状态（locale / 切换 / 持久化）。
 * - `t(key, params)`：纯函数式翻译查找（带 `{占位符}` 替换 + 缺失回退）。
 * - `initI18n()`：在应用入口处调用，决定初始 locale 并同步到 `<html lang>`。
 */
import { create } from "zustand";

import { findLocalePack, REGISTERED_LOCALES } from "./registry";
import type { LocaleId, LocalePack, TranslationNode, TranslationParams } from "./types";

/** 项目内文案以中文为源，因此默认/回退语言固定为 `zh-CN`。 */
export const DEFAULT_LOCALE: LocaleId = "zh-CN";

const STORAGE_KEY = "qubit:locale";

interface I18nState {
  /** 当前激活的语言 id（始终是注册表里存在的 id）。 */
  locale: LocaleId;
  /** 当前激活的语言包（缓存，避免每次 `t()` 都做注册表查询）。 */
  pack: LocalePack;
  /** 回退语言包；当当前语言缺 key 时尝试它。 */
  fallback: LocalePack | null;
  /** 切换语言；对未注册的 id 做静默忽略。 */
  setLocale: (id: LocaleId) => void;
}

function readPersistedLocale(): LocaleId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? v : null;
  } catch {
    return null;
  }
}

function writePersistedLocale(id: LocaleId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* SSR / 隐私模式下忽略 */
  }
}

/** 浏览器语言匹配：精确 → 前缀（`en-GB` → `en-US`）→ null。 */
function detectBrowserLocale(): LocaleId | null {
  if (typeof navigator === "undefined") return null;
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  const registered = REGISTERED_LOCALES.map((p) => p.id);
  for (const c of candidates) {
    if (registered.includes(c)) return c;
  }
  for (const c of candidates) {
    const prefix = c.split("-")[0]?.toLowerCase();
    if (!prefix) continue;
    const hit = registered.find((id) => id.split("-")[0]?.toLowerCase() === prefix);
    if (hit) return hit;
  }
  return null;
}

function resolveInitialLocale(): LocaleId {
  if (REGISTERED_LOCALES.length === 0) return DEFAULT_LOCALE;
  const persisted = readPersistedLocale();
  if (persisted && findLocalePack(persisted)) return persisted;
  const detected = detectBrowserLocale();
  if (detected) return detected;
  if (findLocalePack(DEFAULT_LOCALE)) return DEFAULT_LOCALE;
  // 极端兜底：用第一个已注册语言。
  return REGISTERED_LOCALES[0]!.id;
}

function ensurePack(id: LocaleId): LocalePack {
  const found = findLocalePack(id);
  if (found) return found;
  const fb = findLocalePack(DEFAULT_LOCALE);
  if (fb) return fb;
  // 没有任何语言包时返回一个空包，避免崩溃。
  return { id, name: id, translations: {} };
}

const initialLocale = resolveInitialLocale();
const initialPack = ensurePack(initialLocale);
const initialFallback =
  initialPack.id === DEFAULT_LOCALE ? null : findLocalePack(DEFAULT_LOCALE) ?? null;

export const useI18nStore = create<I18nState>((set) => ({
  locale: initialPack.id,
  pack: initialPack,
  fallback: initialFallback,
  setLocale: (id) => {
    const pack = findLocalePack(id);
    if (!pack) {
      if (typeof console !== "undefined") {
        console.warn(`[i18n] 未注册的语言：${id}`);
      }
      return;
    }
    writePersistedLocale(pack.id);
    applyDocumentAttributes(pack);
    set({
      locale: pack.id,
      pack,
      fallback: pack.id === DEFAULT_LOCALE ? null : findLocalePack(DEFAULT_LOCALE) ?? null,
    });
  },
}));

/**
 * 从字典树里读取一条文案。优先精确命中平铺 key，其次按 `.` 拆分逐层下钻。
 * 命中叶子且为字符串才返回，否则返回 `undefined`（避免误把节点当文案）。
 */
function readEntry(tree: LocalePack["translations"], key: string): string | undefined {
  const flat = tree[key];
  if (typeof flat === "string") return flat;

  const parts = key.split(".");
  let node: TranslationNode | undefined = tree;
  for (const part of parts) {
    if (node === undefined || node === null) return undefined;
    if (typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function format(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_RE, (_, name) => {
    const v = params[name];
    return v === undefined || v === null ? `{${name}}` : String(v);
  });
}

/**
 * 翻译查找：当前语言 → 回退语言（`zh-CN`） → 直接返回 key 字符串。
 * 在开发模式下，命中回退或返回 key 时打印一次警告，便于定位漏翻。
 */
export function t(key: string, params?: TranslationParams): string {
  const { pack, fallback } = useI18nStore.getState();
  const primary = readEntry(pack.translations, key);
  if (primary !== undefined) return format(primary, params);

  if (fallback) {
    const fb = readEntry(fallback.translations, key);
    if (fb !== undefined) {
      if (import.meta.env?.DEV) {
        warnMissingKey(pack.id, key);
      }
      return format(fb, params);
    }
  }

  if (import.meta.env?.DEV) {
    warnMissingKey(pack.id, key);
  }
  return key;
}

const warnedKeys = new Set<string>();
function warnMissingKey(locale: string, key: string): void {
  const sig = `${locale}::${key}`;
  if (warnedKeys.has(sig)) return;
  warnedKeys.add(sig);
  console.warn(`[i18n] 缺失翻译：locale=${locale} key=${key}`);
}

/** 将 locale 同步到 `<html lang dir>`。 */
function applyDocumentAttributes(pack: LocalePack): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("lang", pack.id);
  document.documentElement.setAttribute("dir", pack.dir ?? "ltr");
}

/** 在应用入口（`main.tsx`）调用一次：写入 `<html lang>`、暴露调试入口。 */
export function initI18n(): void {
  applyDocumentAttributes(useI18nStore.getState().pack);
  if (typeof window !== "undefined" && import.meta.env?.DEV) {
    (window as unknown as { __qubitI18n?: unknown }).__qubitI18n = {
      t,
      get state() {
        return useI18nStore.getState();
      },
      setLocale: (id: string) => useI18nStore.getState().setLocale(id),
    };
  }
}
