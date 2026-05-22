/**
 * 像素办公室公共 API — 供 UI 与外部扩展使用。
 *
 * 扩展新动画/天际线/精灵：
 * ```ts
 * import { registerPixelOfficePlugin, getPixelOfficeRegistry } from '@/lib/pixelOffice';
 *
 * registerPixelOfficePlugin({
 *   id: 'my-pack',
 *   register(reg) {
 *     reg.registerSkyline('tokyo', (ctx) => { ... });
 *     reg.registerSpriteProvider({ id: 'my-atlas', getAtlas: () => ... });
 *     reg.registerEventMapperHook((graph, seen, emit) => { ... });
 *     reg.registerOverlay('rain', (ctx, frame) => { ... }, 10);
 *   },
 * });
 * ```
 */

export type { RenderConfig, RenderTier } from "./config";
export { getRenderConfig, getRenderTier, setRenderTier } from "./config";

export type {
  OfficeEvent,
  OfficeEventKind,
  CatAction,
  CatActor,
  CitySkyline,
  ScreenMode,
  PixelOfficeGraphInput,
  OfficeLayout,
} from "./types";

export { mapGraphToOfficeEvents, mapGraphToOfficeEventsExtended } from "./eventMapper";
export { computeOfficeLayout } from "./officeLayout";
export { getPixelOfficeRegistry, registerPixelOfficePlugin, resetPixelOfficeRuntime } from "./runtime";
export type {
  PixelOfficePlugin,
  PixelOfficeRegistry,
  SkylineRenderer,
  SkylineDrawContext,
  SpriteAtlasProvider,
  OfficeOverlayRenderer,
  OfficeEventMapperHook,
} from "./registry";

export { actionLabel, screenModeForAction } from "./officeRenderer";
