/**
 * 前端国际化（i18n）类型定义。
 *
 * 设计目标：
 * 1. 字典既支持「嵌套对象」便于撰写，也支持「平铺 dot 字符串」便于覆盖；
 * 2. 任何新增语言包只需在 `dictionaries/` 目录下新增一个文件，
 *    `registry.ts` 通过 `import.meta.glob` 自动发现，无需改动注册中心；
 * 3. 缺失 key 自动回退到 `DEFAULT_LOCALE`（参见 `i18n.ts`）。
 */

/**
 * 语言代码（推荐使用 BCP-47，例如 `zh-CN` / `en-US` / `ja-JP`）。
 * 用 `string` 而非字面量联合，是为了让用户「丢文件」即可扩展。
 */
export type LocaleId = string;

/** 字典节点：字符串叶子，或嵌套子节点。 */
export type TranslationNode = string | TranslationTree;

/** 字典树：可任意嵌套，叶子必须是字符串。 */
export interface TranslationTree {
  [key: string]: TranslationNode;
}

/**
 * 一份完整的语言包。每个 `dictionaries/*.ts` 文件应 `export default` 一个 `LocalePack`。
 */
export interface LocalePack {
  /** BCP-47 代码，例如 `zh-CN`、`en-US`、`ja-JP`。 */
  id: LocaleId;
  /** 该语言的「自我称呼」，用于下拉菜单展示，如 `中文（简体）`、`English`、`日本語`。 */
  name: string;
  /** 该语言的英文名（可选），便于 RTL/CJK 场景下做次级展示。 */
  englishName?: string;
  /** 文本方向，默认为 `ltr`。 */
  dir?: "ltr" | "rtl";
  /**
   * 翻译条目。建议组织为嵌套对象，访问时使用 dot key（如 `t("topbar.subtitle")`）。
   * 也允许同时存在平铺 key（精确匹配优先级最高），便于做局部覆盖。
   */
  translations: TranslationTree;
}

/** `t()` 占位符替换的入参。 */
export type TranslationParams = Record<string, string | number | undefined | null>;
