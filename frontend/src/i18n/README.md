# 前端 i18n 模块

> 一个零额外依赖、可热扩展的轻量国际化方案。新增语言包 = **丢一个文件**。

## 快速使用

```tsx
import { useTranslation } from "@/i18n";

export const Hello = () => {
  const { t } = useTranslation();
  return <div title={t("topbar.style.label")}>{t("sidebar.nav.ide")}</div>;
};
```

带占位符：

```ts
t("topbar.restart.title", { url: "http://127.0.0.1:17385" });
// 中文： "重启内置后端（http://127.0.0.1:17385）"
// 英文： "Restart the embedded backend (http://127.0.0.1:17385)"
```

切换语言（会自动持久化到 `localStorage` 与 `<html lang>`）：

```ts
import { useI18nStore } from "@/i18n";
useI18nStore.getState().setLocale("en-US");
```

## 新增一个语言包

> 系统使用 Vite 的 `import.meta.glob` 自动发现 `dictionaries/*.ts`，
> 你**不需要**修改任何注册中心。

### 第 1 步 —— 复制 `zh-CN.ts`

```bash
cp src/i18n/dictionaries/zh-CN.ts src/i18n/dictionaries/ja-JP.ts
```

### 第 2 步 —— 改头部元信息

```ts
const pack: LocalePack = {
  id: "ja-JP",                  // BCP-47 代码
  name: "日本語",                // 自我称呼（用于下拉框展示）
  englishName: "Japanese",      // 可选
  dir: "ltr",                   // 或 "rtl"（如阿拉伯语 ar-SA）
  translations: {
    /* 把对应文案译成日文即可 */
  },
};

export default pack;
```

### 第 3 步 —— 翻译文案

- 字典是嵌套对象，键名建议保留中文版的结构。
- 占位符使用 `{name}`、`{count}` 等同名变量，**不要更名**。
- 缺漏的 key 会自动回退到 `zh-CN`，并在 dev 控制台输出 `[i18n] 缺失翻译：…`。

### 第 4 步 —— 重新构建

无需任何注册步骤。`bun run --cwd frontend dev` 重启或 HMR 即生效，
顶栏下拉菜单会**自动出现**新语言。

## 字典约定

- key 风格：**`module.scene.meaning`**，如 `sidebar.nav.ide`、`topbar.restart.button`。
- 既支持嵌套对象写法（推荐），也支持平铺 dot key（用于局部覆盖）：

  ```ts
  // 两种写法等价：
  { topbar: { brandSubtitle: "..." } }
  { "topbar.brandSubtitle": "..." }
  ```

- 占位符语法：`{name}`，运行时由 `t(key, { name })` 提供值。
- **源语言**为 `zh-CN`（参见 `i18n.ts` 中的 `DEFAULT_LOCALE`）。
  如需更换源语言，仅需改这一处常量。

## 检查覆盖率

```ts
import { useI18nStore, REGISTERED_LOCALES, t } from "@/i18n";

// 浏览器控制台（dev 模式自动暴露）：
window.__qubitI18n.setLocale("en-US");
window.__qubitI18n.t("sidebar.nav.ide");
```

打开应用后切到目标语言走一遍主要页面，控制台中所有
`[i18n] 缺失翻译：locale=… key=…` 警告即为待补的 key。

## 工程化建议

- **命名空间**：新功能尽量先开新顶级 key，避免污染 `common` 与 `topbar`。
- **复数与时间**：当前未内置 ICU；如有复杂复数需求，
  可在字典中拆成 `xxx.one` / `xxx.other` 自行组合，
  或在该 key 的位置接入 `Intl.PluralRules`。
- **持久化**：用户选择的 locale 存储在 `localStorage["qubit:locale"]`，
  清除即回到「浏览器语言探测 → `zh-CN`」的兜底链路。
