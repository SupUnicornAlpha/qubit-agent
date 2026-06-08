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

export function resolveCatFrame(
  bundle: LoadedAssetBundle,
  breed: CatBreed,
  pose: CatPoseName
): { image: HTMLImageElement; frame: FrameRect } | null {
  const { cats } = bundle.manifest;
  const poseCol = cats.poses.indexOf(pose);
  if (poseCol < 0) return null;

  for (let si = 0; si < cats.sheets.length; si++) {
    const sheet = cats.sheets[si]!;
    const row = sheet.breeds.indexOf(breed);
    if (row < 0) continue;
    const image = bundle.catSheets[si];
    if (!image) return null;
    return {
      image,
      frame: {
        x: poseCol * cats.cellW,
        y: row * cats.cellH,
        w: cats.cellW,
        h: cats.cellH,
      },
    };
  }
  return null;
}
