import catsAUrl from "./cats-a.png";
import catsBUrl from "./cats-b.png";
import propsUrl from "./props.png";
import sceneBgUrl from "./scene-bg.png";
import type { AssetBundleManifest } from "../../../../lib/pixelOffice/assetOffice/types";

/** 1536×1024 网格：7 列 pose × 4 行品种 */
const CAT_COLS = 7;
const CAT_ROWS = 4;
const CAT_CELL_W = Math.floor(1536 / CAT_COLS);
const CAT_CELL_H = Math.floor(1024 / CAT_ROWS);

const PROPS_COLS = 4;
const PROPS_ROWS = 4;
const PROP_CELL_W = Math.floor(1536 / PROPS_COLS);
const PROP_CELL_H = Math.floor(1024 / PROPS_ROWS);

function propFrame(col: number, row: number) {
  return { x: col * PROP_CELL_W, y: row * PROP_CELL_H, w: PROP_CELL_W, h: PROP_CELL_H };
}

export const comicBcManifest: AssetBundleManifest = {
  id: "comic_bc",
  label: "漫画办公室",
  sceneBgUrl,
  cats: {
    sheets: [
      { url: catsAUrl, breeds: ["tabby", "black", "calico", "siamese"] },
      { url: catsBUrl, breeds: ["white", "british", "ginger", "tuxedo"] },
    ],
    cols: CAT_COLS,
    rows: CAT_ROWS,
    cellW: CAT_CELL_W,
    cellH: CAT_CELL_H,
    poses: ["idle", "walk1", "walk2", "work", "success", "fail", "empty"],
  },
  props: {
    url: propsUrl,
    frames: {
      desk: propFrame(0, 0),
      monitor_idle: propFrame(1, 0),
      monitor_chat: propFrame(2, 0),
      monitor_code: propFrame(3, 0),
      monitor_mcp: propFrame(0, 1),
      monitor_skill: propFrame(1, 1),
      monitor_sandbox: propFrame(2, 1),
      monitor_ok: propFrame(3, 1),
      monitor_err: propFrame(0, 2),
      monitor_empty: propFrame(1, 2),
      bookshelf: propFrame(2, 2),
      rack: propFrame(3, 2),
      plant: propFrame(0, 3),
    },
    monitorByScreenMode: {
      idle: "monitor_idle",
      chat: "monitor_chat",
      code: "monitor_code",
      mcp: "monitor_mcp",
      skill: "monitor_skill",
      sandbox: "monitor_sandbox",
      ok: "monitor_ok",
      err: "monitor_err",
      empty: "monitor_empty",
    },
  },
  render: {
    catScaleBase: 0.32,
    deskScaleBase: 0.22,
    monitorScaleBase: 0.18,
    shelfScaleBase: 0.2,
    rackScaleBase: 0.2,
  },
};
