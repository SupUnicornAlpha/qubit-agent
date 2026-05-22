import type { FC, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalystTeamGraphEdge,
  AnalystTeamGraphNode,
  AnalystTeamGraphPayload,
} from "../../api/types";
import { breedForRole } from "../../lib/pixelOffice/catAppearance";
import { classifyInteractionKind } from "../../lib/pixelOffice/classify";
import { getRenderConfig } from "../../lib/pixelOffice/config";
import { mapGraphToOfficeEventsExtended } from "../../lib/pixelOffice/eventMapper";
import { getPixelOfficeRegistry } from "../../lib/pixelOffice/runtime";
import { preloadSkylineImages } from "../../lib/pixelOffice/skylineImages";
import { computeOfficeLayout, deskHitRadius } from "../../lib/pixelOffice/officeLayout";
import { computeOfficePerspective, depthAtY } from "../../lib/pixelOffice/officePerspective";
import {
  actionLabel,
  drawCatSprite,
  drawChatBeam,
  drawOfficeScene,
  drawParticles,
  drawRoleLabel,
  drawWorkstation,
  screenModeForAction,
  spawnParticles,
  tickParticles,
} from "../../lib/pixelOffice/officeRenderer";
import type {
  CatAction,
  CatActor,
  ChatBeam,
  CitySkyline,
  OfficeEvent,
  Particle,
} from "../../lib/pixelOffice/types";
import { ACTION_MS, WALK_MS } from "../../lib/pixelOffice/types";
import type { TeamGraphActivity, TeamGraphSelection } from "../ide/TeamAgentGraph";

const SERVER_ROLE = "__tools__";
const CITY_OPTIONS: { id: CitySkyline; label: string }[] = [
  { id: "shanghai", label: "上海" },
  { id: "nyc", label: "纽约" },
  { id: "hongkong", label: "香港" },
];

type Props = {
  graph: AnalystTeamGraphPayload;
  nodes: AnalystTeamGraphNode[];
  edges: AnalystTeamGraphEdge[];
  selection: TeamGraphSelection;
  onSelectNode: (role: string) => void;
  onClear: () => void;
  activity?: TeamGraphActivity;
  isRunning?: boolean;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function startWalk(
  cat: CatActor,
  toX: number,
  toY: number,
  onDone: CatAction,
  now: number
) {
  cat.walkFromX = cat.x;
  cat.walkFromY = cat.y;
  cat.walkToX = toX;
  cat.walkToY = toY;
  cat.walkOnDone = onDone;
  cat.walkStart = now;
  cat.action = "walk";
  cat.actionUntil = now + WALK_MS;
  cat.facing = toX >= cat.x ? 1 : -1;
}

function applyOfficeEvent(
  cats: Map<string, CatActor>,
  ev: OfficeEvent,
  layout: ReturnType<typeof computeOfficeLayout>,
  now: number,
  beams: ChatBeam[],
  particles: Particle[]
) {
  const cat = cats.get(ev.role);
  if (!cat) return;

  if (ev.kind === "chat_send" && ev.peerRole) {
    const peerDesk = layout.desks.get(ev.peerRole);
    cat.action = "chat_send";
    cat.actionUntil = now + ACTION_MS.chat_send;
    cat.screenMode = "chat";
    cat.bubble = ev.label ?? "喵…";
    cat.bubbleUntil = cat.actionUntil;
    if (peerDesk) cat.facing = peerDesk.x >= cat.homeX ? 1 : -1;
    beams.push({ from: ev.role, to: ev.peerRole, until: now + ACTION_MS.chat_send });
    const peer = cats.get(ev.peerRole);
    if (peer) {
      peer.action = "chat_recv";
      peer.actionUntil = now + ACTION_MS.chat_recv;
      peer.screenMode = "chat";
      peer.facing = cat.homeX >= peer.homeX ? 1 : -1;
    }
    cat.x = cat.homeX;
    cat.y = cat.homeY;
    return;
  }

  if (ev.kind === "chat_recv") return;

  if (ev.kind === "go_rack") {
    startWalk(cat, layout.rack.x, layout.rack.y + 12, "at_rack", now);
    cat.bubble = ev.label;
    cat.bubbleUntil = now + WALK_MS + ACTION_MS.at_rack;
    return;
  }

  if (ev.kind === "go_shelf") {
    startWalk(cat, layout.shelf.x, layout.shelf.y + 12, "at_shelf", now);
    cat.bubble = ev.label;
    cat.bubbleUntil = now + WALK_MS + ACTION_MS.at_shelf;
    return;
  }

  if (ev.kind === "at_rack" || ev.kind === "at_shelf") {
    if (cat.action === "walk") return;
    cat.action = ev.kind;
    cat.actionUntil = now + ACTION_MS[ev.kind];
    cat.screenMode = screenModeForAction(ev.kind, ev.label);
    if (ev.label) {
      cat.bubble = ev.label;
      cat.bubbleUntil = cat.actionUntil;
    }
    return;
  }

  if (ev.kind === "success" || ev.kind === "fail" || ev.kind === "success_empty") {
    const desk = layout.desks.get(ev.role);
    if (!desk) return;
    const dist = Math.hypot(cat.x - desk.x, cat.y - desk.y);
    if (dist > 24 && cat.action !== "walk") {
      startWalk(cat, desk.x, desk.y - 8, ev.kind, now);
      cat.walkOnDone = ev.kind;
      return;
    }
    cat.x = desk.x;
    cat.y = desk.y - 8;
    cat.action = ev.kind;
    cat.actionUntil = now + ACTION_MS[ev.kind];
    cat.screenMode = screenModeForAction(ev.kind);
    const pk = ev.kind === "success" ? "ok" : ev.kind === "fail" ? "err" : "empty";
    spawnParticles(particles, cat.x, cat.y - 20, pk);
    return;
  }

  cat.x = cat.homeX;
  cat.y = cat.homeY;
  cat.action = ev.kind;
  cat.actionUntil = now + (ACTION_MS[ev.kind] || 1500);
  cat.screenMode = screenModeForAction(ev.kind, ev.label);
  if (ev.label) {
    cat.bubble = ev.label;
    cat.bubbleUntil = cat.actionUntil;
  }
}

function tickCats(cats: Map<string, CatActor>, layout: ReturnType<typeof computeOfficeLayout>, now: number) {
  for (const cat of cats.values()) {
    if (cat.action === "walk" && cat.walkToX != null && cat.walkFromX != null && cat.walkStart != null) {
      const t = Math.min(1, (now - cat.walkStart) / WALK_MS);
      cat.x = lerp(cat.walkFromX, cat.walkToX, t);
      cat.y = lerp(cat.walkFromY!, cat.walkToY!, t);
      cat.frame = Math.floor(now / 120) % 2;
      if (t >= 1) {
        cat.x = cat.walkToX;
        cat.y = cat.walkToY!;
        const next = cat.walkOnDone ?? "idle";
        cat.action = next;
        cat.walkToX = undefined;
        cat.walkFromX = undefined;
        cat.walkStart = undefined;
        if (next === "at_rack" || next === "at_shelf") {
          cat.actionUntil = now + ACTION_MS[next];
          cat.screenMode = screenModeForAction(next);
        } else if (next === "success" || next === "fail" || next === "success_empty") {
          cat.actionUntil = now + ACTION_MS[next];
          cat.screenMode = screenModeForAction(next);
        } else {
          cat.action = "idle";
          cat.screenMode = "idle";
          cat.actionUntil = 0;
        }
      }
      continue;
    }

    if (cat.actionUntil > 0 && now > cat.actionUntil) {
      if (cat.action === "at_rack" || cat.action === "at_shelf") {
        const desk = layout.desks.get(cat.role);
        if (desk) startWalk(cat, desk.x, desk.y - 8, "idle", now);
        cat.screenMode = "idle";
      } else if (cat.action !== "walk") {
        cat.action = "idle";
        cat.screenMode = "idle";
        cat.actionUntil = 0;
        cat.x = cat.homeX;
        cat.y = cat.homeY;
      }
    }
  }
}

export const TeamAgentPixelOffice: FC<Props> = ({
  graph,
  nodes,
  selection,
  onSelectNode,
  onClear,
  activity,
  isRunning = false,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 360 });
  const [city, setCity] = useState<CitySkyline>("shanghai");

  const catsRef = useRef<Map<string, CatActor>>(new Map());
  const beamsRef = useRef<ChatBeam[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const rafRef = useRef<number>(0);

  const agentNodes = useMemo(() => nodes.filter((n) => n.role !== SERVER_ROLE), [nodes]);

  const graphInput = useMemo(
    () => ({
      nodes: graph.nodes,
      interactions: graph.interactions ?? [],
      toolCalls: graph.toolCalls ?? [],
      mcpCalls: graph.mcpCalls ?? [],
    }),
    [graph]
  );

  const layout = useMemo(
    () => computeOfficeLayout(agentNodes, size.w, size.h),
    [agentNodes, size.w, size.h]
  );

  useEffect(() => {
    preloadSkylineImages();
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const w = Math.max(320, Math.floor(el.clientWidth));
      const h = Math.max(240, Math.floor(el.clientHeight));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const seen = seenRef.current;
    const windowMs = isRunning ? 18_000 : 90_000;
    const cutoff = Date.now() - windowMs;
    const markOld = (id: string, iso: string) => {
      const t = new Date(iso).getTime();
      if (Number.isFinite(t) && t < cutoff) seen.add(id);
    };
    for (const row of graphInput.interactions) {
      markOld(`i:${row.id}`, row.createdAt);
      if (classifyInteractionKind(row.kind) === "chat") {
        markOld(`i:${row.id}:send`, row.createdAt);
        markOld(`i:${row.id}:recv`, row.createdAt);
      }
    }
    for (const tc of graphInput.toolCalls) {
      markOld(`t:${tc.id}:go`, tc.createdAt);
      markOld(`t:${tc.id}:work`, tc.createdAt);
      markOld(`t:${tc.id}:fx`, tc.createdAt);
    }
    for (const mc of graphInput.mcpCalls) {
      markOld(`m:${mc.id}:go`, mc.createdAt);
      markOld(`m:${mc.id}:work`, mc.createdAt);
      markOld(`m:${mc.id}:fx`, mc.createdAt);
    }
  }, [graphInput, isRunning]);

  useEffect(() => {
    const cats = catsRef.current;
    const now = performance.now();
    for (const n of agentNodes) {
      const desk = layout.desks.get(n.role);
      if (!desk) continue;
      const existing = cats.get(n.role);
      if (existing) {
        existing.label = n.label;
        existing.homeX = desk.x;
        existing.homeY = desk.y - 8;
        existing.depth = desk.depth;
        if (existing.action === "idle") {
          existing.x = desk.x;
          existing.y = desk.y - 8;
        }
      } else {
        cats.set(n.role, {
          role: n.role,
          label: n.label,
          breed: breedForRole(n.role),
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
        });
      }
    }
    for (const role of [...cats.keys()]) {
      if (!layout.desks.has(role)) cats.delete(role);
    }

    const reg = getPixelOfficeRegistry();
    const newEvents = mapGraphToOfficeEventsExtended(
      graphInput,
      seenRef.current,
      reg.getEventMapperHooks()
    );
    for (const ev of newEvents) {
      applyOfficeEvent(cats, ev, layout, now, beamsRef.current, particlesRef.current);
      seenRef.current.add(ev.id);
    }
  }, [graphInput, agentNodes, layout]);

  const paint = useCallback(
    (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { w, h } = size;

      tickCats(catsRef.current, layout, now);

      const cfg = getRenderConfig();
      const dpr = Math.min(window.devicePixelRatio || 1, cfg.maxDevicePixelRatio);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      drawOfficeScene(ctx, w, h, city, layout, now, isRunning);

      const hotRoles = activity?.hotRoles ?? new Set<string>();

      for (const beam of beamsRef.current) {
        const from = catsRef.current.get(beam.from);
        const to = catsRef.current.get(beam.to);
        if (from && to) drawChatBeam(ctx, from.x, from.y, to.x, to.y, now, beam.until);
      }
      beamsRef.current = beamsRef.current.filter((b) => b.until > now);

      const persp = computeOfficePerspective(w, h, layout.windowH);
      const drawLayers = agentNodes
        .map((n) => ({
          n,
          desk: layout.desks.get(n.role),
          cat: catsRef.current.get(n.role),
        }))
        .filter((row): row is { n: (typeof agentNodes)[0]; desk: NonNullable<typeof row.desk>; cat: CatActor } =>
          Boolean(row.desk && row.cat)
        )
        .sort((a, b) => {
          const da = a.cat.action === "walk" ? depthAtY(persp, a.cat.y) : a.desk.depth;
          const db = b.cat.action === "walk" ? depthAtY(persp, b.cat.y) : b.desk.depth;
          return da - db;
        });

      for (const { n, desk, cat } of drawLayers) {
        const depth = cat.action === "walk" ? depthAtY(persp, cat.y) : desk.depth;
        cat.depth = depth;
        const sel = selection?.kind === "node" && selection.role === n.role;
        const hot = hotRoles.has(n.role);
        drawWorkstation(ctx, desk.x, desk.y, cat.screenMode, now, hot, sel, depth, persp);
      }

      for (const { desk, cat } of drawLayers) {
        cat.frame = Math.floor(now / 140) % 2;
        const depth = cat.depth ?? desk.depth;
        drawCatSprite(ctx, cat, now, depth);
        const sel = selection?.kind === "node" && selection.role === cat.role;
        drawRoleLabel(ctx, cat.homeX, cat.homeY, cat.label, cat.role, sel, depth);
      }

      particlesRef.current = tickParticles(particlesRef.current, 16);
      drawParticles(ctx, particlesRef.current);

      if (isRunning) {
        ctx.fillStyle = "rgba(74, 222, 128, 0.9)";
        ctx.font = "11px monospace";
        ctx.textAlign = "left";
        ctx.fillText("● 分析进行中", 12, h - 12);
      }
    },
    [size, layout, city, agentNodes, selection, activity, isRunning]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cfg = getRenderConfig();
    const dpr = Math.min(window.devicePixelRatio || 1, cfg.maxDevicePixelRatio);
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
  }, [size]);

  useEffect(() => {
    const loop = (t: number) => {
      paint(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [paint]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let hit: string | null = null;
    let best = Infinity;
    for (const [role, desk] of layout.desks) {
      const r = deskHitRadius(desk.depth);
      const dx = x - desk.x;
      const dy = y - (desk.y - 8);
      const d2 = dx * dx + dy * dy;
      if (d2 < r * r && d2 < best) {
        best = d2;
        hit = role;
      }
    }
    if (hit) onSelectNode(hit);
    else onClear();
  };

  return (
    <div ref={wrapRef} className="qb-pixel-office qb-pixel-office--fill" data-qb-topology-canvas="">
      <canvas
        ref={canvasRef}
        className="qb-pixel-office-canvas"
        style={{ width: "100%", height: "100%" }}
        onClick={onClick}
      />
      <div className="qb-pixel-office-toolbar">
        <span className="qb-pixel-office-toolbar-label">窗外景观</span>
        {CITY_OPTIONS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={city === c.id ? "is-active" : ""}
            onClick={() => setCity(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="qb-pixel-office-legend">
        <span>像素办公室 · 点击工位选中 Agent</span>
        <span className="qb-pixel-office-legend-actions">
          {(
            [
              ["对话", "chat_send"],
              ["走向机架", "at_rack"],
              ["走向书架", "at_shelf"],
              ["成功", "success"],
              ["失败", "fail"],
              ["空结果", "success_empty"],
            ] as const
          ).map(([label, act]) => (
            <span key={act} title={actionLabel(act)}>
              {label}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
};
