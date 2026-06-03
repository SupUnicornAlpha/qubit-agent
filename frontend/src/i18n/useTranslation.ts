/**
 * `useTranslation` —— 在 React 组件中订阅当前语言并获得翻译函数。
 *
 * 之所以从 store 取 `locale`、却返回模块级的 `t`：
 * - 订阅 `locale` 触发组件重渲染（保证切语言时 UI 更新）；
 * - `t` 自身始终读取最新 store，无需把它做成依赖。
 */
import { useCallback } from "react";

import { t as moduleT, useI18nStore } from "./i18n";
import { REGISTERED_LOCALES } from "./registry";
import type { LocalePack, TranslationParams } from "./types";

export interface UseTranslationResult {
  /** 翻译查找。`params` 用于 `{name}` 这类占位符替换。 */
  t: (key: string, params?: TranslationParams) => string;
  /** 当前激活的 locale id。 */
  locale: string;
  /** 当前激活的语言包元信息。 */
  pack: LocalePack;
  /** 切换 locale；非法 id 静默忽略。 */
  setLocale: (id: string) => void;
  /** 已注册的全部语言包（按 id 排序），用于渲染下拉菜单。 */
  locales: readonly LocalePack[];
}

export function useTranslation(): UseTranslationResult {
  const locale = useI18nStore((s) => s.locale);
  const pack = useI18nStore((s) => s.pack);
  const setLocale = useI18nStore((s) => s.setLocale);

  // `t` 内部已读取最新 store，hook 只是为了在 locale 变化时触发重渲染。
  const t = useCallback((key: string, params?: TranslationParams) => moduleT(key, params), []);

  return { t, locale, pack, setLocale, locales: REGISTERED_LOCALES };
}
