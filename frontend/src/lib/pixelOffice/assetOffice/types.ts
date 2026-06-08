import type { CatBreed, ScreenMode } from "../types";

export type FrameRect = { x: number; y: number; w: number; h: number };

export type CatPoseName = "idle" | "walk1" | "walk2" | "work" | "success" | "fail" | "empty";

export type AssetBundleId = "comic_bc" | "flat_cool";

export type AssetBundleManifest = {
  id: AssetBundleId;
  label: string;
  sceneBgUrl: string;
  cats: {
    sheets: ReadonlyArray<{ url: string; breeds: readonly CatBreed[] }>;
    cols: number;
    rows: number;
    cellW: number;
    cellH: number;
    poses: readonly CatPoseName[];
  };
  props: {
    url: string;
    frames: Record<string, FrameRect>;
    monitorByScreenMode: Record<ScreenMode, string>;
  };
  render: {
    catScaleBase: number;
    deskScaleBase: number;
    monitorScaleBase: number;
    shelfScaleBase: number;
    rackScaleBase: number;
  };
};

export type LoadedAssetBundle = {
  manifest: AssetBundleManifest;
  sceneBg: HTMLImageElement;
  catSheets: HTMLImageElement[];
  props: HTMLImageElement;
  loaded: true;
};
