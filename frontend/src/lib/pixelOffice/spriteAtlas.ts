import { paletteForBreed, type CatPalette } from "./catAppearance";
import { getRenderConfig } from "./config";
import type { CatBreed } from "./types";
import type { ScreenMode } from "./types";

let atlasCanvas: HTMLCanvasElement | null = null;
let atlasBuild = -1;
let atlasSpriteUnit = 8;

type SpriteRect = { x: number; y: number; w: number; h: number };

export type AtlasSprites = {
  canvas: HTMLCanvasElement;
  spriteUnit: number;
  monitor: Record<ScreenMode, SpriteRect>;
  catIdle: Record<CatBreed, SpriteRect>;
  catWalk1: Record<CatBreed, SpriteRect>;
  catWalk2: Record<CatBreed, SpriteRect>;
  catWork: Record<CatBreed, SpriteRect>;
  catSuccess: Record<CatBreed, SpriteRect>;
  catFail: Record<CatBreed, SpriteRect>;
  catEmpty: Record<CatBreed, SpriteRect>;
  desk: SpriteRect;
  rack: SpriteRect;
  shelf: SpriteRect;
};

function makeFill(spriteUnit: number) {
  return (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x * spriteUnit, y * spriteUnit, w * spriteUnit, h * spriteUnit);
  };
}

/** 5×3 迷你像素字（大写） */
function miniText(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  text: string,
  color: string
) {
  const glyphs: Record<string, number[][]> = {
    M: [
      [1, 0, 1],
      [1, 1, 1],
      [1, 0, 1],
    ],
    C: [
      [0, 1, 1],
      [1, 0, 0],
      [0, 1, 1],
    ],
    P: [
      [1, 1, 0],
      [1, 0, 1],
      [1, 0, 0],
    ],
    O: [
      [0, 1, 0],
      [1, 0, 1],
      [0, 1, 0],
    ],
    K: [
      [1, 0, 1],
      [1, 1, 0],
      [1, 0, 1],
    ],
    S: [
      [0, 1, 1],
      [0, 1, 0],
      [1, 1, 0],
    ],
    L: [
      [1, 0, 0],
      [1, 0, 0],
      [1, 1, 1],
    ],
    I: [
      [1, 1, 1],
      [0, 1, 0],
      [1, 1, 1],
    ],
    "!": [
      [1],
      [1],
      [0],
    ],
    "?": [
      [0, 1, 0],
      [1, 0, 1],
      [0, 1, 0],
    ],
    "✓": [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ],
    "✗": [
      [1, 0, 1],
      [0, 1, 0],
      [1, 0, 1],
    ],
  };
  let cx = ox;
  for (const ch of text.toUpperCase().slice(0, 4)) {
    const g = glyphs[ch];
    if (!g) continue;
    for (let row = 0; row < g.length; row++) {
      for (let col = 0; col < (g[row]?.length ?? 0); col++) {
        if (g[row]![col]) fill(ctx, cx + col, oy + row, 1, 1, color);
      }
    }
    cx += 4;
  }
}

function drawMonitorPixels(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  mode: ScreenMode,
  t: number,
  hd: boolean
) {
  const mw = hd ? 48 : 32;
  const mh = hd ? 36 : 24;
  const blink = Math.floor(t / 350) % 2;
  fill(ctx, ox, oy, mw, mh, "#1e293b");
  fill(ctx, ox + 1, oy + 1, mw - 2, 4, "#334155");
  fill(ctx, ox + 2, oy + 2, 10, 1, "#64748b");
  fill(ctx, ox + mw - 8, oy + 2, 5, 1, "#94a3b8");
  fill(ctx, ox + 1, oy + 5, mw - 2, mh - 6, "#020617");
  fill(ctx, ox + 2, oy + 6, mw - 4, mh - 8, "#0f172a");
  fill(ctx, ox + 3, oy + 7, 2, mh - 10, "rgba(148,163,184,0.35)");

  switch (mode) {
    case "idle":
      fill(ctx, ox + 12, oy + 12, 8, 2, "#334155");
      break;
    case "chat":
      fill(ctx, ox + 4, oy + 8, 20, 2, "#38bdf8");
      fill(ctx, ox + 6, oy + 11, 16, 2, "#7dd3fc");
      fill(ctx, ox + 8, oy + 14, 12, 2, "#0ea5e9");
      miniText(fill, ctx, ox + (hd ? 32 : 22), oy + 8, "MSG", "#7dd3fc");
      break;
    case "code":
      for (let i = 0; i < 6; i++) {
        fill(ctx, ox + 4, oy + 7 + i * 2, 10 + (i % 3) * 2, 1, blink ? "#4ade80" : "#22c55e");
      }
      miniText(fill, ctx, ox + (hd ? 32 : 22), oy + 8, "PY", "#4ade80");
      break;
    case "mcp":
      fill(ctx, ox + 5, oy + 8, 6, 6, "#166534");
      fill(ctx, ox + 7, oy + 10, 2, 2, "#4ade80");
      fill(ctx, ox + 18, oy + 12, 8, 2, "#22c55e");
      miniText(fill, ctx, ox + 6, oy + (hd ? 22 : 16), "MCP", "#4ade80");
      break;
    case "skill":
      fill(ctx, ox + 10, oy + 7, 10, 12, "#b45309");
      fill(ctx, ox + 11, oy + 8, 8, 2, "#fef3c7");
      fill(ctx, ox + 12, oy + 11, 6, 6, "#fbbf24");
      miniText(fill, ctx, ox + 6, oy + (hd ? 22 : 16), "SKL", "#fbbf24");
      break;
    case "sandbox":
      fill(ctx, ox + 4, oy + 7, 22, 12, "#1e3a5f");
      fill(ctx, ox + 6 + blink, oy + 9, 4, 1, "#38bdf8");
      fill(ctx, ox + 14, oy + 14, 8, 2, "#7dd3fc");
      miniText(fill, ctx, ox + 6, oy + (hd ? 22 : 16), "SH", "#38bdf8");
      break;
    case "ok":
      fill(ctx, ox + 8, oy + 8, 14, 10, "#14532d");
      miniText(fill, ctx, ox + 12, oy + 12, "OK", "#4ade80");
      fill(ctx, ox + (hd ? 34 : 22), oy + 10, 4, 6, "#166534");
      miniText(fill, ctx, ox + (hd ? 34 : 22), oy + 11, "✓", "#4ade80");
      break;
    case "err":
      fill(ctx, ox + 8, oy + 8, 14, 10, "#7f1d1d");
      miniText(fill, ctx, ox + 10, oy + 12, "ERR", "#f87171");
      miniText(fill, ctx, ox + (hd ? 34 : 22), oy + 11, "✗", "#f87171");
      break;
    case "empty":
      fill(ctx, ox + 8, oy + 8, 14, 10, "#422006");
      fill(ctx, ox + 12, oy + 11, 6, 4, "#fbbf24");
      miniText(fill, ctx, ox + 14, oy + (hd ? 20 : 16), "?", "#fbbf24");
      break;
  }
  fill(ctx, ox + Math.floor(mw / 2) - 4, oy + mh - 4, 8, 2, "#475569");
  fill(ctx, ox + Math.floor(mw / 2) - 6, oy + mh - 2, 12, 1, "#334155");
}

function drawBreedMarkings(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  breed: CatBreed,
  pal: CatPalette
) {
  switch (breed) {
    case "tabby":
      fill(ctx, ox + 5, oy + 2, 4, 1, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 6, oy + 3, 1, 1, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 8, oy + 3, 1, 1, pal.stripe ?? "#8a5028");
      break;
    case "calico":
      fill(ctx, ox + 2, oy + 6, 3, 3, "#2a2a2a");
      fill(ctx, ox + 8, oy + 7, 3, 2, "#e87840");
      break;
    case "tuxedo":
      fill(ctx, ox + 3, oy + 7, 6, 4, pal.stripe ?? "#f0ece4");
      break;
    case "siamese":
      fill(ctx, ox + 2, oy + 2, 8, 5, pal.mask ?? "#4a3828");
      fill(ctx, ox + 4, oy + 4, 4, 2, pal.body);
      break;
    case "british":
      fill(ctx, ox + 2, oy + 5, 2, 2, pal.bodyDark);
      fill(ctx, ox + 10, oy + 5, 2, 2, pal.bodyDark);
      break;
    case "white":
      fill(ctx, ox + 1, oy + 1, 1, 1, "#fce7f3");
      fill(ctx, ox + 12, oy + 1, 1, 1, "#fce7f3");
      break;
    case "black":
      fill(ctx, ox + 5, oy + 3, 2, 1, "#a8f0b0");
      break;
    case "ginger":
      fill(ctx, ox + 1, oy + 9, 2, 4, pal.bodyDark);
      break;
  }
}

function drawCatPixels(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  breed: CatBreed,
  pal: CatPalette,
  pose: "idle" | "walk1" | "walk2" | "work" | "success" | "fail" | "empty",
  frame: number,
  hd: boolean
) {
  const bw = hd ? 18 : 12;
  const bh = hd ? 10 : 8;
  const tail = pose === "walk1" ? 1 : pose === "walk2" ? 0 : frame;
  fill(ctx, ox - 1 + tail, oy + 16, 2, 6, pal.bodyDark);
  fill(ctx, ox, oy + 10, bw, bh, pal.body);
  fill(ctx, ox + 2, oy + 12, bw - 4, bh - 3, pal.belly);
  if (pal.stripe && breed !== "tuxedo") {
    fill(ctx, ox + 2, oy + 8, 2, 3, pal.stripe);
    fill(ctx, ox + 8, oy + 9, 2, 3, pal.stripe);
  }
  fill(ctx, ox + 2, oy + 2, bw - 4, 9, pal.body);
  fill(ctx, ox + 1, oy + 1, 2, 4, pal.ear);
  fill(ctx, ox + bw - 3, oy + 1, 2, 4, pal.ear);
  drawBreedMarkings(fill, ctx, ox, oy, breed, pal);
  const eyeY = hd ? 6 : 5;
  fill(ctx, ox + 4, oy + eyeY, 2, 2, pal.eye);
  fill(ctx, ox + bw - 6, oy + eyeY, 2, 2, pal.eye);
  fill(ctx, ox + Math.floor(bw / 2) - 1, oy + 8, 2, 1, pal.nose);

  if (pose === "work") {
    fill(ctx, ox + 1 + frame, oy + 15, 3, 2, pal.bodyDark);
    fill(ctx, ox + 8 - frame, oy + 15, 3, 2, pal.bodyDark);
  }
  if (pose === "walk1") {
    fill(ctx, ox + 2, oy + 16, 3, 2, pal.bodyDark);
    fill(ctx, ox + 7, oy + 14, 3, 2, pal.bodyDark);
  }
  if (pose === "walk2") {
    fill(ctx, ox + 4, oy + 14, 3, 2, pal.bodyDark);
    fill(ctx, ox + 5, oy + 16, 3, 2, pal.bodyDark);
  }
  if (pose === "success") {
    fill(ctx, ox + 11, oy, 2, 2, "#fbbf24");
    fill(ctx, ox + 13, oy + 1, 2, 2, "#4ade80");
    fill(ctx, ox + 5, oy + 7, 3, 2, "#f0a8b0");
  }
  if (pose === "fail") {
    fill(ctx, ox + 3, oy, 2, 2, "#f87171");
    fill(ctx, ox + 8, oy, 2, 2, "#f87171");
    fill(ctx, ox + 4, oy + 9, 4, 1, "#f87171");
  }
  if (pose === "empty") {
    fill(ctx, ox + 11, oy + 6, 3, 3, "#fbbf24");
    fill(ctx, ox + 12, oy + 8, 1, 1, "#0f172a");
  }
}

function drawDeskSprite(fill: ReturnType<typeof makeFill>, ctx: CanvasRenderingContext2D, ox: number, oy: number, hd: boolean) {
  const dw = hd ? 56 : 40;
  const ch = hd ? 10 : 8;
  fill(ctx, ox + Math.floor(dw * 0.26), oy + 1, Math.floor(dw * 0.48), ch, "#4a4038");
  fill(ctx, ox + Math.floor(dw * 0.3), oy + 3, Math.floor(dw * 0.4), ch - 4, "#5c5048");
  fill(ctx, ox, oy + 20, dw, 5, "#5c4a32");
  fill(ctx, ox + 2, oy + 18, dw - 4, 2, "#6d5a43");
  fill(ctx, ox + 4, oy + 6, dw - 8, 14, "#3d3020");
  fill(ctx, ox + 6, oy + 8, dw - 12, 9, "#2a2218");
  fill(ctx, ox + 8, oy + 9, dw - 16, 1, "#4a4038");
  fill(ctx, ox + 10, oy + 11, hd ? 22 : 16, hd ? 7 : 5, "#1e293b");
  fill(ctx, ox + 11, oy + 12, hd ? 20 : 14, hd ? 5 : 3, "#334155");
  fill(ctx, ox + dw - (hd ? 14 : 10), oy + 12, hd ? 8 : 6, hd ? 5 : 4, "#475569");
  fill(ctx, ox + 3, oy + 22, 3, hd ? 6 : 5, "#3d3020");
  fill(ctx, ox + dw - 6, oy + 22, 3, hd ? 6 : 5, "#3d3020");
}

function drawRackSprite(fill: ReturnType<typeof makeFill>, ctx: CanvasRenderingContext2D, ox: number, oy: number, hd: boolean) {
  const rw = hd ? 36 : 28;
  const rh = hd ? 46 : 36;
  fill(ctx, ox, oy, rw, rh, "#0f172a");
  fill(ctx, ox + 2, oy + 2, rw - 4, rh - 4, "#1e293b");
  for (let i = 0; i < 5; i++) {
    fill(ctx, ox + 4, oy + 4 + i * 8, rw - 8, 5, "#334155");
    const row = 5 + i * (hd ? 8 : 6);
    fill(ctx, ox + 6, oy + row, 3, 2, "#22c55e");
    fill(ctx, ox + 14, oy + row, 3, 2, "#38bdf8");
    fill(ctx, ox + rw - 6, oy + row, 2, 2, blinkLed(i));
  }
}

function blinkLed(i: number): string {
  return i % 2 === 0 ? "#4ade80" : "#22d3ee";
}

function drawShelfSprite(fill: ReturnType<typeof makeFill>, ctx: CanvasRenderingContext2D, ox: number, oy: number, hd: boolean) {
  const sw = hd ? 34 : 26;
  const sh = hd ? 44 : 34;
  fill(ctx, ox, oy, sw, sh, "#5c4030");
  for (let i = 0; i < 4; i++) {
    const row = 3 + i * (hd ? 10 : 8);
    fill(ctx, ox + 2, oy + row, sw - 4, 2, "#6d5040");
    fill(ctx, ox + 4, oy + row + 2, 5, 5, i % 2 ? "#fbbf24" : "#f59e0b");
    fill(ctx, ox + 12, oy + row + 2, 6, 5, i % 2 ? "#d97706" : "#b45309");
    fill(ctx, ox + sw - 7, oy + row + 3, 3, 4, "#78716c");
  }
}

const BREEDS: CatBreed[] = [
  "tabby",
  "black",
  "white",
  "calico",
  "siamese",
  "british",
  "tuxedo",
  "ginger",
];

const MONITOR_MODES: ScreenMode[] = [
  "idle",
  "chat",
  "code",
  "mcp",
  "skill",
  "sandbox",
  "ok",
  "err",
  "empty",
];

export function getSpriteAtlas(config = getRenderConfig()): AtlasSprites {
  const S = config.spriteUnit;
  if (atlasCanvas && atlasBuild === config.atlasBuild && atlasSpriteUnit === S) {
    return (atlasCanvas as HTMLCanvasElement & { __sprites: AtlasSprites }).__sprites;
  }

  atlasCanvas = null;
  atlasBuild = config.atlasBuild;
  atlasSpriteUnit = S;
  const fill = makeFill(S);
  const hd = config.tier === "hd";

  const W = hd ? 1200 : 900;
  const H = hd ? 640 : 480;
  const c = document.createElement("canvas");
  c.width = W * S;
  c.height = H * S;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  let cx = 0;
  let cy = 0;
  const rowH = hd ? 40 : 28;
  const place = (w: number, h: number): SpriteRect => {
    if (cx + w > W) {
      cx = 0;
      cy += rowH + 2;
    }
    const r = { x: cx, y: cy, w, h };
    cx += w + 2;
    return r;
  };

  const monitor: Record<ScreenMode, SpriteRect> = {} as Record<ScreenMode, SpriteRect>;
  for (const m of MONITOR_MODES) {
    const r = place(hd ? 50 : 34, hd ? 38 : 26);
    drawMonitorPixels(fill, ctx, r.x, r.y, m, 0, hd);
    monitor[m] = r;
  }

  const catIdle = {} as Record<CatBreed, SpriteRect>;
  const catWalk1 = {} as Record<CatBreed, SpriteRect>;
  const catWalk2 = {} as Record<CatBreed, SpriteRect>;
  const catWork = {} as Record<CatBreed, SpriteRect>;
  const catSuccess = {} as Record<CatBreed, SpriteRect>;
  const catFail = {} as Record<CatBreed, SpriteRect>;
  const catEmpty = {} as Record<CatBreed, SpriteRect>;

  for (const breed of BREEDS) {
    const pal = paletteForBreed(breed);
    const poseList: Array<
      [typeof catIdle, "idle" | "walk1" | "walk2" | "work" | "success" | "fail" | "empty"]
    > = [
      [catIdle, "idle"],
      [catWalk1, "walk1"],
      [catWalk2, "walk2"],
      [catWork, "work"],
      [catSuccess, "success"],
      [catFail, "fail"],
      [catEmpty, "empty"],
    ];
    for (const [map, pose] of poseList) {
      const r = place(hd ? 22 : 16, hd ? 30 : 22);
      drawCatPixels(fill, ctx, r.x + 1, r.y + 1, breed, pal, pose, 0, hd);
      map[breed] = r;
    }
  }

  const desk = place(hd ? 60 : 44, hd ? 30 : 24);
  drawDeskSprite(fill, ctx, desk.x, desk.y, hd);
  const rack = place(hd ? 38 : 30, hd ? 48 : 38);
  drawRackSprite(fill, ctx, rack.x, rack.y, hd);
  const shelf = place(hd ? 36 : 28, hd ? 46 : 36);
  drawShelfSprite(fill, ctx, shelf.x, shelf.y, hd);

  const sprites: AtlasSprites = {
    canvas: c,
    spriteUnit: S,
    monitor,
    catIdle,
    catWalk1,
    catWalk2,
    catWork,
    catSuccess,
    catFail,
    catEmpty,
    desk,
    rack,
    shelf,
  };
  (c as HTMLCanvasElement & { __sprites: AtlasSprites }).__sprites = sprites;
  atlasCanvas = c;
  return sprites;
}

export function blitSprite(
  ctx: CanvasRenderingContext2D,
  atlas: AtlasSprites,
  rect: SpriteRect,
  dx: number,
  dy: number,
  scale: number,
  flipX = false
) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flipX) {
    ctx.translate(dx + rect.w * scale, dy);
    ctx.scale(-1, 1);
    const su = atlas.spriteUnit;
    ctx.drawImage(
      atlas.canvas,
      rect.x * su,
      rect.y * su,
      rect.w * su,
      rect.h * su,
      0,
      0,
      rect.w * scale,
      rect.h * scale
    );
  } else {
    const su = atlas.spriteUnit;
    ctx.drawImage(
      atlas.canvas,
      rect.x * su,
      rect.y * su,
      rect.w * su,
      rect.h * su,
      dx,
      dy,
      rect.w * scale,
      rect.h * scale
    );
  }
  ctx.restore();
}

export function drawMonitorSprite(
  ctx: CanvasRenderingContext2D,
  atlas: AtlasSprites,
  x: number,
  y: number,
  mode: ScreenMode,
  now: number,
  scale = 4
) {
  const rect = atlas.monitor[mode];
  blitSprite(ctx, atlas, rect, x - (rect.w * scale) / 2, y - rect.h * scale - 4, scale);
  if (mode === "code" || mode === "mcp") {
    const blink = Math.floor(now / 400) % 2;
    if (blink) {
      ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
      ctx.fillRect(x - 28, y - rect.h * scale - 8, 56, rect.h * scale + 4);
    }
  }
}
