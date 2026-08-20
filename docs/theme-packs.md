# 可安装主题包

QUBIT 的主题包是一个不执行 JavaScript 的 JSON 文件。主题作者提供全局视觉 token、量化工坊 token、主要工作区的表面配方，以及可选的作用域 CSS；用户在 IDE 的「配置中心 → 主题管理」导入、切换、更新或卸载主题。安装内容保存在本机浏览器/桌面应用的 localStorage，不会上传到后端。

可复制 [示例主题包](../examples/qubit-theme-pack.example.json) 作为起点。

## 主题包契约（v1）

```json
{
  "format": "qubit-ui-theme",
  "manifestVersion": 1,
  "id": "aurora-terminal",
  "name": "Aurora Terminal",
  "version": "1.0.0",
  "colorScheme": "dark",
  "tokens": { "--qb-bg-root": "#08111a" },
  "quantTokens": { "--qb-bg-surface": "#08111a" },
  "surfaces": {
    "team": { "background": "rgba(8, 26, 42, .64)", "blurPx": 16, "saturationPct": 125 },
    "chart": { "background": "rgba(8, 26, 42, .78)", "borderColor": "#245260" }
  },
  "css": "html[data-qb-style=\"aurora-terminal\"] { /* optional scoped CSS */ }"
}
```

`id` 必须为 2–64 位小写字母、数字或连字符，且不能与内置主题冲突。`tokens` 和 `quantTokens` 中的键必须以 `--qb-` 开头。导入同一个 `id` 会覆盖本机旧版本，因而可以作为主题更新机制。

## 工作区表面配方

`surfaces` 让主题作者无需写 CSS 选择器即可统一覆盖主要页面的面板质感。可选键为 `app`、`chrome`、`team`、`workspace`、`chart`；每项可写 `background`、`borderColor`、`shadow`、`radius`、`blurPx`、`saturationPct`。数值范围为 0–300。它特别适合玻璃化、半透明和统一圆角等跨页面视觉表达。

页面内容本身仍由 token 控制：团队工作台使用 `--qb-team-*`，行情/策略工作台使用 `--qb-kline-*`，图表画布及指标使用 `--qb-chart-*`。因此主题要做到完整适配，应该同时提供表面配方和相应的页面 token，而不是只换顶栏颜色。可直接导入仓库中的 [Vista Glass 参考主题](../frontend/src/theme/vista-glass.theme.json) 查看完整写法。

`css` 保留给非通用、结构化的高级效果；它不是主题功能的必经路径。

## 量化工坊必填视觉令牌

为避免“应用已换浅色、量化工坊仍是深色”的割裂，主题至少应填写以下 `quantTokens`：

- 表面与文字：`--qb-bg-surface`、`--qb-bg-elevated`、`--qb-bg-elevated-strong`、`--qb-bg-hero`、`--qb-text-muted`、`--qb-text-strong`
- 边框与状态：`--qb-border-subtle`、`--qb-border-strong`、`--qb-success`、`--qb-warn`、`--qb-error`、`--qb-info`
- 工坊语义色：`--qb-quant-accent-1` 至 `--qb-quant-accent-5`、`--qb-quant-danger`
- 装饰：`--qb-quant-hero-glow`、`--qb-quant-card-shadow`

量化组件只使用这些令牌和 `qb-quant-*` 类名；`css` 只适合放圆角、纹理、动画等额外的风格表达。为了避免影响其他主题，`css` 必须包含准确的 `html[data-qb-style="<id>"]` 作用域。

## 图表令牌

行情图表会在主题切换时即时重读以下 token：`--qb-chart-bg`、`--qb-chart-text`、`--qb-chart-grid`、`--qb-chart-border`、`--qb-chart-candle-up`、`--qb-chart-candle-down`，以及 `--qb-chart-indicator-primary`、`--qb-chart-indicator-secondary`、`--qb-chart-indicator-band`、`--qb-chart-indicator-mid`、`--qb-chart-indicator-signal`。未提供时会按主题的 `colorScheme` 使用安全默认色。

## 安全边界

主题包不支持脚本、远程下载（`@import` / `url()`）或运行时代码。CSS 仍属于可影响页面展示的受信任内容，因此只应导入可信作者提供的主题包。主题包当前按用户、本机安装；团队分发时，将 JSON 文件纳入仓库或内部制品库即可。
