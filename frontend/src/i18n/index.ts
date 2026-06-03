/**
 * 统一对外导出入口。业务代码统一从 `../i18n` 引入即可：
 *
 * ```ts
 * import { useTranslation, t, initI18n } from "@/i18n";
 * ```
 */
export { DEFAULT_LOCALE, initI18n, t, useI18nStore } from "./i18n";
export { REGISTERED_LOCALES, findLocalePack, getRegisteredLocaleIds } from "./registry";
export { useTranslation } from "./useTranslation";
export type { UseTranslationResult } from "./useTranslation";
export { LanguageSwitcher } from "./LanguageSwitcher";
export type { LocaleId, LocalePack, TranslationNode, TranslationParams, TranslationTree } from "./types";
