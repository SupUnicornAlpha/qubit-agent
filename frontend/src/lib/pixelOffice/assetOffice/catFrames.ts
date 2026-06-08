import type { CatAction, CatBreed } from "../types";
import type { CatPoseName, FrameRect, LoadedAssetBundle } from "./types";

export function catPoseForAction(action: CatAction, frame: number): CatPoseName {
  if (action === "walk") return frame % 2 === 0 ? "walk1" : "walk2";
  if (action === "success") return "success";
  if (action === "fail") return "fail";
  if (action === "success_empty") return "empty";
  if (
    action === "tool" ||
    action === "mcp" ||
    action === "skill" ||
    action === "sandbox" ||
    action === "builtin" ||
    action === "at_rack" ||
    action === "at_shelf" ||
    action === "chat_send" ||
    action === "chat_recv"
  ) {
    return "work";
  }
  return "idle";
}

/**
 * Resolve the precise (image, frame) for a given (breed, pose) using the
 * frames.json built by `scripts/build-pixel-office-v2.ts`.
 *
 * Falls back to `idle` if the requested pose key is missing for that breed,
 * which keeps rendering robust if a sheet is partially populated.
 */
export function resolveCatFrame(
  bundle: LoadedAssetBundle,
  breed: CatBreed,
  pose: CatPoseName,
): { image: HTMLImageElement; frame: FrameRect } | null {
  const { cats } = bundle.manifest;
  for (let si = 0; si < cats.sheets.length; si++) {
    const sheet = cats.sheets[si]!;
    if (sheet.breeds.indexOf(breed) < 0) continue;
    const image = bundle.catSheets[si];
    if (!image) return null;
    const key = `${breed}_${pose}`;
    const frame = sheet.frames[key] ?? sheet.frames[`${breed}_idle`];
    if (!frame) return null;
    return { image, frame };
  }
  return null;
}
