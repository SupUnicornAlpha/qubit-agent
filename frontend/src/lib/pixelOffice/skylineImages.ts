import shanghaiUrl from "../../assets/pixel-office/skyline-shanghai.png";
import type { CitySkyline } from "./types";
import type { SkylineDrawContext } from "./registry";

const SKYLINE_SRC: Record<CitySkyline, string> = {
  shanghai: shanghaiUrl,
};

const cache = new Map<CitySkyline, HTMLImageElement>();
const readyListeners = new Set<() => void>();

function notifyReady(): void {
  for (const fn of readyListeners) fn();
}

function loadOne(city: CitySkyline): HTMLImageElement {
  let img = cache.get(city);
  if (img) return img;
  img = new Image();
  img.decoding = "async";
  img.onload = () => notifyReady();
  img.onerror = () => notifyReady();
  img.src = SKYLINE_SRC[city];
  cache.set(city, img);
  return img;
}

/** 图片加载完成后回调（用于触发重绘） */
export function onSkylineImagesReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** 预加载窗外风景（办公室挂载时调用） */
export function preloadSkylineImages(): void {
  for (const city of Object.keys(SKYLINE_SRC) as CitySkyline[]) {
    loadOne(city);
  }
}

export function isSkylineImageReady(city: CitySkyline): boolean {
  const img = cache.get(city);
  return Boolean(img?.complete && img.naturalWidth > 0);
}

/** 以 cover 方式绘制像素风天际线插图（保持锐利缩放） */
export function drawSkylineImage(ctx: SkylineDrawContext, city: CitySkyline): boolean {
  const img = loadOne(city);
  if (!img.complete || img.naturalWidth <= 0) return false;

  const { ox, oy, areaW, areaH } = ctx;
  const areaAspect = areaW / areaH;
  const imgAspect = img.naturalWidth / img.naturalHeight;

  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;

  if (imgAspect > areaAspect) {
    sw = img.naturalHeight * areaAspect;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / areaAspect;
    sy = (img.naturalHeight - sh) / 2;
  }

  const { ctx: c } = ctx;
  c.save();
  c.imageSmoothingEnabled = false;
  c.drawImage(img, sx, sy, sw, sh, ox, oy, areaW, areaH);
  c.restore();
  return true;
}
