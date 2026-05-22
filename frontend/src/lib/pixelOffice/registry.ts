import type { PixelOfficeGraphInput } from "./types";

/** 天际线绘制上下文（插件实现此接口） */
export type SkylineDrawContext = {
  ctx: CanvasRenderingContext2D;
  ox: number;
  oy: number;
  areaW: number;
  areaH: number;
  pixel: number;
  now: number;
};

export type SkylineRenderer = (c: SkylineDrawContext) => void;

/** 场景背景绘制（天空 + 窗框 + 地板；天际线由 registry 调度） */
export type SceneBackgroundRenderer = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cityId: string,
  now: number
) => void;

/** 自定义图层（在 Agent 之上/之下绘制） */
export type OfficeOverlayRenderer = (ctx: CanvasRenderingContext2D, frame: OfficeFrameContext) => void;

export type OfficeFrameContext = {
  width: number;
  height: number;
  now: number;
  cityId: string;
  isRunning: boolean;
};

/** team-graph → 办公室事件；可链式扩展 */
export type OfficeEventMapperHook = (
  graph: PixelOfficeGraphInput,
  seenIds: ReadonlySet<string>,
  emit: (events: import("./types").OfficeEvent[]) => void
) => void;

/** 精灵图集提供者（未来可接 Lottie 烘焙图、PNG 序列、Rive 导出等） */
export type SpriteAtlasProvider = {
  id: string;
  getAtlas(): unknown;
  invalidate?: () => void;
};

export type PixelOfficePlugin = {
  id: string;
  /** 数字越大越晚执行 */
  priority?: number;
  register: (reg: PixelOfficeRegistry) => void;
};

export class PixelOfficeRegistry {
  private skylines = new Map<string, SkylineRenderer>();
  private sceneBackground: SceneBackgroundRenderer | null = null;
  private spriteProviders = new Map<string, SpriteAtlasProvider>();
  private defaultSpriteProviderId = "builtin";
  private overlays: Array<{ id: string; z: number; render: OfficeOverlayRenderer }> = [];
  private eventMapperHooks: OfficeEventMapperHook[] = [];

  registerSkyline(cityId: string, renderer: SkylineRenderer): void {
    this.skylines.set(cityId, renderer);
  }

  getSkyline(cityId: string): SkylineRenderer | undefined {
    return this.skylines.get(cityId);
  }

  listSkylineIds(): string[] {
    return [...this.skylines.keys()];
  }

  setSceneBackgroundRenderer(renderer: SceneBackgroundRenderer): void {
    this.sceneBackground = renderer;
  }

  getSceneBackgroundRenderer(): SceneBackgroundRenderer | null {
    return this.sceneBackground;
  }

  registerSpriteProvider(provider: SpriteAtlasProvider, opts?: { default?: boolean }): void {
    this.spriteProviders.set(provider.id, provider);
    if (opts?.default) this.defaultSpriteProviderId = provider.id;
  }

  getSpriteProvider(id?: string): SpriteAtlasProvider {
    const pid = id ?? this.defaultSpriteProviderId;
    const p = this.spriteProviders.get(pid);
    if (!p) throw new Error(`[pixelOffice] sprite provider not found: ${pid}`);
    return p;
  }

  registerOverlay(id: string, render: OfficeOverlayRenderer, z = 0): void {
    this.overlays.push({ id, z, render });
    this.overlays.sort((a, b) => a.z - b.z);
  }

  getOverlays(): ReadonlyArray<{ id: string; z: number; render: OfficeOverlayRenderer }> {
    return this.overlays;
  }

  registerEventMapperHook(hook: OfficeEventMapperHook): void {
    this.eventMapperHooks.push(hook);
  }

  getEventMapperHooks(): ReadonlyArray<OfficeEventMapperHook> {
    return this.eventMapperHooks;
  }
}
