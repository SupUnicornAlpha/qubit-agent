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

function propFrame(bundle: LoadedAssetBundle, name: string): FrameRect | null {
  return bundle.manifest.props.frames[name] ?? null;
}

/**
 * 在场景左/右两侧绘制书架与机柜。`layout.shelf.x` / `layout.rack.x` 在窄
 * 画布上会贴得太近边缘，这里强制至少留 6% 画布宽度的内边距，避免被裁。
 */
export function drawAssetShelfAndRack(
  ctx: CanvasRenderingContext2D,
  bundle: LoadedAssetBundle,
  layout: OfficeLayout,
  canvasW: number,
) {
  const { render } = bundle.manifest;
  const shelf = propFrame(bundle, "bookshelf");
  const rack = propFrame(bundle, "rack");
  const margin = Math.max(72, canvasW * 0.06);
  if (shelf) {
    const s = render.shelfScaleBase * depthScale(layout.shelf.depth);
    const sw = shelf.w * s;
    const sx = Math.max(margin + sw / 2, layout.shelf.x);
    blit(ctx, bundle.props, shelf, sx, layout.shelf.y + 12, s);
  }
  if (rack) {
    const s = render.rackScaleBase * depthScale(layout.rack.depth);
    const rw = rack.w * s;
    const rx = Math.min(canvasW - margin - rw / 2, layout.rack.x);
    blit(ctx, bundle.props, rack, rx, layout.rack.y + 12, s);
  }
}

/**
 * 每只猫的工位 = 选中光圈 + desk + monitor。
 *
 * 关键的视觉约束：cat sprite frame 由 bbox 紧贴 cat content 计算，但 cat
 * 自身的轮廓边缘存在 1~2 像素的 anti-aliased 半透明像素带。如果 monitor
 * 与 cat 的 x 范围有任何重叠，z-order 即使 cat 在前，cat 边缘的半透明
 * 像素也会让下层 monitor 的山景图透出来，看起来就像"猫身上有半透明
 * 图案"——这正是用户看到的怪象。
 *
 * 解决：把 desk + monitor 的中心 x 拉到 cat 中心右侧 75 * dScale，再把
 * desk / monitor 的尺寸适当收缩，使 monitor 左沿落在 cat 右沿外侧、
 * 完全不与 cat 的可见像素重合；desk 只与 cat 边缘有 1~2 px 接触，
 * 视觉上像"猫站在自家工位旁边"。
 */
export function drawAssetWorkstation(
  ctx: CanvasRenderingContext2D,
  bundle: LoadedAssetBundle,
  x: number,
  y: number,
  screenMode: ScreenMode,
  depth: number,
  selected: boolean,
  hot: boolean,
) {
  const { render, props } = bundle.manifest;
  const dScale = depthScale(depth);
  const desk = propFrame(bundle, "desk");
  const monName = props.monitorByScreenMode[screenMode] ?? "monitor_idle";
  const monitor = propFrame(bundle, monName) ?? propFrame(bundle, "monitor_idle");

  if (selected || hot) {
    const rx = 38 * dScale;
    const ry = 9 * dScale;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y + 4 * dScale, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = selected
      ? "rgba(255, 215, 0, 0.22)"
      : "rgba(56, 189, 248, 0.18)";
    ctx.fill();
    ctx.restore();
  }

  const wsOffsetX = 75 * dScale;
  let deskTopY = y;
  if (desk) {
    const deskScale = render.deskScaleBase * dScale;
    const deskH = desk.h * deskScale;
    blit(ctx, bundle.props, desk, x + wsOffsetX, y, deskScale);
    deskTopY = y - deskH;
  }
  if (monitor) {
    const monScale = render.monitorScaleBase * dScale;
    blit(ctx, bundle.props, monitor, x + wsOffsetX, deskTopY + 4 * dScale, monScale);
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
