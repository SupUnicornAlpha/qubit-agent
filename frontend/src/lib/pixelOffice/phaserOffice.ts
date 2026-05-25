/**
 * Phaser 3 集成层。
 *
 * 渲染拆分：
 *   - 背景层：复用现有 Canvas 渲染管线（drawOfficeScene + drawWorkstation）输出到一张
 *     离屏 canvas，作为 Phaser 的动态 CanvasTexture。
 *   - 角色层：**Phaser.Sprite + anims** 替代「贴图绘制猫咪」。
 *     - 每只猫一个 Sprite，自动播放 idle / walk / work / success / fail / empty。
 *     - 行走走 BFS 路径，逐段用 scene.tweens.chain 跑完，避开桌子家具。
 *   - UI 层：木牌（Phaser.Text）、状态条、选中框、对话气泡 Container。
 */
import type {
  AnalystTeamGraphNode,
  AnalystTeamGraphPayload,
} from "../../api/types";
import { breedForRole } from "./catAppearance";
import { classifyInteractionKind } from "./classify";
import { mapGraphToOfficeEventsExtended } from "./eventMapper";
import { ARK_PIXEL_FAMILY, ensureArkPixelLoaded } from "./fonts";
import {
  CAT_ATLAS_KEY,
  catAnimKey,
  catFrameName,
  ensureCatAtlasInScene,
  pickCatAnim,
} from "./phaserCatAtlas";
import {
  computeOfficeLayout,
  deskHitRadius,
} from "./officeLayout";
import {
  computeOfficePerspective,
  depthAtY,
  depthScale,
} from "./officePerspective";
import {
  buildPathGrid,
  findPath,
  type PathGrid,
  type Point,
} from "./officePathfinding";
import {
  drawChatBeam,
  drawOfficeScene,
  drawParticles,
  drawWorkstation,
  screenModeForAction,
  spawnParticles,
  tickParticles,
} from "./officeRenderer";
import { getPixelOfficeRegistry } from "./runtime";
import { ensureActiveAtlasLoaded, getActiveTheme, subscribeThemeChange } from "./themes";
import {
  ACTION_MS,
  WALK_MS,
  type CatAction,
  type CatActor,
  type ChatBeam,
  type CitySkyline,
  type DeskSlot,
  type OfficeEvent,
  type Particle,
  type ScreenMode,
} from "./types";

type Phaser3 = typeof import("phaser");
type PhaserGame = import("phaser").Game;
type PhaserScene = import("phaser").Scene;
type PhaserSprite = import("phaser").GameObjects.Sprite;
type PhaserContainer = import("phaser").GameObjects.Container;

const STAGE_W = 1280;
const STAGE_H = 720;
const BG_TEXTURE_KEY = "qb-office-bg";

export type PhaserOfficeHandle = {
  destroy: () => void;
  update: (input: PhaserUpdateInput) => void;
  resize: () => void;
};

export type PhaserUpdateInput = {
  graph: AnalystTeamGraphPayload;
  nodes: AnalystTeamGraphNode[];
  city: CitySkyline;
  selectedRole: string | null;
  isRunning: boolean;
};

export type PhaserOfficeCallbacks = {
  onSelectRole: (role: string) => void;
  onClear: () => void;
};

let phaserMod: Phaser3 | null = null;

async function loadPhaser(): Promise<Phaser3> {
  if (phaserMod) return phaserMod;
  phaserMod = (await import("phaser")) as Phaser3;
  return phaserMod;
}

type CatRuntime = {
  actor: CatActor;
  sprite: PhaserSprite;
  bubble: PhaserContainer | null;
  currentAnim: string;
  walkSeq: number;
};

type PhaserRuntimeState = {
  Phaser: Phaser3;
  city: CitySkyline;
  isRunning: boolean;
  selectedRole: string | null;
  layout: ReturnType<typeof computeOfficeLayout>;
  agentNodes: AnalystTeamGraphNode[];
  cats: Map<string, CatRuntime>;
  beams: ChatBeam[];
  particles: Particle[];
  seen: Set<string>;
  pathGrid: PathGrid;
};

/** 后台层只画静态办公室 + 工位（不画猫咪），猫咪交给 Phaser Sprite */
function renderBackgroundLayer(
  off: HTMLCanvasElement,
  state: PhaserRuntimeState,
  now: number
): void {
  const ctx = off.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);

  drawOfficeScene(ctx, STAGE_W, STAGE_H, state.city, state.layout, now, state.isRunning);

  const persp = computeOfficePerspective(STAGE_W, STAGE_H, state.layout.windowH);
  // 工位按 depth 排序，便于和 Phaser sprite 的 depth 一致
  const desks: Array<[string, DeskSlot]> = [...state.layout.desks];
  desks.sort((a, b) => a[1].depth - b[1].depth);
  for (const [role, desk] of desks) {
    const cat = state.cats.get(role);
    const sel = state.selectedRole === role;
    const screenMode: ScreenMode = cat?.actor.screenMode ?? "idle";
    drawWorkstation(ctx, desk.x, desk.y, screenMode, now, false, sel, desk.depth, persp);
  }

  for (const beam of state.beams) {
    const a = state.cats.get(beam.from)?.actor;
    const b = state.cats.get(beam.to)?.actor;
    if (a && b) drawChatBeam(ctx, a.x, a.y, b.x, b.y, now, beam.until);
  }
  state.beams = state.beams.filter((b) => b.until > now);

  state.particles = tickParticles(state.particles, 16);
  drawParticles(ctx, state.particles);
}

function applyOfficeEvent(
  scene: PhaserScene,
  state: PhaserRuntimeState,
  ev: OfficeEvent,
  now: number
) {
  const { cats, layout, beams, particles } = state;
  const rt = cats.get(ev.role);
  if (!rt) return;
  const cat = rt.actor;

  if (ev.kind === "chat_send" && ev.peerRole) {
    const peerDesk = layout.desks.get(ev.peerRole);
    cat.action = "chat_send";
    cat.actionUntil = now + ACTION_MS.chat_send;
    cat.screenMode = "chat";
    if (peerDesk) cat.facing = peerDesk.x >= cat.homeX ? 1 : -1;
    beams.push({ from: ev.role, to: ev.peerRole, until: now + ACTION_MS.chat_send });
    showBubble(scene, rt, ev.label ?? "喵…", now + ACTION_MS.chat_send);
    const peer = cats.get(ev.peerRole);
    if (peer) {
      peer.actor.action = "chat_recv";
      peer.actor.actionUntil = now + ACTION_MS.chat_recv;
      peer.actor.screenMode = "chat";
      peer.actor.facing = cat.homeX >= peer.actor.homeX ? 1 : -1;
      playAnim(peer, scene);
    }
    teleportTo(rt, cat.homeX, cat.homeY);
    playAnim(rt, scene);
    return;
  }
  if (ev.kind === "chat_recv") return;

  if (ev.kind === "go_rack") {
    walkAlong(scene, state, rt, layout.rack.x, layout.rack.y + 12, "at_rack", now);
    if (ev.label) showBubble(scene, rt, ev.label, now + WALK_MS + ACTION_MS.at_rack);
    return;
  }
  if (ev.kind === "go_shelf") {
    walkAlong(scene, state, rt, layout.shelf.x, layout.shelf.y + 12, "at_shelf", now);
    if (ev.label) showBubble(scene, rt, ev.label, now + WALK_MS + ACTION_MS.at_shelf);
    return;
  }
  if (ev.kind === "at_rack" || ev.kind === "at_shelf") {
    if (cat.action === "walk") return;
    cat.action = ev.kind;
    cat.actionUntil = now + ACTION_MS[ev.kind];
    cat.screenMode = screenModeForAction(ev.kind, ev.label);
    playAnim(rt, scene);
    if (ev.label) showBubble(scene, rt, ev.label, cat.actionUntil);
    return;
  }
  if (ev.kind === "success" || ev.kind === "fail" || ev.kind === "success_empty") {
    const desk = layout.desks.get(ev.role);
    if (!desk) return;
    const dist = Math.hypot(cat.x - desk.x, cat.y - desk.y);
    if (dist > 24 && cat.action !== "walk") {
      walkAlong(scene, state, rt, desk.x, desk.y - 8, ev.kind, now);
      return;
    }
    teleportTo(rt, desk.x, desk.y - 8);
    cat.action = ev.kind;
    cat.actionUntil = now + ACTION_MS[ev.kind];
    cat.screenMode = screenModeForAction(ev.kind);
    playAnim(rt, scene);
    const pk = ev.kind === "success" ? "ok" : ev.kind === "fail" ? "err" : "empty";
    spawnParticles(particles, cat.x, cat.y - 20, pk);
    return;
  }

  teleportTo(rt, cat.homeX, cat.homeY);
  cat.action = ev.kind;
  cat.actionUntil = now + (ACTION_MS[ev.kind] || 1500);
  cat.screenMode = screenModeForAction(ev.kind, ev.label);
  playAnim(rt, scene);
  if (ev.label) showBubble(scene, rt, ev.label, cat.actionUntil);
}

function teleportTo(rt: CatRuntime, x: number, y: number) {
  rt.actor.x = x;
  rt.actor.y = y;
  rt.sprite.x = x;
  rt.sprite.y = y;
}

function playAnim(rt: CatRuntime, _scene: PhaserScene) {
  const key = catAnimKey(rt.actor.breed, pickCatAnim(rt.actor.action));
  if (rt.currentAnim !== key) {
    rt.currentAnim = key;
    rt.sprite.play(key);
  }
  rt.sprite.setFlipX(rt.actor.facing === -1);
}

/** 沿 BFS 路径走，结束后切到 onDone 状态。Tween 链替代每帧 lerp。 */
function walkAlong(
  scene: PhaserScene,
  state: PhaserRuntimeState,
  rt: CatRuntime,
  toX: number,
  toY: number,
  onDone: CatAction,
  now: number
) {
  const cat = rt.actor;
  const seq = ++rt.walkSeq;
  cat.action = "walk";
  cat.actionUntil = now + WALK_MS * 4;

  const path = findPath(state.pathGrid, { x: cat.x, y: cat.y }, { x: toX, y: toY }) ?? [
    { x: cat.x, y: cat.y },
    { x: toX, y: toY },
  ];

  scene.tweens.killTweensOf(rt.sprite);
  playAnim(rt, scene);

  const PIXELS_PER_MS = 0.6;
  const tweens = [];
  let prev: Point = path[0]!;
  for (let i = 1; i < path.length; i++) {
    const next = path[i]!;
    const dist = Math.hypot(next.x - prev.x, next.y - prev.y);
    const duration = Math.max(80, dist / PIXELS_PER_MS);
    tweens.push({
      targets: rt.sprite,
      x: next.x,
      y: next.y,
      duration,
      ease: "Linear",
      onStart: () => {
        rt.actor.facing = next.x >= prev.x ? 1 : -1;
        rt.sprite.setFlipX(rt.actor.facing === -1);
      },
      onUpdate: () => {
        rt.actor.x = rt.sprite.x;
        rt.actor.y = rt.sprite.y;
      },
    });
    prev = next;
  }

  if (tweens.length === 0) {
    finalizeWalk(rt, scene, onDone, performance.now());
    return;
  }

  scene.tweens.chain({
    tweens,
    onComplete: () => {
      if (rt.walkSeq !== seq) return;
      finalizeWalk(rt, scene, onDone, performance.now());
    },
  });
}

function finalizeWalk(rt: CatRuntime, scene: PhaserScene, next: CatAction, now: number) {
  const cat = rt.actor;
  cat.action = next;
  if (next === "at_rack" || next === "at_shelf" || next === "success" || next === "fail" || next === "success_empty") {
    cat.actionUntil = now + ACTION_MS[next];
    cat.screenMode = screenModeForAction(next);
  } else {
    cat.action = "idle";
    cat.screenMode = "idle";
    cat.actionUntil = 0;
  }
  playAnim(rt, scene);
}

function tickActorTimers(scene: PhaserScene, state: PhaserRuntimeState, now: number) {
  for (const rt of state.cats.values()) {
    const cat = rt.actor;
    if (cat.action === "walk") continue;
    if (cat.actionUntil > 0 && now > cat.actionUntil) {
      if (cat.action === "at_rack" || cat.action === "at_shelf") {
        const desk = state.layout.desks.get(cat.role);
        if (desk) walkAlong(scene, state, rt, desk.x, desk.y - 8, "idle", now);
        cat.screenMode = "idle";
      } else {
        cat.action = "idle";
        cat.screenMode = "idle";
        cat.actionUntil = 0;
        teleportTo(rt, cat.homeX, cat.homeY);
        playAnim(rt, scene);
      }
    }

    if (!state.isRunning && cat.action === "idle" && cat.actionUntil === 0) {
      if (cat.returnHomeAt && now >= cat.returnHomeAt) {
        const dist = Math.hypot(cat.x - cat.homeX, cat.y - (cat.homeY - 0));
        if (dist > 10) walkAlong(scene, state, rt, cat.homeX, cat.homeY, "idle", now);
        cat.returnHomeAt = undefined;
      } else if (!cat.returnHomeAt) {
        if (cat.nextIdleWander == null) {
          cat.nextIdleWander = now + 7000 + Math.random() * 9000;
        }
        if (now >= cat.nextIdleWander) {
          cat.nextIdleWander = now + 16000 + Math.random() * 14000;
          if (Math.random() < 0.38) {
            const dest = Math.random() < 0.5 ? state.layout.coffee : state.layout.lounge;
            walkAlong(scene, state, rt, dest.x, dest.y - 6, "idle", now);
            cat.returnHomeAt = now + WALK_MS * 2 + 1600 + Math.random() * 1400;
          }
        }
      }
    }
  }
}

function showBubble(scene: PhaserScene, rt: CatRuntime, text: string, untilMs: number) {
  rt.actor.bubble = text;
  rt.actor.bubbleUntil = untilMs;
  if (rt.bubble) {
    rt.bubble.destroy();
    rt.bubble = null;
  }
  const Phaser = (scene.game.scene as unknown as { _Phaser?: Phaser3 })._Phaser;
  const lbl = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  const label = scene.add
    .text(0, 0, lbl, {
      fontFamily: `${ARK_PIXEL_FAMILY}, "Courier New", monospace`,
      fontSize: "11px",
      color: "#f5efe4",
      backgroundColor: "rgba(45, 35, 28, 0.94)",
      padding: { left: 8, right: 8, top: 4, bottom: 4 },
    })
    .setOrigin(0, 1);
  const c = scene.add.container(rt.sprite.x, rt.sprite.y - 40, [label]);
  c.setDepth(5000);
  rt.bubble = c;
  void Phaser;
}

function parseCssColor(css: string): number {
  const s = css.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return (r << 16) | (g << 8) | b;
    }
    if (hex.length === 6) return parseInt(hex, 16);
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1]!.split(",").map((p) => parseFloat(p.trim()));
    const [r = 0, g = 0, b = 0] = parts;
    return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
  }
  return 0x000000;
}

function updateBubbles(state: PhaserRuntimeState, now: number) {
  for (const rt of state.cats.values()) {
    if (rt.bubble) {
      const d = depthScale(rt.actor.depth ?? 0.5);
      rt.bubble.setPosition(rt.sprite.x + 8 * rt.actor.facing, rt.sprite.y - 28 * d);
      if (!rt.actor.bubbleUntil || now > rt.actor.bubbleUntil) {
        rt.bubble.destroy();
        rt.bubble = null;
        rt.actor.bubble = undefined;
      }
    }
  }
}

export async function createPhaserOffice(
  container: HTMLElement,
  initial: PhaserUpdateInput,
  cb: PhaserOfficeCallbacks
): Promise<PhaserOfficeHandle> {
  const Phaser = await loadPhaser();
  await ensureArkPixelLoaded();

  const layout = computeOfficeLayout(initial.nodes, STAGE_W, STAGE_H);
  const persp0 = computeOfficePerspective(STAGE_W, STAGE_H, layout.windowH);
  const state: PhaserRuntimeState = {
    Phaser,
    city: initial.city,
    isRunning: initial.isRunning,
    selectedRole: initial.selectedRole,
    layout,
    agentNodes: initial.nodes,
    cats: new Map(),
    beams: [],
    particles: [],
    seen: new Set(),
    pathGrid: buildPathGrid(layout, persp0),
  };

  const off = document.createElement("canvas");
  off.width = STAGE_W;
  off.height = STAGE_H;

  let bgImage: import("phaser").GameObjects.Image | null = null;
  let plaqueText: import("phaser").GameObjects.Text | null = null;
  let statusText: import("phaser").GameObjects.Text | null = null;
  let selectionRect: import("phaser").GameObjects.Rectangle | null = null;
  let themeOverlay: import("phaser").GameObjects.Rectangle | null = null;
  let hitZones = new Map<string, import("phaser").GameObjects.Zone>();
  let sceneRef: PhaserScene | null = null;
  let themeUnsub: (() => void) | null = null;

  function ensureCatRuntime(scene: PhaserScene, n: AnalystTeamGraphNode, desk: DeskSlot) {
    let rt = state.cats.get(n.role);
    if (rt) {
      rt.actor.label = n.label;
      rt.actor.homeX = desk.x;
      rt.actor.homeY = desk.y - 8;
      rt.actor.depth = desk.depth;
      if (rt.actor.action === "idle") {
        teleportTo(rt, desk.x, desk.y - 8);
      }
      const d = depthScale(desk.depth);
      rt.sprite.setScale(d * 2.4);
      return;
    }
    const breed = breedForRole(n.role);
    const actor: CatActor = {
      role: n.role,
      label: n.label,
      breed,
      homeX: desk.x,
      homeY: desk.y - 8,
      x: desk.x,
      y: desk.y - 8,
      depth: desk.depth,
      action: "idle",
      actionUntil: 0,
      frame: 0,
      facing: 1,
      screenMode: "idle",
    };
    const sprite = scene.add.sprite(desk.x, desk.y - 8, CAT_ATLAS_KEY, catFrameName(breed, "idle"));
    sprite.setOrigin(0.5, 1);
    sprite.setScale(depthScale(desk.depth) * 2.4);
    sprite.setDepth(1000);
    rt = { actor, sprite, bubble: null, currentAnim: "", walkSeq: 0 };
    state.cats.set(n.role, rt);
    rt.sprite.play(catAnimKey(breed, "idle"));
    rt.currentAnim = catAnimKey(breed, "idle");
  }

  class OfficeScene extends Phaser.Scene {
    constructor() {
      super("OfficeScene");
    }
    create() {
      sceneRef = this;
      ensureCatAtlasInScene(this);
      ensureActiveAtlasLoaded();

      const tex = this.textures.addCanvas(BG_TEXTURE_KEY, off);
      if (tex) {
        bgImage = this.add.image(STAGE_W / 2, STAGE_H / 2, BG_TEXTURE_KEY).setOrigin(0.5);
        bgImage.setDepth(0);
      }

      for (const n of state.agentNodes) {
        const desk = state.layout.desks.get(n.role);
        if (desk) ensureCatRuntime(this, n, desk);
      }

      selectionRect = this.add.rectangle(0, 0, 0, 0).setStrokeStyle(3, 0xffd700);
      selectionRect.setDepth(2500).setVisible(false);

      // 主题滤镜：覆盖背景 + 工位 + 猫咪，位于 plaque/status 之下
      themeOverlay = this.add
        .rectangle(STAGE_W / 2, STAGE_H / 2, STAGE_W, STAGE_H, 0x000000, 0)
        .setDepth(2900);

      themeUnsub = subscribeThemeChange(() => {
        // 主题变更：背景层下一帧自动重绘（drawOfficeScene 读最新 atlas 与色板）
        ensureActiveAtlasLoaded();
      });

      const plaqueX = STAGE_W / 2;
      const plaqueY = STAGE_H - 36;
      const plaqueBg = this.add.rectangle(plaqueX, plaqueY, 420, 44, 0x5d4037);
      plaqueBg.setStrokeStyle(3, 0x3e2723).setDepth(3000);
      plaqueText = this.add
        .text(plaqueX, plaqueY, "Qubit Agent 办公室", {
          fontFamily: `${ARK_PIXEL_FAMILY}, "Courier New", monospace`,
          fontSize: "18px",
          color: "#ffd700",
          fontStyle: "bold",
          stroke: "#000",
          strokeThickness: 3,
        })
        .setOrigin(0.5)
        .setDepth(3001);
      this.add
        .text(plaqueX - 190, plaqueY, "⭐", { fontFamily: `${ARK_PIXEL_FAMILY}, monospace`, fontSize: "20px" })
        .setOrigin(0.5)
        .setDepth(3001);
      this.add
        .text(plaqueX + 190, plaqueY, "⭐", { fontFamily: `${ARK_PIXEL_FAMILY}, monospace`, fontSize: "20px" })
        .setOrigin(0.5)
        .setDepth(3001);

      statusText = this.add
        .text(16, STAGE_H - 16, "[待命] 休息角待命中", {
          fontFamily: `${ARK_PIXEL_FAMILY}, monospace`,
          fontSize: "14px",
          color: "#eeeeee",
          backgroundColor: "rgba(0,0,0,0.72)",
          padding: { left: 10, right: 10, top: 6, bottom: 6 },
        })
        .setOrigin(0, 1)
        .setDepth(3001);

      rebuildHitZones(this);
      this.input.on("pointerdown", (_p: import("phaser").Input.Pointer, targets: unknown[]) => {
        if (targets.length === 0) cb.onClear();
      });
    }

    update(_time: number, _delta: number) {
      const now = performance.now();
      tickActorTimers(this, state, now);

      // 同步每只猫的 depth（layer 排序），并应用动作动画
      for (const rt of state.cats.values()) {
        const persp = computeOfficePerspective(STAGE_W, STAGE_H, state.layout.windowH);
        const v =
          rt.actor.action === "walk" ? depthAtY(persp, rt.sprite.y) : (rt.actor.depth ?? 0.5);
        rt.actor.depth = v;
        const d = depthScale(v);
        rt.sprite.setScale(d * 2.4);
        rt.sprite.setDepth(1000 + Math.floor(rt.sprite.y));
        if (rt.actor.action !== "walk") {
          rt.actor.x = rt.sprite.x;
          rt.actor.y = rt.sprite.y;
          playAnim(rt, this);
        }
      }

      renderBackgroundLayer(off, state, now);
      const t = this.textures.get(BG_TEXTURE_KEY);
      const refresh = (t as unknown as { refresh?: () => void }).refresh;
      if (typeof refresh === "function") refresh.call(t);

      updateBubbles(state, now);

      if (selectionRect) {
        if (state.selectedRole) {
          const rt = state.cats.get(state.selectedRole);
          if (rt) {
            const d = depthScale(rt.actor.depth ?? 0.5);
            selectionRect.setPosition(rt.sprite.x, rt.sprite.y - 26 * d);
            selectionRect.setSize(72 * d, 86 * d);
            selectionRect.setVisible(true);
          } else selectionRect.setVisible(false);
        } else selectionRect.setVisible(false);
      }

      if (themeOverlay) {
        const filter = getActiveTheme().filter;
        const alpha = filter.overlayAlpha ?? 0;
        if (alpha > 0 && filter.overlayColor) {
          themeOverlay.setFillStyle(parseCssColor(filter.overlayColor), Math.min(1, alpha));
          themeOverlay.setVisible(true);
        } else {
          themeOverlay.setVisible(false);
        }
      }
    }
  }

  function rebuildHitZones(scene: PhaserScene) {
    for (const z of hitZones.values()) z.destroy();
    hitZones = new Map();
    for (const [role, desk] of state.layout.desks) {
      const r = deskHitRadius(desk.depth);
      const zone = scene.add.zone(desk.x, desk.y - 8, r * 1.6, r * 1.6);
      zone.setOrigin(0.5).setInteractive({ useHandCursor: true });
      zone.on("pointerdown", () => cb.onSelectRole(role));
      hitZones.set(role, zone);
    }
  }

  const game: PhaserGame = new Phaser.Game({
    type: Phaser.AUTO,
    width: STAGE_W,
    height: STAGE_H,
    parent: container,
    pixelArt: true,
    backgroundColor: "#1a1a2e",
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: STAGE_W,
      height: STAGE_H,
    },
    scene: OfficeScene,
  });

  return {
    destroy: () => {
      try {
        themeUnsub?.();
        themeUnsub = null;
        themeOverlay?.destroy();
        themeOverlay = null;
        for (const rt of state.cats.values()) {
          rt.bubble?.destroy();
          rt.sprite.destroy();
        }
        state.cats.clear();
        game.destroy(true);
      } catch {
        /* ignore */
      }
    },
    resize: () => game.scale.refresh(),
    update: (input: PhaserUpdateInput) => {
      const scene = sceneRef;
      const cityChanged = input.city !== state.city;
      const nodesChanged = input.nodes !== state.agentNodes;

      state.city = input.city;
      state.isRunning = input.isRunning;
      state.selectedRole = input.selectedRole;
      state.agentNodes = input.nodes;

      if ((nodesChanged || cityChanged) && scene) {
        state.layout = computeOfficeLayout(input.nodes, STAGE_W, STAGE_H);
        state.pathGrid = buildPathGrid(
          state.layout,
          computeOfficePerspective(STAGE_W, STAGE_H, state.layout.windowH)
        );
        for (const n of input.nodes) {
          const desk = state.layout.desks.get(n.role);
          if (desk) ensureCatRuntime(scene, n, desk);
        }
        for (const role of [...state.cats.keys()]) {
          if (!state.layout.desks.has(role)) {
            const rt = state.cats.get(role);
            rt?.bubble?.destroy();
            rt?.sprite.destroy();
            state.cats.delete(role);
          }
        }
        rebuildHitZones(scene);
      }

      const reg = getPixelOfficeRegistry();
      const windowMs = input.isRunning ? 18_000 : 90_000;
      const cutoff = Date.now() - windowMs;
      const markOld = (id: string, iso: string) => {
        const t = new Date(iso).getTime();
        if (Number.isFinite(t) && t < cutoff) state.seen.add(id);
      };
      for (const row of input.graph.interactions ?? []) {
        markOld(`i:${row.id}`, row.createdAt);
        if (classifyInteractionKind(row.kind) === "chat") {
          markOld(`i:${row.id}:send`, row.createdAt);
          markOld(`i:${row.id}:recv`, row.createdAt);
        }
      }
      for (const tc of input.graph.toolCalls ?? []) {
        markOld(`t:${tc.id}:go`, tc.createdAt);
        markOld(`t:${tc.id}:work`, tc.createdAt);
        markOld(`t:${tc.id}:fx`, tc.createdAt);
      }
      for (const mc of input.graph.mcpCalls ?? []) {
        markOld(`m:${mc.id}:go`, mc.createdAt);
        markOld(`m:${mc.id}:work`, mc.createdAt);
        markOld(`m:${mc.id}:fx`, mc.createdAt);
      }

      const newEvents = mapGraphToOfficeEventsExtended(
        {
          nodes: input.graph.nodes,
          interactions: input.graph.interactions ?? [],
          toolCalls: input.graph.toolCalls ?? [],
          mcpCalls: input.graph.mcpCalls ?? [],
        },
        state.seen,
        reg.getEventMapperHooks()
      );
      if (scene) {
        const now = performance.now();
        for (const ev of newEvents) {
          applyOfficeEvent(scene, state, ev, now);
          state.seen.add(ev.id);
        }
      }

      if (statusText) {
        if (input.isRunning) statusText.setText("[团队分析] 工作中");
        else if (input.selectedRole) {
          const n = input.nodes.find((x) => x.role === input.selectedRole);
          statusText.setText(`[${n?.label || input.selectedRole}] 已选中`);
        } else statusText.setText("[待命] 休息角待命中");
      }
      void plaqueText;
    },
  };
}
