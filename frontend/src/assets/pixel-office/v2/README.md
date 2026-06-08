# Pixel Office v2 美术资产

**资产驱动渲染**：`comic_bc` / `flat_cool` 主题不再使用程序化 `spriteAtlas` 绘制猫咪与场景，而是加载本目录 PNG + manifest。

## 目录结构

```
v2/
  comic-bc/
    scene-bg.png    # 完整办公室场景层（1536×1024）
    cats-a.png      # 猫精灵表 A：tabby/black/calico/siamese × 7 pose
    cats-b.png      # 猫精灵表 B：white/british/ginger/tuxedo × 7 pose
    props.png       # 工位/显示器/书架/机架道具（4×4 网格）
    manifest.ts     # 帧坐标 + 渲染参数
  flat-cool/
    （同上结构，扁平酷感画风）
```

## 猫咪帧布局

每张 cats 图：**7 列 × 4 行**，单元格约 219×256 px。

列顺序：`idle | walk1 | walk2 | work | success | fail | empty`

## 引擎入口

- 加载：`frontend/src/lib/pixelOffice/assetOffice/loader.ts`
- 渲染：`frontend/src/lib/pixelOffice/assetOffice/renderer.ts`
- 主题：`renderEngine: "asset"` + `assetBundleId`

## 替换资产

1. 替换对应 PNG（保持文件名或同步改 manifest import）
2. 若网格变化，更新 `manifest.ts` 中的 `cellW/cellH` 与 props 网格
3. 无需重跑 build:office-atlas（v2 与 Antea legacy atlas 独立）

## 生成来源

美术由 AI 生成（2026-06-05），漫画 BC + 扁平酷感双主题。后续可换为 hand-pixel 或 itch.io 资产包，只需更新 PNG + manifest。
