#!/usr/bin/env bun
/**
 * 像素办公室美术 atlas 构建脚本。
 *
 * 输入：
 *   frontend/src/assets/pixel-office/raw/<pack>/*.png （itch.io 解压后的原始 PNG，被 .gitignore 忽略）
 *
 * 输出（入库，供 Vite/Phaser 加载）：
 *   frontend/src/assets/pixel-office/themes/<theme>/atlas.png
 *   frontend/src/assets/pixel-office/themes/<theme>/atlas.json   （Phaser TexturePacker Hash 格式）
 *   frontend/src/assets/pixel-office/themes/<theme>/manifest.ts  （TypeScript：分类 + frame 坐标 + attribution）
 *
 * 使用：
 *   cd frontend && bun run build:office-atlas
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "..");
const RAW_DIR = path.join(FRONTEND_DIR, "src/assets/pixel-office/raw");
const THEMES_DIR = path.join(FRONTEND_DIR, "src/assets/pixel-office/themes");
const TARGET_THEME = "modern";
const ATLAS_OUT_DIR = path.join(THEMES_DIR, TARGET_THEME);

const ATLAS_PADDING = 2;
const ATLAS_MAX_WIDTH = 256;

type FurnitureCategory =
  | "desk"
  | "chair"
  | "bookshelf"
  | "cabinet"
  | "printer"
  | "plant"
  | "sofa"
  | "table"
  | "coffee"
  | "vending"
  | "water"
  | "wallShelf"
  | "wallClock"
  | "wallArt"
  | "board"
  | "mirror"
  | "books"
  | "folders"
  | "papers"
  | "bin"
  | "decor";

type SpriteRecord = {
  name: string;
  source: string;
  category: FurnitureCategory;
  width: number;
  height: number;
  frame: { x: number; y: number; w: number; h: number } | null;
  buffer: Buffer;
};

type AttributionEntry = {
  name: string;
  license: string;
  url: string;
  required: boolean;
};

const ATTRIBUTION: AttributionEntry[] = [
  {
    name: "Antea Free Furniture Office Set",
    license: "CC-BY 4.0",
    url: "https://stcrbcn.itch.io/furniture-office-set",
    required: true,
  },
  {
    name: "2dPig Pixel Office Asset Pack",
    license: "CC0",
    url: "https://2dpig.itch.io/pixel-office",
    required: false,
  },
  {
    name: "Ark Pixel Font (12px proportional)",
    license: "OFL-1.1",
    url: "https://github.com/TakWolf/ark-pixel-font",
    required: false,
  },
];

const EXCLUDE_NAME_REGEX = [
  /^0-Tileset$/i,
  /^Toilet/i,
  /^WC-/i,
];

function classify(name: string): FurnitureCategory | null {
  const n = name.toLowerCase();
  if (EXCLUDE_NAME_REGEX.some((re) => re.test(name))) return null;
  if (n.includes("boss-desk")) return "desk";
  if (n.includes("desk")) return "desk";
  if (n.includes("boss-chair")) return "chair";
  if (n.includes("chair")) return "chair";
  if (n.includes("bookshelf")) return "bookshelf";
  if (n.includes("wall-shelf")) return "wallShelf";
  if (n.includes("wall-clock")) return "wallClock";
  if (n.includes("wall-graph") || n.includes("wall-note")) return "wallArt";
  if (n.includes("plant")) return "plant";
  if (n.includes("sofa")) return "sofa";
  if (n.includes("round-table") || n.includes("small-table") || n.includes("table")) return "table";
  if (n.includes("coffee-machine") || n.includes("coffee")) return "coffee";
  if (n.includes("vending")) return "vending";
  if (n.includes("water")) return "water";
  if (n.includes("printer")) return "printer";
  if (n.includes("cabinet")) return "cabinet";
  if (n.includes("board")) return "board";
  if (n.includes("mirror")) return "mirror";
  if (n.includes("books")) return "books";
  if (n.includes("folders")) return "folders";
  if (n.includes("papers")) return "papers";
  if (n.includes("bin")) return "bin";
  return "decor";
}

/**
 * Approximate horizontal footprint radius (in atlas pixels) used by pathfinding.
 * The renderer scales sprites by `furnitureScale * depthScale`, so this is a
 * unit-radius hint — pathfinding multiplies by the same factors at runtime.
 */
function footprintRadius(category: FurnitureCategory, w: number): number {
  if (category === "desk") return Math.max(10, Math.round(w * 0.45));
  if (category === "chair" || category === "table") return Math.max(6, Math.round(w * 0.4));
  if (category === "sofa") return Math.max(10, Math.round(w * 0.45));
  if (
    category === "bookshelf" ||
    category === "cabinet" ||
    category === "printer" ||
    category === "vending" ||
    category === "water" ||
    category === "coffee"
  ) {
    return Math.max(7, Math.round(w * 0.45));
  }
  return Math.max(4, Math.round(w * 0.4));
}

async function loadRawSprites(): Promise<SpriteRecord[]> {
  const sprites: SpriteRecord[] = [];
  const packs = await safeReadDir(RAW_DIR);
  for (const pack of packs) {
    const packDir = path.join(RAW_DIR, pack);
    const stat = await fs.stat(packDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;
    if (pack !== "antea-furniture") {
      // 2dPig 暂未做 sprite sheet 切片；后续迭代单独处理。
      console.log(`[skip] pack '${pack}' (本轮未实现切片器)`);
      continue;
    }
    const files = await fs.readdir(packDir);
    for (const file of files) {
      if (!file.toLowerCase().endsWith(".png")) continue;
      const baseName = file.replace(/\.png$/i, "");
      const category = classify(baseName);
      if (category === null) {
        console.log(`[exclude] ${pack}/${file}`);
        continue;
      }
      const fullPath = path.join(packDir, file);
      const buffer = await fs.readFile(fullPath);
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) {
        console.warn(`[warn] ${file} 缺少尺寸元数据，跳过`);
        continue;
      }
      sprites.push({
        name: baseName,
        source: `${pack}/${file}`,
        category,
        width: meta.width,
        height: meta.height,
        frame: null,
        buffer,
      });
    }
  }
  return sprites;
}

/**
 * Shelf packing：按高度降序，从左到右填入固定宽度的画布，
 * 每行高度 = 当前行最高 sprite。简单稳定，适合 ~50 个小 sprite。
 */
function shelfPack(sprites: SpriteRecord[], maxWidth: number, padding: number) {
  const sorted = [...sprites].sort((a, b) => b.height - a.height);
  let cursorX = padding;
  let cursorY = padding;
  let rowH = 0;
  let totalH = 0;
  for (const s of sorted) {
    if (cursorX + s.width + padding > maxWidth) {
      cursorY += rowH + padding;
      cursorX = padding;
      rowH = 0;
    }
    s.frame = { x: cursorX, y: cursorY, w: s.width, h: s.height };
    cursorX += s.width + padding;
    if (s.height > rowH) rowH = s.height;
    totalH = Math.max(totalH, cursorY + rowH + padding);
  }
  return { width: maxWidth, height: totalH };
}

async function composeAtlas(sprites: SpriteRecord[], width: number, height: number): Promise<Buffer> {
  const composites: sharp.OverlayOptions[] = sprites
    .filter((s): s is SpriteRecord & { frame: NonNullable<SpriteRecord["frame"]> } => s.frame !== null)
    .map((s) => ({ input: s.buffer, left: s.frame.x, top: s.frame.y }));

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

function buildPhaserAtlasJson(
  sprites: SpriteRecord[],
  atlasFileName: string,
  width: number,
  height: number
) {
  const frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: boolean;
      trimmed: boolean;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
    }
  > = {};
  for (const s of sprites) {
    if (!s.frame) continue;
    frames[s.name] = {
      frame: s.frame,
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: s.width, h: s.height },
      sourceSize: { w: s.width, h: s.height },
    };
  }
  return {
    frames,
    meta: {
      app: "scripts/build-office-atlas.ts",
      version: "1.0",
      image: atlasFileName,
      format: "RGBA8888",
      size: { w: width, h: height },
      scale: "1",
    },
  };
}

function buildManifestTs(
  sprites: SpriteRecord[],
  width: number,
  height: number,
  atlasFileName: string
): string {
  const byCategory = new Map<FurnitureCategory, string[]>();
  for (const s of sprites) {
    const arr = byCategory.get(s.category) ?? [];
    arr.push(s.name);
    byCategory.set(s.category, arr);
  }

  const categoriesLines: string[] = [];
  for (const [cat, names] of [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sortedNames = [...names].sort();
    const list = sortedNames.map((n) => `"${n}"`).join(", ");
    categoriesLines.push(`  ${cat}: [${list}],`);
  }

  const framesLines: string[] = [];
  const metaLines: string[] = [];
  for (const s of [...sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!s.frame) continue;
    framesLines.push(
      `  "${s.name}": { x: ${s.frame.x}, y: ${s.frame.y}, w: ${s.frame.w}, h: ${s.frame.h} },`
    );
    metaLines.push(
      `  "${s.name}": { category: "${s.category}", w: ${s.width}, h: ${s.height}, footprintRadius: ${footprintRadius(s.category, s.width)} },`
    );
  }

  const attributionLines = ATTRIBUTION.map(
    (a) =>
      `  { name: "${a.name.replace(/"/g, '\\"')}", license: "${a.license}", url: "${a.url}", required: ${a.required} },`
  ).join("\n");

  return `// AUTO-GENERATED by scripts/build-office-atlas.ts. Do not edit by hand.
// To regenerate: \`cd frontend && bun run build:office-atlas\`
// Source packs:
${ATTRIBUTION.map((a) => `//   - ${a.name} (${a.license})`).join("\n")}

import atlasUrl from "./${atlasFileName}";

export type ModernFurnitureCategory =
${[...byCategory.keys()].sort().map((c) => `  | "${c}"`).join("\n")};

export type ModernFrameRect = { x: number; y: number; w: number; h: number };

export type ModernSpriteMeta = {
  category: ModernFurnitureCategory;
  w: number;
  h: number;
  /** Approximate horizontal footprint radius (atlas px) used by pathfinding. */
  footprintRadius: number;
};

export type ModernAttribution = {
  name: string;
  license: string;
  url: string;
  required: boolean;
};

export const modernAtlasUrl: string = atlasUrl;

export const modernAtlasSize = { w: ${width}, h: ${height} };

/** Names grouped by semantic category, suitable for random pick or rotation. */
export const modernCategories: Record<ModernFurnitureCategory, readonly string[]> = {
${categoriesLines.join("\n")}
};

/** Per-sprite frame within the atlas (Canvas drawImage source rect). */
export const modernFrames: Record<string, ModernFrameRect> = {
${framesLines.join("\n")}
};

/** Per-sprite metadata (category + sizing hints). */
export const modernSpriteMeta: Record<string, ModernSpriteMeta> = {
${metaLines.join("\n")}
};

export const modernAttribution: readonly ModernAttribution[] = [
${attributionLines}
];

export const modernAtlasJsonUrl = new URL("./atlas.json", import.meta.url).href;
`;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function main() {
  console.log(`[build-office-atlas] raw  : ${path.relative(FRONTEND_DIR, RAW_DIR)}`);
  console.log(`[build-office-atlas] out  : ${path.relative(FRONTEND_DIR, ATLAS_OUT_DIR)}`);

  const sprites = await loadRawSprites();
  if (sprites.length === 0) {
    console.error(
      "\n[build-office-atlas] 未找到任何 raw sprite。请先按 frontend/src/assets/pixel-office/README.md 下载并解压资产。"
    );
    process.exit(1);
  }

  const { width, height } = shelfPack(sprites, ATLAS_MAX_WIDTH, ATLAS_PADDING);
  console.log(`[build-office-atlas] sprites: ${sprites.length}, atlas: ${width}x${height}`);

  await fs.mkdir(ATLAS_OUT_DIR, { recursive: true });

  const atlasFileName = "atlas.png";
  const atlasPath = path.join(ATLAS_OUT_DIR, atlasFileName);
  const atlasPng = await composeAtlas(sprites, width, height);
  await fs.writeFile(atlasPath, atlasPng);

  const json = buildPhaserAtlasJson(sprites, atlasFileName, width, height);
  await fs.writeFile(path.join(ATLAS_OUT_DIR, "atlas.json"), JSON.stringify(json, null, 2));

  const tsManifest = buildManifestTs(sprites, width, height, atlasFileName);
  await fs.writeFile(path.join(ATLAS_OUT_DIR, "manifest.ts"), tsManifest);

  const sizeKb = (atlasPng.byteLength / 1024).toFixed(1);
  console.log(`[build-office-atlas] atlas.png: ${sizeKb} KB`);

  const byCat = new Map<string, number>();
  for (const s of sprites) {
    byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
  }
  console.log(`[build-office-atlas] categories:`);
  for (const [cat, n] of [...byCat.entries()].sort()) {
    console.log(`    ${cat.padEnd(12)} ${n}`);
  }

  if (atlasPng.byteLength > 80 * 1024) {
    console.warn(
      `[build-office-atlas] WARN: atlas.png 超过 80 KB 目标 (${sizeKb} KB)。考虑缩小 ATLAS_MAX_WIDTH 或排除更多 decor。`
    );
  } else {
    console.log(`[build-office-atlas] OK: atlas.png ≤ 80 KB ✓`);
  }
}

main().catch((err) => {
  console.error("[build-office-atlas] FAILED:", err);
  process.exit(1);
});
