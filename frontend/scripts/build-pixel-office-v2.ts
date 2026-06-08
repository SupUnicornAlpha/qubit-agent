#!/usr/bin/env bun
/**
 * Pixel Office v2 美术资产后处理脚本。
 *
 * 输入（AI 生成的白底 sprite sheet）：
 *   frontend/src/assets/pixel-office/v2/<bundle>/
 *     cats-a.png                7×4 grid · row=breed · col=pose
 *     cats-b.png                同上（另 4 个品种）
 *     props.png                 4×4 grid · 13 prop 名按行优先填入
 *     scene-bg.png              不处理（场景背景另外重新生成）
 *
 * 输出（入库，运行时使用）：
 *   <bundle>/cats-a.alpha.png    白色像素 → alpha=0
 *   <bundle>/cats-a.frames.json  { "<breed>_<pose>": {x,y,w,h}, ... }（精确内容 bbox）
 *   <bundle>/cats-b.alpha.png + frames.json
 *   <bundle>/props.alpha.png + frames.json
 *
 * 使用：
 *   cd frontend && bun run scripts/build-pixel-office-v2.ts
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { findContentBoundsInCell } from "../src/lib/pixelOffice/assetOffice/bbox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const V2_DIR = path.join(FRONTEND_DIR, "src/assets/pixel-office/v2");

const WHITE_THRESHOLD = 240;
const BBOX_PADDING = 2;
/**
 * Cell 边界附近的处理：
 *
 *   ALPHA_INSET  — alpha mask 强制透明区域宽度（只去 grid line，不切实际内容）
 *   BBOX_INSET   — bbox 检测时跳过的 cell 边缘宽度（避免把 grid line 算进 frame）
 *
 * 两者分离的原因：props sheet（desk / bookshelf / rack）里很多 sprite 会
 * 几乎占满整个 cell；alpha mask 不能太激进，否则会切掉桌脚或书架边角。
 * 但 bbox 检测可以放心向内 inset，因为生成的 frame 只用于贴图区域裁剪，
 * 略小一点不会影响视觉。
 */
const ALPHA_INSET = 5;
const BBOX_INSET = 14;

const POSES = ["idle", "walk1", "walk2", "work", "success", "fail", "empty"] as const;
type Pose = (typeof POSES)[number];

type Bundle = {
  id: string;
  cats: {
    a: { file: string; breeds: readonly string[] };
    b: { file: string; breeds: readonly string[] };
  };
  props: { file: string; names: readonly string[] };
};

/**
 * Props sprite sheet: STRICT 4 cols × 3 rows = 12 cells, row-major:
 *   Row 0: desk, chair, bookshelf, rack
 *   Row 1: monitor_idle, monitor_chat, monitor_code, monitor_ok
 *   Row 2: monitor_err, plant, coffee, decor
 *
 * Missing monitor states (mcp / skill / sandbox / empty) fall back to
 * monitor_idle inside the runtime manifest, NOT here.
 */
const PROP_NAMES = [
  "desk", "chair", "bookshelf", "rack",
  "monitor_idle", "monitor_chat", "monitor_code", "monitor_ok",
  "monitor_err", "plant", "coffee", "decor",
] as const;

const PROP_COLS = 4;
const PROP_ROWS = 3;

const BUNDLES: readonly Bundle[] = [
  {
    id: "comic-bc",
    cats: {
      a: { file: "cats-a.png", breeds: ["tabby", "black", "calico", "siamese"] },
      b: { file: "cats-b.png", breeds: ["white", "british", "ginger", "tuxedo"] },
    },
    props: { file: "props.png", names: PROP_NAMES },
  },
  {
    id: "flat-cool",
    cats: {
      a: { file: "cats-a.png", breeds: ["white", "british", "ginger", "tabby"] },
      b: { file: "cats-b.png", breeds: ["siamese", "calico", "tuxedo", "black"] },
    },
    props: { file: "props.png", names: PROP_NAMES },
  },
];

type FrameRect = { x: number; y: number; w: number; h: number };

async function loadRgba(srcPath: string): Promise<{ pixels: Uint8Array; w: number; h: number }> {
  const img = sharp(srcPath).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return {
    pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    w: info.width,
    h: info.height,
  };
}

function clampBoundsToImage(b: FrameRect, w: number, h: number, pad: number): FrameRect {
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  const x2 = Math.min(w, b.x + b.w + pad);
  const y2 = Math.min(h, b.y + b.h + pad);
  return { x, y, w: x2 - x, h: y2 - y };
}

type CellGrid = { cols: number; rows: number; cellW: number; cellH: number };

/**
 * 将整张 sprite sheet 中的:
 *   1. 白色像素（RGB ≥ threshold）
 *   2. 落在每个 cell 边界 inset 范围之外的像素（grid line 区）
 * 都强制 alpha=0。
 *
 * 这一步是保证渲染时不会出现黑色细框/网格线的关键。
 */
function whiteAndGridToAlpha(
  pixels: Uint8Array,
  w: number,
  h: number,
  threshold: number,
  grid: CellGrid,
  alphaInset: number,
): Buffer {
  const inset = alphaInset;
  const out = Buffer.alloc(pixels.length);
  out.set(pixels);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = out[i]!;
      const g = out[i + 1]!;
      const b = out[i + 2]!;
      let alpha = out[i + 3]!;

      if (r >= threshold && g >= threshold && b >= threshold) {
        alpha = 0;
      } else {
        /**
         * Coordinates relative to the cell this pixel belongs to.
         * If too close to any cell edge, treat as grid noise → transparent.
         */
        const localX = x % grid.cellW;
        const localY = y % grid.cellH;
        const colIdx = Math.floor(x / grid.cellW);
        const rowIdx = Math.floor(y / grid.cellH);
        const inSheet = colIdx < grid.cols && rowIdx < grid.rows;
        if (
          !inSheet ||
          localX < inset ||
          localX >= grid.cellW - inset ||
          localY < inset ||
          localY >= grid.cellH - inset
        ) {
          alpha = 0;
        }
      }

      out[i + 3] = alpha;
    }
  }
  return out;
}

async function processCatSheet(
  bundleDir: string,
  fileName: string,
  breeds: readonly string[],
): Promise<Record<string, FrameRect>> {
  const srcPath = path.join(bundleDir, fileName);
  const { pixels, w, h } = await loadRgba(srcPath);

  const cols = POSES.length;
  const rows = breeds.length;
  const cellW = Math.floor(w / cols);
  const cellH = Math.floor(h / rows);

  const frames: Record<string, FrameRect> = {};
  const tightCells: number[] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const breed = breeds[r]!;
      const pose: Pose = POSES[c]!;
      const key = `${breed}_${pose}`;
      const cellX = c * cellW;
      const cellY = r * cellH;
      /** Scan only the inner region of the cell, skipping grid lines. */
      const bounds = findContentBoundsInCell(
        pixels,
        w,
        cellX + BBOX_INSET,
        cellY + BBOX_INSET,
        cellW - 2 * BBOX_INSET,
        cellH - 2 * BBOX_INSET,
        WHITE_THRESHOLD,
      );
      if (!bounds) {
        console.warn(`  [warn] empty cell ${key} (${cellX},${cellY}); using full cell`);
        frames[key] = { x: cellX, y: cellY, w: cellW, h: cellH };
        continue;
      }
      frames[key] = clampBoundsToImage(bounds, w, h, BBOX_PADDING);
      tightCells.push(frames[key].w * frames[key].h);
    }
  }

  const outPng = srcPath.replace(/\.png$/i, ".alpha.png");
  const buf = whiteAndGridToAlpha(
    pixels,
    w,
    h,
    WHITE_THRESHOLD,
    { cols, rows, cellW, cellH },
    ALPHA_INSET,
  );
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPng);

  const outJson = srcPath.replace(/\.png$/i, ".frames.json");
  await fs.writeFile(outJson, JSON.stringify(frames, null, 2) + "\n", "utf-8");

  const avg = tightCells.length
    ? Math.round(tightCells.reduce((a, b) => a + b, 0) / tightCells.length)
    : 0;
  console.log(
    `  ${fileName}: ${rows}×${cols} cells, image ${w}×${h}, ` +
      `avg content area ≈ ${avg}px², wrote .alpha.png + .frames.json`,
  );

  return frames;
}

async function processPropsSheet(
  bundleDir: string,
  fileName: string,
  names: readonly string[],
): Promise<Record<string, FrameRect>> {
  const srcPath = path.join(bundleDir, fileName);
  const { pixels, w, h } = await loadRgba(srcPath);

  const cols = PROP_COLS;
  const rows = PROP_ROWS;
  const cellW = Math.floor(w / cols);
  const cellH = Math.floor(h / rows);

  const frames: Record<string, FrameRect> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const c = i % cols;
    const r = Math.floor(i / cols);
    if (r >= rows) break;
    const cellX = c * cellW;
    const cellY = r * cellH;
    const bounds = findContentBoundsInCell(
      pixels,
      w,
      cellX + BBOX_INSET,
      cellY + BBOX_INSET,
      cellW - 2 * BBOX_INSET,
      cellH - 2 * BBOX_INSET,
      WHITE_THRESHOLD,
    );
    frames[name] = bounds
      ? clampBoundsToImage(bounds, w, h, BBOX_PADDING)
      : { x: cellX, y: cellY, w: cellW, h: cellH };
  }

  const outPng = srcPath.replace(/\.png$/i, ".alpha.png");
  const buf = whiteAndGridToAlpha(
    pixels,
    w,
    h,
    WHITE_THRESHOLD,
    { cols, rows, cellW, cellH },
    ALPHA_INSET,
  );
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(outPng);

  const outJson = srcPath.replace(/\.png$/i, ".frames.json");
  await fs.writeFile(outJson, JSON.stringify(frames, null, 2) + "\n", "utf-8");

  console.log(
    `  ${fileName}: ${rows}×${cols} = ${rows * cols} prop cells (${names.length} names), ` +
      `image ${w}×${h}, wrote .alpha.png + .frames.json`,
  );

  return frames;
}

async function processBundle(bundle: Bundle) {
  const bundleDir = path.join(V2_DIR, bundle.id);
  const exists = await fs.stat(bundleDir).then(() => true).catch(() => false);
  if (!exists) {
    console.warn(`[skip] bundle dir not found: ${bundleDir}`);
    return;
  }
  console.log(`\n[bundle] ${bundle.id}`);
  await processCatSheet(bundleDir, bundle.cats.a.file, bundle.cats.a.breeds);
  await processCatSheet(bundleDir, bundle.cats.b.file, bundle.cats.b.breeds);
  await processPropsSheet(bundleDir, bundle.props.file, bundle.props.names);
}

async function main() {
  console.log(`[pixel-office v2] post-processing AI sprite sheets`);
  for (const bundle of BUNDLES) {
    await processBundle(bundle);
  }
  console.log(`\n[done] frames extracted with white-bg threshold=${WHITE_THRESHOLD}`);
}

main().catch((err) => {
  console.error("[pixel-office v2] FAILED:", err);
  process.exit(1);
});
