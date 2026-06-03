/**
 * 语言切换下拉框，复用 TopBar 现有的 `qb-style-select` 视觉。
 * 当且仅当注册了 ≥2 个语言包时渲染（单语言项目不展示无意义选择器）。
 */
import type { CSSProperties, FC } from "react";

import { useTranslation } from "./useTranslation";

interface Props {
  className?: string;
  style?: CSSProperties;
}

export const LanguageSwitcher: FC<Props> = ({ className, style }) => {
  const { locale, setLocale, locales, t } = useTranslation();

  if (locales.length < 2) return null;

  const label = t("topbar.language.label");
  const title = t("topbar.language.title");
  const id = "qb-ui-language";

  return (
    <>
      <label className="qb-visually-hidden" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={className ?? "qb-style-select"}
        value={locale}
        title={title}
        aria-label={label}
        onChange={(e) => setLocale(e.target.value)}
        style={style}
      >
        {locales.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </>
  );
};
