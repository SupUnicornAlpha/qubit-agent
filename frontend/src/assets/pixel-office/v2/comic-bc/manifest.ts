import catsAUrl from "./cats-a.alpha.png";
import catsBUrl from "./cats-b.alpha.png";
import propsUrl from "./props.alpha.png";
import sceneBgUrl from "./scene-bg.png";
import catsAFramesRaw from "./cats-a.frames.json";
import catsBFramesRaw from "./cats-b.frames.json";
import propsFramesRaw from "./props.frames.json";
import type {
  AssetBundleManifest,
  FrameRect,
} from "../../../../lib/pixelOffice/assetOffice/types";

const catsAFrames = catsAFramesRaw as Readonly<Record<string, FrameRect>>;
const catsBFrames = catsBFramesRaw as Readonly<Record<string, FrameRect>>;
const propsFrames = propsFramesRaw as Readonly<Record<string, FrameRect>>;

export const comicBcManifest: AssetBundleManifest = {
  id: "comic_bc",
  label: "漫画办公室",
  sceneBgUrl,
  cats: {
    sheets: [
      {
        url: catsAUrl,
        breeds: ["tabby", "black", "calico", "siamese"],
        frames: catsAFrames,
      },
      {
        url: catsBUrl,
        breeds: ["white", "british", "ginger", "tuxedo"],
        frames: catsBFrames,
      },
    ],
    poses: ["idle", "walk1", "walk2", "work", "success", "fail", "empty"],
  },
  props: {
    url: propsUrl,
    frames: propsFrames,
    /**
     * Props sheet only ships 5 monitor states (idle / chat / code / ok / err).
     * Other CatAction screen modes fall back to the closest semantic match.
     */
    monitorByScreenMode: {
      idle: "monitor_idle",
      chat: "monitor_chat",
      code: "monitor_code",
      mcp: "monitor_chat",
      skill: "monitor_code",
      sandbox: "monitor_code",
      ok: "monitor_ok",
      err: "monitor_err",
      empty: "monitor_idle",
    },
  },
  render: {
    catScaleBase: 0.48,
    deskScaleBase: 0.15,
    monitorScaleBase: 0.11,
    shelfScaleBase: 0.32,
    rackScaleBase: 0.32,
  },
};
