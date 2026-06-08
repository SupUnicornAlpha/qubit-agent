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

export const flatCoolManifest: AssetBundleManifest = {
  id: "flat_cool",
  label: "扁平酷感",
  sceneBgUrl,
  cats: {
    sheets: [
      {
        url: catsAUrl,
        breeds: ["white", "british", "ginger", "tabby"],
        frames: catsAFrames,
      },
      {
        url: catsBUrl,
        breeds: ["siamese", "calico", "tuxedo", "black"],
        frames: catsBFrames,
      },
    ],
    poses: ["idle", "walk1", "walk2", "work", "success", "fail", "empty"],
  },
  props: {
    url: propsUrl,
    frames: propsFrames,
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
    catScaleBase: 0.46,
    deskScaleBase: 0.14,
    monitorScaleBase: 0.1,
    shelfScaleBase: 0.3,
    rackScaleBase: 0.3,
  },
};
