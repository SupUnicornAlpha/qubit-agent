/**
 * 把现有 spriteAtlas 中的猫咪帧注册到 Phaser Texture，作为 8 breeds × 7 poses 的 Atlas。
 *
 * 帧命名约定：`cat_${breed}_${pose}`，例如 `cat_tabby_walk1`、`cat_ginger_idle`。
 * 动画命名：`cat_${breed}_idle|walk|work|success|fail|empty`。
 */
import type Phaser from "phaser";
import { getRenderConfig } from "./config";
import { getSpriteAtlas, type AtlasSprites } from "./spriteAtlas";
import type { CatAction, CatBreed } from "./types";

type SceneWithBuildTag = Phaser.Scene & {
  [CAT_ATLAS_BUILD_KEY]?: number;
};

const BREEDS: readonly CatBreed[] = [
  "tabby",
  "black",
  "white",
  "calico",
  "siamese",
  "british",
  "tuxedo",
  "ginger",
];

const POSES = ["idle", "walk1", "walk2", "work", "success", "fail", "empty"] as const;
type Pose = (typeof POSES)[number];

export const CAT_ATLAS_KEY = "qb-cat-atlas";
export const CAT_ATLAS_BUILD_KEY = "qb-cat-atlas-build";

function poseRect(atlas: AtlasSprites, breed: CatBreed, pose: Pose) {
  switch (pose) {
    case "idle":
      return atlas.catIdle[breed];
    case "walk1":
      return atlas.catWalk1[breed];
    case "walk2":
      return atlas.catWalk2[breed];
    case "work":
      return atlas.catWork[breed];
    case "success":
      return atlas.catSuccess[breed];
    case "fail":
      return atlas.catFail[breed];
    case "empty":
      return atlas.catEmpty[breed];
  }
}

export type CatAtlasFrame = {
  key: string;
  width: number;
  height: number;
  spriteUnit: number;
};

/** 把 atlas canvas 注册为 Phaser CanvasTexture，并为每个 (breed,pose) 添加 frame；
 * 同时注册动画。重复调用安全（基于 atlasBuild key）。 */
export function ensureCatAtlasInScene(scene: Phaser.Scene): { atlas: AtlasSprites; frameW: number; frameH: number } {
  const atlas = getSpriteAtlas();
  const su = atlas.spriteUnit;
  // 用首帧（tabby idle）确定统一帧尺寸；所有猫帧大小相同
  const ref = atlas.catIdle.tabby;
  const frameW = ref.w * su;
  const frameH = ref.h * su;

  const textures = scene.textures;
  const cfg = getRenderConfig();
  const sceneTag = scene as SceneWithBuildTag;
  const lastBuild = sceneTag[CAT_ATLAS_BUILD_KEY];
  if (textures.exists(CAT_ATLAS_KEY) && lastBuild === cfg.atlasBuild) {
    return { atlas, frameW, frameH };
  }
  if (textures.exists(CAT_ATLAS_KEY)) {
    textures.remove(CAT_ATLAS_KEY);
  }
  sceneTag[CAT_ATLAS_BUILD_KEY] = cfg.atlasBuild;

  const cTex = textures.addCanvas(CAT_ATLAS_KEY, atlas.canvas);
  if (!cTex) return { atlas, frameW, frameH };

  for (const breed of BREEDS) {
    for (const pose of POSES) {
      const r = poseRect(atlas, breed, pose);
      cTex.add(
        frameName(breed, pose),
        0,
        r.x * su,
        r.y * su,
        r.w * su,
        r.h * su
      );
    }
  }

  registerCatAnimations(scene);
  return { atlas, frameW, frameH };
}

function frameName(breed: CatBreed, pose: Pose): string {
  return `cat_${breed}_${pose}`;
}

function animKey(breed: CatBreed, name: "idle" | "walk" | "work" | "success" | "fail" | "empty"): string {
  return `cat_${breed}_${name}`;
}

function registerCatAnimations(scene: Phaser.Scene) {
  for (const breed of BREEDS) {
    const create = (name: "idle" | "walk" | "work" | "success" | "fail" | "empty", frames: string[], rate: number, repeat: number) => {
      const key = animKey(breed, name);
      if (scene.anims.exists(key)) return;
      scene.anims.create({
        key,
        frames: frames.map((p) => ({ key: CAT_ATLAS_KEY, frame: `cat_${breed}_${p}` })),
        frameRate: rate,
        repeat,
      });
    };
    create("idle", ["idle"], 1, -1);
    create("walk", ["walk1", "walk2"], 8, -1);
    create("work", ["work"], 1, -1);
    create("success", ["success"], 1, -1);
    create("fail", ["fail"], 1, -1);
    create("empty", ["empty"], 1, -1);
  }
}

/** 根据 cat.action / screenMode 选择动画名 */
export function pickCatAnim(action: CatAction): "idle" | "walk" | "work" | "success" | "fail" | "empty" {
  if (action === "walk") return "walk";
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
  )
    return "work";
  return "idle";
}

export { animKey as catAnimKey, frameName as catFrameName };
