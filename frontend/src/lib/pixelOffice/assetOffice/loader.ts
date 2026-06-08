import type { AssetBundleId, AssetBundleManifest, LoadedAssetBundle } from "./types";
import { getAssetBundleManifest } from "./bundles";

const cache = new Map<string, LoadedAssetBundle>();
const inflight = new Map<string, Promise<LoadedAssetBundle>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

export async function loadAssetBundle(id: AssetBundleId): Promise<LoadedAssetBundle> {
  const cached = cache.get(id);
  if (cached) return cached;
  const existing = inflight.get(id);
  if (existing) return existing;

  const manifest = getAssetBundleManifest(id);
  const promise = (async () => {
    const [sceneBg, props, ...catSheets] = await Promise.all([
      loadImage(manifest.sceneBgUrl),
      loadImage(manifest.props.url),
      ...manifest.cats.sheets.map((s) => loadImage(s.url)),
    ]);
    const bundle: LoadedAssetBundle = {
      manifest,
      sceneBg,
      catSheets,
      props,
      loaded: true,
    };
    cache.set(id, bundle);
    inflight.delete(id);
    return bundle;
  })();

  inflight.set(id, promise);
  return promise;
}

export function getLoadedAssetBundle(id: AssetBundleId): LoadedAssetBundle | null {
  return cache.get(id) ?? null;
}

export function invalidateAssetBundleCache(id?: AssetBundleId): void {
  if (id) {
    cache.delete(id);
    inflight.delete(id);
    return;
  }
  cache.clear();
  inflight.clear();
}

export function preloadAssetBundle(id: AssetBundleId): void {
  void loadAssetBundle(id).catch((err) => {
    console.error(`[assetOffice] failed to load bundle ${id}:`, err);
  });
}

export type { AssetBundleManifest };
