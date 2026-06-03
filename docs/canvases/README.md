# Canvas 存档

本目录是 Cursor Canvas 文件的 **只读源码存档**。Cursor IDE **不会**从这里直接渲染。

## 使用方法

要在 IDE 里打开（边栏渲染），把对应文件复制到你的 IDE 管理目录：

```bash
mkdir -p ~/.cursor/projects/Users-<your-username>-repos-mine-repos-qubit-agent/canvases
cp docs/canvases/*.canvas.tsx ~/.cursor/projects/Users-<your-username>-repos-mine-repos-qubit-agent/canvases/
```

（路径里 `Users-...` 一段是 Cursor 自动按你的工作区路径生成的，不要改成别人的；
完整真路径见你本地 `~/.cursor/projects/` 下唯一以 `qubit-agent` 结尾的子目录。）

复制后在聊天侧边栏直接点击 canvas 即可打开。

## 为什么不直接 commit 到 IDE 目录

Cursor Canvas 设计上要求文件位于 `~/.cursor/projects/<workspace>/canvases/` 才会被识别 ——
这个路径是用户本地的 IDE 元数据目录，不能纳入仓库。

所以本目录的副本仅用于：

1. 在 PR / code review 时可以查看 canvas 源码
2. 团队成员能拿到 canvas 源码并复制到自己本地的 IDE 目录
3. 历史追踪：什么时候新增 / 更新了哪个 canvas

## 现存 canvas

| 文件 | 主题 | 适用人群 |
|---|---|---|
| `memory-and-self-evolve-architecture.canvas.tsx` | **架构图**：4 层 + 1 控制平面，节点 + 连线（SVG 绘制） | 想理解"记忆 + 自进化"系统结构的工程师 |
| `self-evolving-agent-framework.canvas.tsx` | **框架报告**：9 期路线图 + worker 矩阵 + cron + 灰度 5 阶段 | PM / Tech lead / 想看交付进度的人 |

## 编辑注意

- 只能 import 自 `cursor/canvas`；无任何 npm / Node built-in
- 单文件，不能拆模块
- 颜色用 `useHostTheme()` 取，禁硬编码 hex
- 不能 `fetch()` / 网络请求 / 读外部文件，所有数据 inline 写死
- 改完测试：先复制回 `~/.cursor/projects/.../canvases/`，看 IDE 边栏是否 rendered
  （检查 `<name>.canvas.status.json` 出现 `{"status":"rendered"}` 即成功）
