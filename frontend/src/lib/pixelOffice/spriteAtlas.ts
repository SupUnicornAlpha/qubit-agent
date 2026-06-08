import { paletteForBreed, type CatPalette } from "./catAppearance";
import { getRenderConfig } from "./config";
import type { CatBreed } from "./types";
import type { ScreenMode } from "./types";

let atlasCanvas: HTMLCanvasElement | null = null;
let atlasBuild = -1;
let atlasSpriteUnit = 8;

export function invalidateSpriteAtlas(): void {
  atlasCanvas = null;
  atlasBuild = -1;
}

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

  // === 边框：双层金属感 ===
  fill(ctx, ox, oy, mw, mh, "#0f172a");
  fill(ctx, ox + 1, oy + 1, mw - 2, mh - 2, "#1e293b");

  // 顶部状态条（含 LED）
  fill(ctx, ox + 1, oy + 1, mw - 2, 3, "#334155");
  fill(ctx, ox + 3, oy + 2, 1, 1, "#22c55e"); // 电源 LED
  fill(ctx, ox + 5, oy + 2, 1, 1, "#475569"); // 待机
  fill(ctx, ox + mw - 8, oy + 2, 5, 1, "#64748b"); // 品牌带

  // 屏幕内凹
  fill(ctx, ox + 1, oy + 4, mw - 2, mh - 7, "#020617");
  fill(ctx, ox + 2, oy + 5, mw - 4, mh - 9, "#0f172a");

  // === 静态内容（运行时叠加在此基础上） ===
  switch (mode) {
    case "idle":
      // 屏保点阵
      fill(ctx, ox + 12, oy + 12, 8, 2, "#334155");
      fill(ctx, ox + 16, oy + 16, 4, 2, "#1e293b");
      break;
    case "chat":
      // 消息气泡群（蓝紫渐变）
      fill(ctx, ox + 3, oy + 7, 14, 3, "#1e3a8a");
      fill(ctx, ox + 3, oy + 7, 13, 1, "#3b82f6");
      fill(ctx, ox + mw - 18, oy + 12, 14, 3, "#1e40af");
      fill(ctx, ox + mw - 18, oy + 12, 13, 1, "#60a5fa");
      fill(ctx, ox + 3, oy + 17, 12, 3, "#1e3a8a");
      fill(ctx, ox + 3, oy + 17, 11, 1, "#3b82f6");
      miniText(fill, ctx, ox + 4, oy + 23, "MSG", "#93c5fd");
      break;
    case "code":
      // 多行代码（绿色行 + 行号）
      for (let i = 0; i < 7; i++) {
        fill(ctx, ox + 3, oy + 6 + i * 2, 1, 1, "#475569"); // 行号
        fill(ctx, ox + 5, oy + 6 + i * 2, 8 + (i % 4) * 2, 1, blink ? "#4ade80" : "#22c55e");
        if (i % 3 === 1) {
          fill(ctx, ox + 15, oy + 6 + i * 2, 5, 1, "#facc15"); // 关键字高亮
        }
      }
      miniText(fill, ctx, ox + mw - 12, oy + 6, "PY", "#4ade80");
      break;
    case "mcp":
      // 网络节点 + 连线（拓扑图）
      fill(ctx, ox + 4, oy + 8, 3, 3, "#166534");
      fill(ctx, ox + 5, oy + 9, 1, 1, "#4ade80");
      fill(ctx, ox + mw - 8, oy + 7, 3, 3, "#166534");
      fill(ctx, ox + mw - 7, oy + 8, 1, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2), oy + 14, 3, 3, "#166534");
      fill(ctx, ox + Math.floor(mw / 2) + 1, oy + 15, 1, 1, "#4ade80");
      // 节点连线
      for (let i = 0; i < 6; i++) {
        fill(ctx, ox + 7 + i * 2, oy + 11 + (i % 2), 1, 1, "#22c55e");
        fill(ctx, ox + mw - 9 - i * 2, oy + 10 + (i % 2), 1, 1, "#22c55e");
      }
      miniText(fill, ctx, ox + 3, oy + mh - 7, "MCP", "#4ade80");
      break;
    case "skill":
      // 翻开的书 + 页面文字行
      fill(ctx, ox + 6, oy + 6, mw - 12, mh - 14, "#b45309");
      fill(ctx, ox + 7, oy + 7, mw - 14, mh - 16, "#fef3c7");
      // 中缝
      fill(ctx, ox + Math.floor(mw / 2), oy + 7, 1, mh - 16, "#92400e");
      // 文字行
      for (let i = 0; i < 4; i++) {
        fill(ctx, ox + 8, oy + 9 + i * 2, 6, 1, "#78350f");
        fill(ctx, ox + Math.floor(mw / 2) + 2, oy + 9 + i * 2, 6, 1, "#78350f");
      }
      miniText(fill, ctx, ox + 3, oy + mh - 7, "SKL", "#fbbf24");
      break;
    case "sandbox":
      // 终端：提示符 + 命令历史
      fill(ctx, ox + 2, oy + 5, mw - 4, mh - 11, "#0c1929");
      // 提示符 $
      fill(ctx, ox + 4, oy + 7, 1, 1, "#22d3ee");
      fill(ctx, ox + 4, oy + 8, 1, 1, "#22d3ee");
      fill(ctx, ox + 4, oy + 9, 1, 1, "#22d3ee");
      // 命令行（多行）
      fill(ctx, ox + 6, oy + 7, 8, 1, "#7dd3fc");
      fill(ctx, ox + 6, oy + 9, 6, 1, "#94a3b8");
      fill(ctx, ox + 4, oy + 11, 1, 1, "#22d3ee");
      fill(ctx, ox + 6, oy + 11, 10, 1, "#7dd3fc");
      fill(ctx, ox + 4, oy + 13, 1, 1, "#22d3ee");
      fill(ctx, ox + 6, oy + 13, 4, 1, "#7dd3fc");
      // 光标（静态版；runtime 会再叠一个闪烁的）
      fill(ctx, ox + 11, oy + 13, 1, 1, "#22d3ee");
      miniText(fill, ctx, ox + mw - 10, oy + mh - 7, "SH", "#38bdf8");
      break;
    case "ok":
      // 大勾 + 庆祝条幅
      fill(ctx, ox + 4, oy + 6, mw - 8, mh - 12, "#052e16");
      fill(ctx, ox + 5, oy + 7, mw - 10, mh - 14, "#14532d");
      // 大对勾
      fill(ctx, ox + Math.floor(mw / 2) - 4, oy + 12, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2) - 3, oy + 13, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2) - 2, oy + 14, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2) - 1, oy + 13, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2), oy + 12, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2) + 1, oy + 11, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2) + 2, oy + 10, 2, 1, "#4ade80");
      fill(ctx, ox + Math.floor(mw / 2) + 3, oy + 9, 1, 1, "#4ade80");
      miniText(fill, ctx, ox + 4, oy + mh - 7, "OK!", "#86efac");
      break;
    case "err":
      // 大叉 + 红色警告
      fill(ctx, ox + 4, oy + 6, mw - 8, mh - 12, "#450a0a");
      fill(ctx, ox + 5, oy + 7, mw - 10, mh - 14, "#7f1d1d");
      // 大 X
      for (let i = 0; i < 7; i++) {
        fill(ctx, ox + Math.floor(mw / 2) - 3 + i, oy + 9 + i, 1, 1, "#f87171");
        fill(ctx, ox + Math.floor(mw / 2) + 3 - i, oy + 9 + i, 1, 1, "#f87171");
      }
      miniText(fill, ctx, ox + 4, oy + mh - 7, "ERR", "#fca5a5");
      break;
    case "empty":
      // 空集 / 大问号
      fill(ctx, ox + 4, oy + 6, mw - 8, mh - 12, "#422006");
      fill(ctx, ox + 5, oy + 7, mw - 10, mh - 14, "#78350f");
      // 大 ?
      fill(ctx, ox + Math.floor(mw / 2) - 2, oy + 9, 4, 1, "#fbbf24");
      fill(ctx, ox + Math.floor(mw / 2) + 1, oy + 10, 1, 2, "#fbbf24");
      fill(ctx, ox + Math.floor(mw / 2), oy + 12, 1, 1, "#fbbf24");
      fill(ctx, ox + Math.floor(mw / 2), oy + 14, 1, 1, "#fbbf24");
      miniText(fill, ctx, ox + 4, oy + mh - 7, "NIL", "#fde68a");
      break;
  }

  // === 扫描线（CRT 感觉，所有 mode 共享） ===
  for (let y = 5; y < mh - 4; y += 2) {
    fill(ctx, ox + 2, oy + y, mw - 4, 1, "rgba(0,0,0,0.13)");
  }

  // === 玻璃反光（左上角斜光） ===
  fill(ctx, ox + 3, oy + 5, 3, 1, "rgba(255,255,255,0.18)");
  fill(ctx, ox + 4, oy + 6, 2, 1, "rgba(255,255,255,0.12)");
  fill(ctx, ox + 5, oy + 7, 1, 1, "rgba(255,255,255,0.08)");

  // === 底座（带圆形按钮） ===
  fill(ctx, ox + Math.floor(mw / 2) - 5, oy + mh - 3, 10, 2, "#475569");
  fill(ctx, ox + Math.floor(mw / 2) - 7, oy + mh - 1, 14, 1, "#334155");
  fill(ctx, ox + Math.floor(mw / 2) - 1, oy + mh - 2, 2, 1, "#22c55e");
}

type CatPose = "idle" | "walk1" | "walk2" | "work" | "success" | "fail" | "empty";
type EyeMood = "open" | "narrow" | "happyCurve" | "starry" | "closedX" | "wideEmpty";
type MouthMood = "smile" | "neutral" | "frown" | "openO";

/**
 * 在头部 (rows 3-13) 上画品种独有花纹：条纹、斑块、面罩、对比色等。
 * 全部叠加在 base body 之上，因此调用顺序很重要（必须在 base body 之后调用）。
 */
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
      // 头顶 M 形条纹（虎斑标志）+ 身体侧条纹
      fill(ctx, ox + 7, oy + 3, 1, 2, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 9, oy + 3, 1, 2, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 11, oy + 3, 1, 2, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 13, oy + 3, 1, 2, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 5, oy + 5, 1, 1, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 15, oy + 5, 1, 1, pal.stripe ?? "#8a5028");
      // 身体条纹
      fill(ctx, ox + 5, oy + 15, 2, 1, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 13, oy + 15, 2, 1, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 5, oy + 17, 2, 1, pal.stripe ?? "#8a5028");
      fill(ctx, ox + 13, oy + 17, 2, 1, pal.stripe ?? "#8a5028");
      break;
    case "calico":
      // 不规则三色斑块（头黑 + 身橙）—— 头部斑块下移避开 row 2 圆切角
      fill(ctx, ox + 5, oy + 3, 3, 3, "#2a2a2a");
      fill(ctx, ox + 5, oy + 6, 2, 2, "#2a2a2a");
      fill(ctx, ox + 12, oy + 4, 4, 3, "#c87840");
      fill(ctx, ox + 4, oy + 15, 4, 4, "#2a2a2a");
      fill(ctx, ox + 12, oy + 16, 4, 4, "#c87840");
      break;
    case "tuxedo":
      // 胸前白色「围兜」+ 鼻梁白线（典型 tuxedo 标志）
      fill(ctx, ox + 8, oy + 7, 4, 5, pal.stripe ?? "#f0ece4");
      fill(ctx, ox + 9, oy + 6, 2, 1, pal.stripe ?? "#f0ece4");
      // 围兜延伸到胸前
      fill(ctx, ox + 8, oy + 13, 5, 5, pal.stripe ?? "#f0ece4");
      // 4 只白爪
      fill(ctx, ox + 5, oy + 22, 2, 4, pal.stripe ?? "#f0ece4");
      fill(ctx, ox + 14, oy + 22, 2, 4, pal.stripe ?? "#f0ece4");
      break;
    case "siamese":
      // 重点色：脸/耳/腿/尾深色（colorpoint）
      fill(ctx, ox + 5, oy + 3, 11, 4, pal.mask ?? "#4a3828");
      fill(ctx, ox + 6, oy + 5, 2, 2, pal.body); // 留眼睛位
      fill(ctx, ox + 13, oy + 5, 2, 2, pal.body);
      fill(ctx, ox + 4, oy + 22, 2, 4, pal.mask ?? "#4a3828"); // 前腿
      fill(ctx, ox + 15, oy + 22, 2, 4, pal.mask ?? "#4a3828");
      break;
    case "british":
      // 短毛圆脸：腮部加深色阴影
      fill(ctx, ox + 4, oy + 9, 2, 2, pal.bodyDark);
      fill(ctx, ox + 15, oy + 9, 2, 2, pal.bodyDark);
      // 蓝灰体色细节
      fill(ctx, ox + 9, oy + 17, 2, 2, pal.bodyDark);
      break;
    case "white":
      // 白猫加点粉色腮红
      fill(ctx, ox + 5, oy + 9, 1, 1, "#fce7f3");
      fill(ctx, ox + 15, oy + 9, 1, 1, "#fce7f3");
      break;
    case "black":
      // 全黑猫加额头反光
      fill(ctx, ox + 9, oy + 4, 2, 1, pal.belly);
      break;
    case "ginger":
      // 橘猫常见的颈环深色 + 头部细条纹
      fill(ctx, ox + 6, oy + 3, 1, 1, pal.bodyDark);
      fill(ctx, ox + 10, oy + 3, 1, 1, pal.bodyDark);
      fill(ctx, ox + 13, oy + 3, 1, 1, pal.bodyDark);
      // 腹环
      fill(ctx, ox + 7, oy + 18, 5, 1, pal.bodyDark);
      break;
  }
}

/**
 * 画眼睛 —— 3×3 像素艺术的「迪士尼式猫眼」：
 *   [W][I][W]      W = 白色眼白
 *   [W][I][I]      I = 虹膜（pal.eye）
 *   [W][P][I]      P = 黑色瞳孔（让眼睛"有神"的关键）
 * 左上角再点 1 颗白高光 → 整张脸瞬间活过来。
 *
 * 锚点 (cx, cy) 仍是眼睛"左上角"（向后兼容旧调用），但实际绘制范围是 (cx-1..cx+1, cy..cy+2)。
 */
function drawEye(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  pal: CatPalette,
  mood: EyeMood
) {
  const eyeWhite = "#fbf7eb";
  const pupil = "#0a0a0f";
  const highlight = "#ffffff";

  switch (mood) {
    case "open":
      // 3×3 眼白底
      fill(ctx, cx - 1, cy, 3, 3, eyeWhite);
      // 虹膜：竖向 1×3 居中（猫式椭圆瞳孔轮廓）
      fill(ctx, cx, cy, 2, 3, pal.eye);
      // 黑瞳：1×2 居中偏下
      fill(ctx, cx, cy + 1, 1, 2, pupil);
      // 高光：左上 1×1
      fill(ctx, cx - 1, cy, 1, 1, highlight);
      break;

    case "narrow":
      // 工作中：眯眼，但仍有虹膜+黑瞳"在看"（不是空白条）
      fill(ctx, cx - 1, cy + 1, 3, 1, eyeWhite);
      fill(ctx, cx, cy + 1, 2, 1, pal.eye);
      fill(ctx, cx, cy + 1, 1, 1, pupil);
      break;

    case "happyCurve":
      // 弯月眼 ^^（开心的猫）
      fill(ctx, cx - 1, cy + 1, 1, 1, pal.bodyDark);
      fill(ctx, cx, cy, 1, 1, pal.bodyDark);
      fill(ctx, cx + 1, cy + 1, 1, 1, pal.bodyDark);
      // 一抹脸颊高光
      fill(ctx, cx, cy + 1, 1, 1, pal.bodyDark);
      break;

    case "starry":
      // 星星眼：4 角点缀 + 中心金色 + 黑瞳
      fill(ctx, cx - 1, cy, 3, 3, eyeWhite);
      fill(ctx, cx, cy, 2, 3, "#fbbf24"); // 金色虹膜
      fill(ctx, cx, cy + 1, 1, 1, pupil); // 黑瞳
      fill(ctx, cx - 1, cy, 1, 1, highlight);
      fill(ctx, cx + 1, cy + 2, 1, 1, "#fef3c7"); // 右下亮点
      break;

    case "closedX":
      // 失败：>< 眼
      fill(ctx, cx - 1, cy, 1, 1, pal.bodyDark);
      fill(ctx, cx, cy + 1, 1, 1, pal.bodyDark);
      fill(ctx, cx + 1, cy, 1, 1, pal.bodyDark);
      fill(ctx, cx - 1, cy + 2, 1, 1, pal.bodyDark);
      fill(ctx, cx + 1, cy + 2, 1, 1, pal.bodyDark);
      break;

    case "wideEmpty":
      // 空结果：大圆瞪眼（白多瞳小）
      fill(ctx, cx - 1, cy - 1, 3, 3, eyeWhite);
      fill(ctx, cx, cy, 1, 1, pupil);
      fill(ctx, cx - 1, cy - 1, 1, 1, highlight);
      break;
  }
}

/** 画嘴巴（W 形 / 平 / 蹙眉 / O） */
function drawMouth(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  pal: CatPalette,
  mood: MouthMood
) {
  switch (mood) {
    case "smile":
      // W 形小嘴（猫嘴标志）
      fill(ctx, cx - 1, cy, 1, 1, pal.bodyDark);
      fill(ctx, cx, cy + 1, 1, 1, pal.bodyDark);
      fill(ctx, cx + 1, cy, 1, 1, pal.bodyDark);
      break;
    case "neutral":
      fill(ctx, cx, cy + 1, 1, 1, pal.bodyDark);
      break;
    case "frown":
      fill(ctx, cx - 1, cy + 1, 1, 1, pal.bodyDark);
      fill(ctx, cx, cy, 1, 1, pal.bodyDark);
      fill(ctx, cx + 1, cy + 1, 1, 1, pal.bodyDark);
      break;
    case "openO":
      fill(ctx, cx, cy, 1, 2, "#3a2418");
      break;
  }
}

/** 画胡须（脸两侧 3 根） */
function drawWhiskers(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  pal: CatPalette
) {
  const whisker = pal.bodyDark;
  // 左侧
  fill(ctx, ox + 1, oy + 8, 2, 1, whisker);
  fill(ctx, ox + 0, oy + 9, 2, 1, whisker);
  fill(ctx, ox + 1, oy + 10, 2, 1, whisker);
  // 右侧
  fill(ctx, ox + 18, oy + 8, 2, 1, whisker);
  fill(ctx, ox + 19, oy + 9, 2, 1, whisker);
  fill(ctx, ox + 18, oy + 10, 2, 1, whisker);
}

/**
 * 重写猫咪绘制 V2：22x30 sprite rect 内，眼睛/胡须/品种/动作全套精修。
 * 通用结构：
 *   rows 0-2   ears (triangles)
 *   rows 2-12  head (16 wide @ col 3-18) + eyes (rows 7-8) + nose/mouth (rows 9-11)
 *   rows 8-11  whiskers (extend left/right of face)
 *   rows 12-22 body block (18 wide @ col 2-19) + belly highlight
 *   rows 22-27 legs (4 visible)
 *   rows 14-26 tail (col 0-3 or 19-22, pose-dependent)
 */
function drawCatPixels(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  breed: CatBreed,
  pal: CatPalette,
  pose: CatPose,
  _frame: number,
  _hd: boolean
) {
  const bodyY = 13;
  const bodyW = 16; // cols 3..18
  const bodyH = 10; // rows 13..22

  // === Tail (画在最底层 so body 覆盖根部) ===
  let tailCol = 1;
  let tailRows = [16, 17, 18, 19, 20];
  if (pose === "walk1") {
    tailCol = 0;
    tailRows = [14, 15, 16, 17, 18];
  } else if (pose === "walk2") {
    tailCol = 2;
    tailRows = [15, 16, 17, 18, 19];
  } else if (pose === "success") {
    tailCol = 0;
    tailRows = [13, 14, 15, 16];
  } else if (pose === "fail") {
    tailCol = 1;
    tailRows = [20, 21, 22, 23];
  }
  for (const ty of tailRows) {
    fill(ctx, ox + tailCol, oy + ty, 2, 1, pal.body);
    fill(ctx, ox + tailCol + 1, oy + ty + 1, 1, 1, pal.bodyDark);
  }
  // 尾巴尖
  fill(ctx, ox + tailCol, oy + tailRows[tailRows.length - 1]! + 1, 1, 1, pal.bodyDark);

  // === Body block (V2: 肩部内收，与圆脸过渡更自然) ===
  // 肩膀行 row 13 内收 1 列两侧 → 不再是矩形断面
  fill(ctx, ox + 4, oy + bodyY, bodyW - 2, 1, pal.body);
  // 身体主体 row 14..22 (9 rows, 16 wide)
  fill(ctx, ox + 3, oy + bodyY + 1, bodyW, bodyH - 1, pal.body);
  // 腹部高光（梯形）
  fill(ctx, ox + 5, oy + bodyY + 3, bodyW - 4, bodyH - 5, pal.belly);
  fill(ctx, ox + 6, oy + bodyY + bodyH - 2, bodyW - 6, 1, pal.belly);

  // === Head V2 圆脸（阶梯切角实现近似圆形轮廓） ===
  // row 2 头顶 12w（最窄）
  fill(ctx, ox + 5, oy + 2, 12, 1, pal.body);
  // row 3 14w
  fill(ctx, ox + 4, oy + 3, 14, 1, pal.body);
  // row 4..10 主体 16w (7 rows)
  fill(ctx, ox + 3, oy + 4, 16, 7, pal.body);
  // row 11 14w（脸颊收）
  fill(ctx, ox + 4, oy + 11, 14, 1, pal.body);
  // row 12 下颌 12w（最窄）
  fill(ctx, ox + 5, oy + 12, 12, 1, pal.body);

  // 脸颊圆鼓阴影：左右各 1px 深色（让平面感升为立体感）
  fill(ctx, ox + 3, oy + 8, 1, 2, pal.bodyDark);
  fill(ctx, ox + 18, oy + 8, 1, 2, pal.bodyDark);
  // 下巴轻阴影
  fill(ctx, ox + 7, oy + 12, 8, 1, pal.bodyDark);

  // === Ears (与圆脸耳根衔接) ===
  // 左耳：尖在 col 2 row 0，根延伸到 col 5 接 head row 2 (12w 起点)
  fill(ctx, ox + 2, oy + 0, 1, 1, pal.body);
  fill(ctx, ox + 2, oy + 1, 2, 1, pal.body);
  fill(ctx, ox + 3, oy + 2, 3, 1, pal.body); // 3w 耳根，与 head row 2 col 5 重叠 1px
  fill(ctx, ox + 3, oy + 1, 1, 1, pal.ear); // 内耳粉色
  // 右耳：镜像
  fill(ctx, ox + 19, oy + 0, 1, 1, pal.body);
  fill(ctx, ox + 18, oy + 1, 2, 1, pal.body);
  fill(ctx, ox + 16, oy + 2, 3, 1, pal.body);
  fill(ctx, ox + 18, oy + 1, 1, 1, pal.ear);

  // === 品种花纹（在 base body 之上） ===
  drawBreedMarkings(fill, ctx, ox, oy, breed, pal);

  // === 脚 (4 只) — 走路时左右交替前迈 ===
  const legY = oy + 22;
  const legColor = pal.bodyDark;
  if (pose === "walk1") {
    // 左前 + 右后
    fill(ctx, ox + 5, legY, 2, 4, legColor);
    fill(ctx, ox + 5, legY + 4, 3, 1, legColor); // 脚掌
    fill(ctx, ox + 9, legY + 2, 2, 3, legColor);
    fill(ctx, ox + 13, legY, 2, 4, legColor);
    fill(ctx, ox + 13, legY + 4, 3, 1, legColor);
    fill(ctx, ox + 16, legY + 2, 2, 3, legColor);
  } else if (pose === "walk2") {
    // 右前 + 左后
    fill(ctx, ox + 6, legY + 2, 2, 3, legColor);
    fill(ctx, ox + 9, legY, 2, 4, legColor);
    fill(ctx, ox + 9, legY + 4, 3, 1, legColor);
    fill(ctx, ox + 13, legY + 2, 2, 3, legColor);
    fill(ctx, ox + 15, legY, 2, 4, legColor);
    fill(ctx, ox + 15, legY + 4, 3, 1, legColor);
  } else {
    // 站立：4 只对称
    fill(ctx, ox + 5, legY, 2, 4, legColor);
    fill(ctx, ox + 5, legY + 4, 3, 1, legColor);
    fill(ctx, ox + 9, legY, 2, 4, legColor);
    fill(ctx, ox + 9, legY + 4, 3, 1, legColor);
    fill(ctx, ox + 12, legY, 2, 4, legColor);
    fill(ctx, ox + 12, legY + 4, 3, 1, legColor);
    fill(ctx, ox + 15, legY, 2, 4, legColor);
    fill(ctx, ox + 15, legY + 4, 3, 1, legColor);
  }

  // === 表情：眼+鼻+嘴+胡须 ===
  let leftEye: EyeMood = "open";
  let rightEye: EyeMood = "open";
  let mouth: MouthMood = "smile";
  let showWhiskers = true;
  switch (pose) {
    case "work":
      leftEye = "narrow";
      rightEye = "narrow";
      mouth = "neutral";
      break;
    case "success":
      leftEye = "starry";
      rightEye = "starry";
      mouth = "smile";
      break;
    case "fail":
      leftEye = "closedX";
      rightEye = "closedX";
      mouth = "frown";
      showWhiskers = false;
      break;
    case "empty":
      leftEye = "wideEmpty";
      rightEye = "wideEmpty";
      mouth = "openO";
      break;
    case "walk1":
    case "walk2":
      mouth = "smile";
      break;
    case "idle":
    default:
      mouth = "smile";
      break;
  }
  drawEye(fill, ctx, ox + 5, oy + 7, pal, leftEye);
  drawEye(fill, ctx, ox + 14, oy + 7, pal, rightEye);
  // 鼻子（粉色三角）
  fill(ctx, ox + 10, oy + 9, 2, 1, pal.nose);
  fill(ctx, ox + 10, oy + 10, 1, 1, pal.nose);
  // 嘴巴
  drawMouth(fill, ctx, ox + 10, oy + 10, pal, mouth);
  // 胡须
  if (showWhiskers) drawWhiskers(fill, ctx, ox, oy, pal);

  // === Pose-specific 装饰叠加 ===
  if (pose === "work") {
    // 前爪伸前（在键盘上）
    fill(ctx, ox + 6, oy + 21, 2, 2, pal.bodyDark);
    fill(ctx, ox + 14, oy + 21, 2, 2, pal.bodyDark);
    // 头顶汗滴（专注思考）
    fill(ctx, ox + 16, oy + 4, 1, 2, "#7dd3fc");
  } else if (pose === "success") {
    // 头顶 ✨
    fill(ctx, ox + 0, oy + 4, 1, 1, "#fbbf24");
    fill(ctx, ox + 1, oy + 3, 1, 1, "#ffffff");
    fill(ctx, ox + 0, oy + 2, 1, 1, "#fbbf24");
    fill(ctx, ox + 20, oy + 5, 1, 1, "#fbbf24");
    fill(ctx, ox + 21, oy + 4, 1, 1, "#ffffff");
    // 脸颊红晕
    fill(ctx, ox + 4, oy + 9, 1, 1, "#f0a8b0");
    fill(ctx, ox + 17, oy + 9, 1, 1, "#f0a8b0");
  } else if (pose === "fail") {
    // 头顶汗滴
    fill(ctx, ox + 19, oy + 2, 1, 1, "#60a5fa");
    fill(ctx, ox + 19, oy + 3, 2, 2, "#60a5fa");
    fill(ctx, ox + 20, oy + 5, 1, 1, "#60a5fa");
    // 沮丧线
    fill(ctx, ox + 8, oy + 2, 1, 1, pal.bodyDark);
    fill(ctx, ox + 11, oy + 2, 1, 1, pal.bodyDark);
    fill(ctx, ox + 13, oy + 2, 1, 1, pal.bodyDark);
  } else if (pose === "empty") {
    // 头顶 ？
    fill(ctx, ox + 18, oy + 1, 3, 1, "#fbbf24");
    fill(ctx, ox + 20, oy + 2, 1, 2, "#fbbf24");
    fill(ctx, ox + 19, oy + 3, 1, 1, "#fbbf24");
    fill(ctx, ox + 19, oy + 5, 1, 1, "#fbbf24");
  } else if (pose === "idle") {
    // 偶尔眨眼？这里不动态，但身体微微偏（已在 walk pose 处理动效）
  }
}

function drawDeskSprite(
  fill: ReturnType<typeof makeFill>,
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  hd: boolean
) {
  const dw = hd ? 56 : 40;
  const surfaceTop = hd ? 3 : 2;
  const surfaceH = hd ? 4 : 3;
  const apronTop = surfaceTop + surfaceH;
  const apronH = hd ? 6 : 5;
  const legTop = apronTop + apronH;
  const legBottom = hd ? 28 : 23;
  const legH = legBottom - legTop;
  const legW = hd ? 5 : 4;
  fill(ctx, ox, oy + surfaceTop, dw, surfaceH, "#5a3e28");
  fill(ctx, ox + 1, oy + surfaceTop, dw - 2, 1, "#8b6a4a");
  fill(ctx, ox + 2, oy + apronTop, dw - 4, apronH, "#6a4a32");
  fill(ctx, ox + 3, oy + legTop, legW, legH, "#3a3a42");
  fill(ctx, ox + dw - 3 - legW, oy + legTop, legW, legH, "#3a3a42");
  fill(ctx, ox + 2, oy + legBottom, dw - 4, 1, "rgba(0,0,0,0.35)");
}

function drawRackSprite(fill: ReturnType<typeof makeFill>, ctx: CanvasRenderingContext2D, ox: number, oy: number, hd: boolean) {
  const rw = hd ? 36 : 28;
  const rh = hd ? 46 : 36;
  fill(ctx, ox, oy, rw, rh, "#0f172a");
  fill(ctx, ox + 2, oy + 2, rw - 4, rh - 4, "#1e293b");
  for (let i = 0; i < 5; i++) {
    fill(ctx, ox + 4, oy + 4 + i * 8, rw - 8, 5, "#334155");
    fill(ctx, ox + 6, oy + 5 + i * 8, 3, 2, i % 2 === 0 ? "#22c55e" : "#38bdf8");
  }
}

function drawShelfSprite(fill: ReturnType<typeof makeFill>, ctx: CanvasRenderingContext2D, ox: number, oy: number, hd: boolean) {
  const sw = hd ? 34 : 26;
  const sh = hd ? 44 : 34;
  fill(ctx, ox, oy, sw, sh, "#5c4030");
  for (let i = 0; i < 4; i++) {
    const row = 3 + i * (hd ? 10 : 8);
    fill(ctx, ox + 2, oy + row, sw - 4, 2, "#6d5040");
    fill(ctx, ox + 4, oy + row + 2, 5, 5, i % 2 ? "#fbbf24" : "#f59e0b");
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
  const dx = x - (rect.w * scale) / 2;
  const dy = y - rect.h * scale - 4;
  blitSprite(ctx, atlas, rect, dx, dy, scale);

  // === 运行时动态叠加：增强生气 ===
  ctx.save();
  ctx.imageSmoothingEnabled = false;

  if (mode === "sandbox") {
    // 闪烁光标（命令行）
    const blink = Math.floor(now / 480) % 2;
    if (blink) {
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(dx + 12 * scale, dy + 13 * scale, 1 * scale, 1 * scale);
    }
  } else if (mode === "code") {
    // 滑动闪烁字符（模拟打字）
    const phase = Math.floor(now / 220) % 8;
    ctx.fillStyle = "rgba(74, 222, 128, 0.55)";
    ctx.fillRect(dx + (5 + phase * 2) * scale, dy + 18 * scale, 1 * scale, 1 * scale);
    // 边缘 bloom
    const bloomPulse = 0.45 + Math.sin(now / 380) * 0.15;
    ctx.fillStyle = `rgba(74, 222, 128, ${0.15 * bloomPulse})`;
    ctx.fillRect(dx - 4, dy - 4, rect.w * scale + 8, rect.h * scale + 8);
  } else if (mode === "chat") {
    // 滚动消息条 + 输入指示
    const t = (now / 600) % 1;
    ctx.fillStyle = "rgba(125, 211, 252, 0.6)";
    ctx.fillRect(dx + 3 * scale, dy + (7 + t * 14) * scale, 2 * scale, 1 * scale);
    // 输入中点
    const dotPhase = Math.floor(now / 280) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === dotPhase ? "#7dd3fc" : "rgba(125, 211, 252, 0.35)";
      ctx.fillRect(dx + (6 + i * 3) * scale, dy + 25 * scale, 2 * scale, 1 * scale);
    }
  } else if (mode === "mcp") {
    // 节点脉冲（径向呼吸）
    const pulse = 0.55 + Math.sin(now / 320) * 0.45;
    ctx.fillStyle = `rgba(74, 222, 128, ${0.35 * pulse})`;
    ctx.beginPath();
    ctx.arc(dx + Math.floor(rect.w / 2) * scale + scale, dy + 15 * scale, 3 * scale, 0, Math.PI * 2);
    ctx.fill();
  } else if (mode === "skill") {
    // 书页高光（缓慢扫光）
    const sweep = (now / 1400) % 1;
    ctx.fillStyle = "rgba(254, 243, 199, 0.35)";
    ctx.fillRect(dx + (4 + sweep * 28) * scale, dy + 6 * scale, 2 * scale, (rect.h - 14) * scale);
  } else if (mode === "ok") {
    // 庆祝粒子闪烁（小金点）
    const phase = Math.floor(now / 200) % 4;
    ctx.fillStyle = "#fde68a";
    for (let i = 0; i < 3; i++) {
      const seed = (i + phase) % 4;
      ctx.fillRect(dx + (6 + seed * 8) * scale, dy + (8 + i * 2) * scale, 1 * scale, 1 * scale);
    }
  } else if (mode === "err") {
    // 红色警告外晕（缓慢呼吸）
    const pulse = 0.4 + Math.sin(now / 220) * 0.3;
    ctx.fillStyle = `rgba(248, 113, 113, ${0.18 * pulse})`;
    ctx.fillRect(dx - 6, dy - 6, rect.w * scale + 12, rect.h * scale + 12);
  } else if (mode === "empty") {
    // 问号缓慢闪烁
    const blink = (Math.sin(now / 400) + 1) / 2;
    ctx.fillStyle = `rgba(251, 191, 36, ${0.18 + blink * 0.25})`;
    ctx.fillRect(dx - 2, dy - 2, rect.w * scale + 4, rect.h * scale + 4);
  } else if (mode === "idle") {
    // 待机：屏幕极弱呼吸（电源指示）
    const pulse = 0.5 + Math.sin(now / 1200) * 0.5;
    ctx.fillStyle = `rgba(34, 197, 94, ${0.3 + pulse * 0.5})`;
    ctx.fillRect(dx + 3 * scale, dy + 2 * scale, 1 * scale, 1 * scale);
  }

  ctx.restore();
}
