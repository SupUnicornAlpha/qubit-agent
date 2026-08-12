# 可安装主题包

QUBIT 的主题包是一个不执行 JavaScript 的 JSON 文件。主题作者提供全局视觉 token、量化工坊 token 和可选的作用域 CSS；用户在顶部栏点击“导入主题”后立即安装并切换。安装内容保存在本机浏览器/桌面应用的 localStorage，不会上传到后端。

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
  "css": "html[data-qb-style=\"aurora-terminal\"] { /* optional scoped CSS */ }"
}
```

`id` 必须为 2–64 位小写字母、数字或连字符，且不能与内置主题冲突。`tokens` 和 `quantTokens` 中的键必须以 `--qb-` 开头。导入同一个 `id` 会覆盖本机旧版本，因而可以作为主题更新机制。

## 量化工坊必填视觉令牌

为避免“应用已换浅色、量化工坊仍是深色”的割裂，主题至少应填写以下 `quantTokens`：

- 表面与文字：`--qb-bg-surface`、`--qb-bg-elevated`、`--qb-bg-elevated-strong`、`--qb-bg-hero`、`--qb-text-muted`、`--qb-text-strong`
- 边框与状态：`--qb-border-subtle`、`--qb-border-strong`、`--qb-success`、`--qb-warn`、`--qb-error`、`--qb-info`
- 工坊语义色：`--qb-quant-accent-1` 至 `--qb-quant-accent-5`、`--qb-quant-danger`
- 装饰：`--qb-quant-hero-glow`、`--qb-quant-card-shadow`

量化组件只使用这些令牌和 `qb-quant-*` 类名；`css` 只适合放圆角、纹理、动画等额外的风格表达。为了避免影响其他主题，`css` 必须包含准确的 `html[data-qb-style="<id>"]` 作用域。

## 安全边界

主题包不支持脚本、远程下载（`@import` / `url()`）或运行时代码。CSS 仍属于可影响页面展示的受信任内容，因此只应导入可信作者提供的主题包。主题包当前按用户、本机安装；团队分发时，将 JSON 文件纳入仓库或内部制品库即可。
