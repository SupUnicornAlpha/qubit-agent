import { comicBcManifest } from "../../../assets/pixel-office/v2/comic-bc/manifest";
import { flatCoolManifest } from "../../../assets/pixel-office/v2/flat-cool/manifest";
import type { AssetBundleId, AssetBundleManifest } from "./types";

const REGISTRY: Record<AssetBundleId, AssetBundleManifest> = {
  comic_bc: comicBcManifest,
  flat_cool: flatCoolManifest,
};

export function getAssetBundleManifest(id: AssetBundleId): AssetBundleManifest {
  return REGISTRY[id];
}

export function isAssetBundleId(id: string): id is AssetBundleId {
  return id === "comic_bc" || id === "flat_cool";
}

export function listAssetBundleManifests(): AssetBundleManifest[] {
  return Object.values(REGISTRY);
}
