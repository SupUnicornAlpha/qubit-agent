# Pixel Office v2 美术资产

**资产驱动渲染**：`comic_bc` / `flat_cool` 主题不使用程序化 `spriteAtlas`，而是加载本目录 PNG + JSON。  
**Legacy `modern` / `modern_night` 主题已移除**，仅保留 `cozy` 一套程序化主题；默认主题为 `comic_bc`。

## 目录结构

```
v2/
  comic-bc/
    scene-bg.png            # 空办公室背景（无家具，1536×1024）
    cats-a.png              # 原始 AI 生成猫精灵表 A（白底）
    cats-a.alpha.png        # 去白底版（脚本输出，运行时使用）
    cats-a.frames.json      # 像素级精确帧坐标
    cats-b.png / .alpha.png / .frames.json
    props.png / .alpha.png / .frames.json
    manifest.ts             # import 上述 .alpha.png + .frames.json
  flat-cool/                # 同上结构，扁平酷感画风
```

## 帧布局

- **猫精灵表**：7 列 × 4 行，列顺序 `idle | walk1 | walk2 | work | success | fail | empty`，行对应品种。  
  实际帧矩形由脚本扫描每格非白像素得到的 bbox 决定（精度 ±2px padding）。
- **道具表**：4 × 4 网格，行优先填入：`desk, monitor_idle..monitor_empty (9 种), bookshelf, rack, plant, chair, coffee, decor`。  
  显示器随 cat 状态切换（参考 `props.monitorByScreenMode`）。
- **场景背景**：纯空办公室（无桌椅/电脑），所有家具与猫咪由代码逐工位 `blit` 在背景之上。

## 工具链

```bash
cd frontend
bun run scripts/build-pixel-office-v2.ts
```

脚本会：

1. 用 `findContentBoundsInCell` 扫描每个 cell 的非白像素 bbox，输出 `*.frames.json`
2. 把白色 RGB ≥ 240 的像素 alpha 置 0，输出 `*.alpha.png`

替换素材后重跑此脚本即可，运行时无需任何改动。

## 引擎入口

- 类型：`frontend/src/lib/pixelOffice/assetOffice/types.ts`
- 加载：`frontend/src/lib/pixelOffice/assetOffice/loader.ts`
- 帧解析：`frontend/src/lib/pixelOffice/assetOffice/catFrames.ts`
- 渲染：`frontend/src/lib/pixelOffice/assetOffice/renderer.ts`
- 主题：`themes/comicBc.ts` / `themes/flatCool.ts`，`renderEngine: "asset"`

## 单元测试

`frontend/src/lib/pixelOffice/assetOffice/bbox.test.ts`（`bun test`）覆盖 bbox 检测的边界条件。
