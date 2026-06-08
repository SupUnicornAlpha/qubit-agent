import { pixelFont } from "../fonts";
import { depthScale } from "../officePerspective";
import { drawDropShadow } from "../starOfficeStyle";
import type { CatAction, CatActor, CitySkyline, OfficeLayout, ScreenMode } from "../types";
import { catPoseForAction, resolveCatFrame } from "./catFrames";
import type { FrameRect, LoadedAssetBundle } from "./types";

function blit(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  frame: FrameRect,
  cx: number,
  by: number,
  scale: number,
  flipX = false
) {
  const dw = frame.w * scale;
  const dh = frame.h * scale;
  const dx = Math.round(cx - dw / 2);
  const dy = Math.round(by - dh);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flipX) {
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, dw, dh);
  } else {
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.h, dx, dy, dw, dh);
  }
  ctx.restore();
}

function propFrame(bundle: LoadedAssetBundle, name: string): FrameRect | null {
  return bundle.manifest.props.frames[name] ?? null;
}

/** 全屏 cover 绘制场景背景（AI 生成的完整办公室层） */
export function drawAssetSceneBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bundle: LoadedAssetBundle,
  _city: CitySkyline
) {
  const img = bundle.sceneBg;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

export function drawAssetShelfAndRack(
  ctx: CanvasRenderingContext2D,
  bundle: LoadedAssetBundle,
  layout: OfficeLayout
) {
  const { render } = bundle.manifest;
  const shelf = propFrame(bundle, "bookshelf");
  const rack = propFrame(bundle, "rack");
  if (shelf) {
    const s = render.shelfScaleBase * depthScale(layout.shelf.depth);
    blit(ctx, bundle.props, shelf, layout.shelf.x, layout.shelf.y + 20, s);
  }
  if (rack) {
    const s = render.rackScaleBase * depthScale(layout.rack.depth);
    blit(ctx, bundle.props, rack, layout.rack.x, layout.rack.y + 24, s);
  }
  ctx.fillStyle = "rgba(148, 163, 184, 0.85)";
  ctx.font = pixelFont(Math.max(9, 11 * depthScale(layout.shelf.depth)));
  ctx.textAlign = "center";
  ctx.fillText("技能书架", layout.shelf.x, layout.shelf.y + 48 * depthScale(layout.shelf.depth));
  ctx.fillText("MCP / 工具机架", layout.rack.x, layout.rack.y + 52 * depthScale(layout.rack.depth));
}

export function drawAssetWorkstation(
  ctx: CanvasRenderingContext2D,
  bundle: LoadedAssetBundle,
  x: number,
  y: number,
  screenMode: ScreenMode,
  depth: number,
  selected: boolean,
  hot: boolean
) {
  const { render, props } = bundle.manifest;
  const dScale = depthScale(depth);
  const desk = propFrame(bundle, "desk");
  const monName = props.monitorByScreenMode[screenMode] ?? "monitor_idle";
  const monitor = propFrame(bundle, monName);

  if (selected) {
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 40 * dScale, y - 56 * dScale, 80 * dScale, 64 * dScale);
  }
  if (hot) {
    ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
    ctx.fillRect(x - 36 * dScale, y - 52 * dScale, 72 * dScale, 58 * dScale);
  }

  if (desk) {
    blit(ctx, bundle.props, desk, x, y + 4, render.deskScaleBase * dScale);
  }
  if (monitor) {
    blit(ctx, bundle.props, monitor, x, y - 6 * dScale, render.monitorScaleBase * dScale);
  }
}

export function drawAssetCat(
  ctx: CanvasRenderingContext2D,
  bundle: LoadedAssetBundle,
  cat: CatActor,
  depth: number
) {
  const pose = catPoseForAction(cat.action, cat.frame);
  const resolved = resolveCatFrame(bundle, cat.breed, pose);
  if (!resolved) return;

  const scale = bundle.manifest.render.catScaleBase * depthScale(depth);
  const w = resolved.frame.w * scale;
  drawDropShadow(ctx, cat.x, cat.y + 2, w * 0.55, 5, 0.22);
  blit(ctx, resolved.image, resolved.frame, cat.x, cat.y, scale, cat.facing === -1);
}

export function drawAssetCatBubble(
  ctx: CanvasRenderingContext2D,
  cat: CatActor,
  now: number,
  depth: number
) {
  if (!cat.bubble || !cat.bubbleUntil || cat.bubbleUntil <= now) return;
  const d = depthScale(depth);
  const bx = cat.x;
  const by = cat.y - 52 * d;
  ctx.font = pixelFont(Math.max(10, 12 * d));
  const tw = ctx.measureText(cat.bubble).width;
  const pw = tw + 16;
  const ph = 22;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.strokeStyle = "#1a1020";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(bx - pw / 2, by - ph, pw, ph, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1a1020";
  ctx.textAlign = "center";
  ctx.fillText(cat.bubble, bx, by - ph / 2 + 4);
}

export function actionToAssetPose(action: CatAction, frame: number): string {
  return catPoseForAction(action, frame);
}
