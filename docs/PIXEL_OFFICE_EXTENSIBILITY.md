# 像素办公室扩展架构

## 渲染档位

| 档位 | 说明 | 默认 |
|------|------|------|
| `hd` | 约 1K 级：精灵单元 8px、天际线艺术像素 2px、目标宽度 ≥1024 | ✅ |
| `standard` | 较轻量，小画布或低配设备 | |

```ts
import { setRenderTier } from "../frontend/src/lib/pixelOffice";

setRenderTier("standard"); // 切换档位后需刷新页面以重建图集
```

## 插件注册（核心扩展点）

在应用启动时（或办公室组件挂载前）注册：

```ts
import { registerPixelOfficePlugin } from "../frontend/src/lib/pixelOffice";

registerPixelOfficePlugin({
  id: "quant-celebration",
  priority: 10,
  register(reg) {
    // 1. 新城市天际线
    reg.registerSkyline("tokyo", (c) => {
      // c.ctx, c.ox, c.oy, c.areaW, c.areaH, c.pixel, c.now
    });

    // 2. 替换/追加精灵图集（PNG 序列、Lottie 烘焙、Rive 导出等）
    reg.registerSpriteProvider({
      id: "lottie-cats",
      getAtlas() { return myPrebakedAtlas; },
      invalidate() { /* 清缓存 */ },
    });

    // 3. 额外 team-graph 事件 → 办公室动作
    reg.registerEventMapperHook((graph, seen, emit) => {
      // emit([{ id, at, kind, role, ... }])
    });

    // 4. 场景叠加层（雨雪、节日装饰、水印）
    reg.registerOverlay("snow", (ctx, frame) => {
      // frame.width, frame.height, frame.now, frame.cityId
    }, zIndex);

    // 5. 整体替换背景绘制（少用）
    reg.setSceneBackgroundRenderer((ctx, w, h, cityId, now) => { ... });
  },
});
```

## 模块结构

```
frontend/src/lib/pixelOffice/
  config.ts           # 渲染档位 hd / standard
  registry.ts         # 插件注册表类型
  runtime.ts          # 单例 runtime + registerPixelOfficePlugin
  plugins/builtin.ts  # 内置天际线、精灵、背景
  skylineArt.ts       # 三地天际线像素稿
  skylineCanvas.ts    # 天际线绘制辅助
  spriteAtlas.ts      # 程序化精灵图集（可换 Provider）
  eventMapper.ts      # team-graph → OfficeEvent
  officeRenderer.ts   # 帧绘制（读 registry + config）
  officeLayout.ts     # 工位布局
  index.ts            # 对外 API
```

## 与未来动画格式的兼容

| 未来方案 | 接入方式 |
|----------|----------|
| **PNG/WebP 精灵表** | 实现 `SpriteAtlasProvider`，`getAtlas()` 返回与 `AtlasSprites` 同结构的对象 |
| **Lottie / Rive** | 烘焙为精灵表或 `registerOverlay` 在 Canvas 上叠一层 |
| **独立 Canvas 角色** | `registerOverlay` 中按 `CatActor` 状态自行绘制，或替换 `registerSpriteProvider` |
| **Spine / DragonBones** | 导出帧序列 → 自定义 Provider；或 WebGL 层作为 overlay |
| **新城市/新动作** | `registerSkyline` + `registerEventMapperHook`，无需改核心组件 |

`TeamAgentPixelOffice` 仅依赖 `mapGraphToOfficeEventsExtended` 与 `officeRenderer`，不硬编码动作列表以外的逻辑。

## 内置动作与事件

动作类型见 `types.ts` 中 `CatAction`。`eventMapper` 将 `toolCalls` / `mcpCalls` / `interactions` 转为：

- `go_rack` / `go_shelf` → 行走
- `at_rack` / `at_shelf` → 作业
- `success` / `fail` / `success_empty` → 结果反馈

插件可通过 `registerEventMapperHook` 追加自定义 `OfficeEventKind`（需在 renderer 中识别对应 `CatAction`）。
