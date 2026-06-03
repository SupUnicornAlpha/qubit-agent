/**
 * Qubit Agent — Memory V2 + Self-Evolving 架构图
 *
 * 一张分层架构图：
 *   Layer A  Agent Loop                              （消费记忆 + 写采集）
 *   Layer B  Memory V2 (5 pipes + hybrid recall)     （把 step/log 沉淀成 experience）
 *   Layer C  Schema 层                               （所有写入这里）
 *   Layer D  Self-Evolving Workers (P4b–P9, 6 个)    （读 schema → 写回 schema）
 *
 *   右栏  Control plane（self-evolve-config 三层开关）
 *
 * 边的语义靠 4 种颜色 + 4 种描述区分（图例在下方）。
 */

import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Link,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

// ============================================================================
// 数据：节点 + 边
// ============================================================================

type EdgeKind =
  | "writes" // 实线箭头：写数据（向下 / 同层）
  | "reads" // 虚线箭头：读数据
  | "injects" // 粗实线 + accent：注入到 prompt / 真装到 server
  | "gates"; // 点线：env 开关 gate

interface Node {
  id: string;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 节点视觉强调度 */
  emphasis?: "normal" | "accent" | "muted";
  /** 落地期号标签（右上角小角标） */
  badge?: string;
}

interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 可选：边中文字注释 */
  label?: string;
  /** 默认从 from 底中心 → to 顶中心。这里能强制重写出入端 */
  fromAnchor?: "top" | "bottom" | "left" | "right";
  toAnchor?: "top" | "bottom" | "left" | "right";
  /** 弯路控制点，避免和其它边重叠（百分比 0~1） */
  curveOffset?: number;
}

// ---- 主架构图布局 -----------------------------------------------------------

// viewBox 1280 x 760, 5 横向 band + 右侧 Control 列

const BAND_H = 150;
const BAND_GAP = 12;
const BAND_X = 24;
const BAND_W = 1010; // 留 ~230 给右栏 control plane
const CTRL_X = BAND_X + BAND_W + 20;
const CTRL_W = 200;

const BAND_Y = (i: number) => 60 + i * (BAND_H + BAND_GAP);

const NODES: Node[] = [
  // ── Layer A · Agent Loop ──
  { id: "reason", label: "reason node", sub: "+ skill recall + PnL skill", x: 60, y: BAND_Y(0) + 30, w: 180, h: 70, emphasis: "accent", badge: "P9 inject" },
  { id: "act", label: "act node", sub: "tool / mcp dispatch", x: 270, y: BAND_Y(0) + 30, w: 160, h: 70 },
  { id: "observation", label: "observation", sub: "result → next reason", x: 460, y: BAND_Y(0) + 30, w: 160, h: 70 },
  { id: "llm_gw", label: "LLM Gateway (P0)", sub: "telemetry · sampling", x: 660, y: BAND_Y(0) + 30, w: 170, h: 70, emphasis: "muted" },
  { id: "tool_call", label: "tool / mcp call", sub: "logs to schema", x: 870, y: BAND_Y(0) + 30, w: 140, h: 70 },

  // ── Layer B · Memory V2 ──
  { id: "extractor", label: "Extractor", sub: "agent_step → procedural", x: 40, y: BAND_Y(1) + 35, w: 150, h: 60 },
  { id: "reflector", label: "Reflector", sub: "summary → reflective", x: 210, y: BAND_Y(1) + 35, w: 150, h: 60 },
  { id: "embedder", label: "Embedder", sub: "→ experience_vector", x: 380, y: BAND_Y(1) + 35, w: 150, h: 60 },
  { id: "curator", label: "Curator", sub: "decay / archive", x: 550, y: BAND_Y(1) + 35, w: 150, h: 60 },
  { id: "exp_store", label: "ExperienceStore", sub: "experience (3 kind)", x: 720, y: BAND_Y(1) + 35, w: 160, h: 60 },
  { id: "exp_recall", label: "ExperienceRecall", sub: "hybrid: vec + keyword", x: 900, y: BAND_Y(1) + 35, w: 140, h: 60, emphasis: "accent" },

  // ── Layer C · Schema ──
  { id: "workflow_run", label: "workflow_run", x: 40, y: BAND_Y(2) + 40, w: 130, h: 50 },
  { id: "agent_step", label: "agent_step", x: 185, y: BAND_Y(2) + 40, w: 130, h: 50 },
  { id: "agent_skill", label: "agent_skill", sub: "+ pnl_attribution_json", x: 330, y: BAND_Y(2) + 40, w: 165, h: 50 },
  { id: "agent_skill_run", label: "agent_skill_run", sub: "+ pnl_delta", x: 510, y: BAND_Y(2) + 40, w: 145, h: 50 },
  { id: "pnl_attr", label: "agent_pnl_attribution", x: 670, y: BAND_Y(2) + 40, w: 180, h: 50, badge: "P4b" },
  { id: "tool_gap", label: "tool_gap_log", x: 865, y: BAND_Y(2) + 40, w: 130, h: 50, badge: "P7" },
  { id: "auto_prop", label: "auto_install_proposal", x: 40, y: BAND_Y(2) + 100, w: 170, h: 40, badge: "P8" },
  { id: "mcp_server", label: "mcp_server_config + tool_binding", x: 225, y: BAND_Y(2) + 100, w: 240, h: 40 },
  { id: "fill", label: "fill / strategy_pnl_snapshot", x: 480, y: BAND_Y(2) + 100, w: 220, h: 40 },
  { id: "skill_recall", label: "skill_recall_log", sub: "executed + outcome", x: 715, y: BAND_Y(2) + 100, w: 165, h: 40 },
  { id: "tool_log", label: "tool / mcp / agent_step log", x: 895, y: BAND_Y(2) + 100, w: 150, h: 40 },

  // ── Layer D · Self-Evolving Workers ──
  { id: "pnl_attributor", label: "PnlAttributor", sub: "fill → pnl_attribution", x: 40, y: BAND_Y(3) + 35, w: 150, h: 75, badge: "P4b" },
  { id: "skill_promoter", label: "SkillPromoter", sub: "procedural → pending_review", x: 200, y: BAND_Y(3) + 35, w: 170, h: 75, badge: "P5" },
  { id: "skill_evolver", label: "SkillEvolverWatcher", sub: "revision_request → evolve", x: 380, y: BAND_Y(3) + 35, w: 175, h: 75, badge: "P6" },
  { id: "tool_gap_w", label: "ToolGapWatcher", sub: "3 detector + report_gap", x: 565, y: BAND_Y(3) + 35, w: 170, h: 75, badge: "P7" },
  { id: "auto_installer", label: "AutoInstaller", sub: "propose · auto 真装", x: 745, y: BAND_Y(3) + 35, w: 145, h: 75, badge: "P8/P9", emphasis: "accent" },
  { id: "baseline_obs", label: "SkillBaselineObserver", sub: "召回观察期 → enable", x: 900, y: BAND_Y(3) + 35, w: 145, h: 75, badge: "P9", emphasis: "accent" },

  // ── Right column · Control plane ──
  { id: "control", label: "self-evolve-config", sub: "SELF_EVOLVE_ENABLED\nAUTO_INSTALL_MODE\nPNL_AWARE_REASON_ENABLED\nAUTO_INSTALL_MIN_SCORE", x: CTRL_X, y: BAND_Y(0) + 30, w: CTRL_W, h: 250, emphasis: "accent", badge: "P9" },
  { id: "metrics", label: "metrics/Bus", sub: "self_evolve.* 14 metrics\nmaintenance_run × 6 kinds", x: CTRL_X, y: BAND_Y(2) + 30, w: CTRL_W, h: 110, emphasis: "muted" },
  { id: "cron", label: "cron 编排", sub: "run-pnl-attributor 60m\nrun-tool-gap-watcher 60m\nrun-auto-installer 60m\nrun-skill-evolver-watcher 1d\nrun-skill-baseline-observer 1d\nrun-skill-promoter 1d", x: CTRL_X, y: BAND_Y(3) + 5, w: CTRL_W, h: 145, emphasis: "muted" },
];

const EDGES: Edge[] = [
  // ── Layer A → Layer C：agent loop 写采集 ──
  { from: "act", to: "agent_step", kind: "writes" },
  { from: "tool_call", to: "tool_log", kind: "writes" },
  { from: "reason", to: "skill_recall", kind: "writes", label: "recall log" },

  // ── Layer C → Layer B：pipes 消费 schema ──
  { from: "agent_step", to: "extractor", kind: "reads", fromAnchor: "top", toAnchor: "bottom" },
  { from: "agent_step", to: "reflector", kind: "reads", fromAnchor: "top", toAnchor: "bottom" },

  // ── Layer B 内部 ──
  { from: "extractor", to: "exp_store", kind: "writes" },
  { from: "reflector", to: "exp_store", kind: "writes" },
  { from: "embedder", to: "exp_store", kind: "writes" },
  { from: "curator", to: "exp_store", kind: "writes" },

  // ── Layer B → Layer A：recall 注入 reason ──
  { from: "exp_recall", to: "reason", kind: "injects", label: "experience + skill" },
  { from: "exp_recall", to: "exp_store", kind: "reads" },

  // ── Layer D → Layer C：worker 写 schema ──
  { from: "pnl_attributor", to: "pnl_attr", kind: "writes" },
  { from: "pnl_attributor", to: "agent_skill", kind: "writes", label: "rollup" },
  { from: "pnl_attributor", to: "agent_skill_run", kind: "writes", label: "pnl_delta" },
  { from: "skill_promoter", to: "agent_skill", kind: "writes", label: "pending_review" },
  { from: "skill_evolver", to: "agent_skill", kind: "writes", label: "evolved" },
  { from: "tool_gap_w", to: "tool_gap", kind: "writes" },
  { from: "auto_installer", to: "auto_prop", kind: "writes" },
  { from: "auto_installer", to: "mcp_server", kind: "injects", label: "真装 (auto)" },
  { from: "baseline_obs", to: "agent_skill", kind: "injects", label: "enable" },

  // ── Layer D ← Layer C：worker 读 schema ──
  { from: "fill", to: "pnl_attributor", kind: "reads", fromAnchor: "bottom", toAnchor: "top" },
  { from: "exp_store", to: "skill_promoter", kind: "reads", fromAnchor: "bottom", toAnchor: "top", label: "procedural" },
  { from: "exp_store", to: "skill_evolver", kind: "reads", fromAnchor: "bottom", toAnchor: "top", label: "reflective" },
  { from: "tool_log", to: "tool_gap_w", kind: "reads", fromAnchor: "bottom", toAnchor: "top" },
  { from: "tool_gap", to: "auto_installer", kind: "reads", fromAnchor: "bottom", toAnchor: "top" },
  { from: "skill_recall", to: "baseline_obs", kind: "reads", fromAnchor: "bottom", toAnchor: "top" },
  { from: "agent_skill_run", to: "baseline_obs", kind: "reads", fromAnchor: "bottom", toAnchor: "top" },

  // ── P9 关键回灌：agent_skill (PnL) → reason ──
  { from: "agent_skill", to: "reason", kind: "injects", label: "P9 PnL top-K 注入", curveOffset: -0.15 },

  // ── Control plane gates 所有 worker ──
  { from: "control", to: "auto_installer", kind: "gates" },
  { from: "control", to: "baseline_obs", kind: "gates" },
  { from: "control", to: "reason", kind: "gates", label: "PNL_AWARE_REASON" },
];

const BANDS = [
  { i: 0, label: "Layer A · Agent Loop", sub: "reason → act → observation（消费记忆，写采集）" },
  { i: 1, label: "Layer B · Memory V2", sub: "5 pipes + hybrid recall（让 step / log 沉淀为可召回的 experience）" },
  { i: 2, label: "Layer C · Schema 层", sub: "所有读写都落到 SQLite；自进化的真相在这里" },
  { i: 3, label: "Layer D · Self-Evolving Workers (P4b–P9)", sub: "6 个常驻 worker：读 schema → 写回 schema，形成闭环" },
];

// ============================================================================
// SVG 辅助
// ============================================================================

function nodeById(id: string): Node {
  const n = NODES.find((x) => x.id === id);
  if (!n) throw new Error(`unknown node ${id}`);
  return n;
}

function anchorPoint(n: Node, side: "top" | "bottom" | "left" | "right"): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: n.x + n.w / 2, y: n.y };
    case "bottom":
      return { x: n.x + n.w / 2, y: n.y + n.h };
    case "left":
      return { x: n.x, y: n.y + n.h / 2 };
    case "right":
      return { x: n.x + n.w, y: n.y + n.h / 2 };
  }
}

function autoAnchors(a: Node, b: Node): { from: "top" | "bottom" | "left" | "right"; to: "top" | "bottom" | "left" | "right" } {
  const aMidY = a.y + a.h / 2;
  const bMidY = b.y + b.h / 2;
  const dy = bMidY - aMidY;
  if (Math.abs(dy) > 60) {
    return dy > 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
  }
  const aMidX = a.x + a.w / 2;
  const bMidX = b.x + b.w / 2;
  return bMidX > aMidX ? { from: "right", to: "left" } : { from: "left", to: "right" };
}

function pathFor(e: Edge): string {
  const a = nodeById(e.from);
  const b = nodeById(e.to);
  const auto = autoAnchors(a, b);
  const fromAnchor = e.fromAnchor ?? auto.from;
  const toAnchor = e.toAnchor ?? auto.to;
  const p1 = anchorPoint(a, fromAnchor);
  const p2 = anchorPoint(b, toAnchor);
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  // 默认贝塞尔曲线，curveOffset 控制弯度
  const offsetK = e.curveOffset ?? 0.45;
  const cpY = my + (p2.y - p1.y) * (Math.abs(offsetK) - 0.5);
  const cp1 = { x: p1.x, y: my + (p1.y - my) * (1 - Math.abs(offsetK) * 0.6) };
  const cp2 = { x: p2.x, y: my + (p2.y - my) * (1 - Math.abs(offsetK) * 0.6) };
  void cpY;
  return `M ${p1.x} ${p1.y} C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${p2.x} ${p2.y}`;
}

function midpointFor(e: Edge): { x: number; y: number } {
  const a = nodeById(e.from);
  const b = nodeById(e.to);
  const auto = autoAnchors(a, b);
  const fromAnchor = e.fromAnchor ?? auto.from;
  const toAnchor = e.toAnchor ?? auto.to;
  const p1 = anchorPoint(a, fromAnchor);
  const p2 = anchorPoint(b, toAnchor);
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

// ============================================================================
// 渲染
// ============================================================================

function ArchitectureSVG(): JSX.Element {
  const theme = useHostTheme();
  const VIEW_W = CTRL_X + CTRL_W + 24;
  const VIEW_H = BAND_Y(3) + BAND_H + 30;

  const bandColors = [theme.fill.tertiary, theme.fill.quaternary, theme.fill.tertiary, theme.fill.quaternary];

  const edgeColor = (k: EdgeKind): string => {
    switch (k) {
      case "writes":
        return theme.text.secondary;
      case "reads":
        return theme.text.tertiary;
      case "injects":
        return theme.accent.primary;
      case "gates":
        return theme.text.tertiary;
    }
  };

  const edgeDash = (k: EdgeKind): string | undefined => {
    if (k === "reads") return "4 4";
    if (k === "gates") return "2 4";
    return undefined;
  };

  const edgeWidth = (k: EdgeKind): number => (k === "injects" ? 2 : 1);

  const nodeFill = (n: Node): string => {
    if (n.emphasis === "accent") return theme.fill.secondary;
    if (n.emphasis === "muted") return theme.fill.quaternary;
    return theme.bg.elevated;
  };

  const nodeBorder = (n: Node): string => {
    if (n.emphasis === "accent") return theme.accent.primary;
    return theme.stroke.secondary;
  };

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} style={{ width: "100%", minWidth: 1180, height: "auto", display: "block" }}>
        <defs>
          <marker id="arr-writes" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={theme.text.secondary} />
          </marker>
          <marker id="arr-reads" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={theme.text.tertiary} />
          </marker>
          <marker id="arr-injects" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={theme.accent.primary} />
          </marker>
          <marker id="arr-gates" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <circle cx="5" cy="5" r="3" fill={theme.text.tertiary} />
          </marker>
        </defs>

        {/* ── Band 背景 ── */}
        {BANDS.map((b) => (
          <g key={b.i}>
            <rect
              x={BAND_X - 8}
              y={BAND_Y(b.i)}
              width={BAND_W + 16}
              height={BAND_H}
              rx={8}
              fill={bandColors[b.i]}
              stroke={theme.stroke.tertiary}
            />
            <text x={BAND_X + 4} y={BAND_Y(b.i) + 18} fontSize={11} fontWeight={600} fill={theme.text.secondary}>
              {b.label}
            </text>
            <text x={BAND_X + 4} y={BAND_Y(b.i) + 18} dx={140} fontSize={10} fill={theme.text.tertiary}>
              {b.sub}
            </text>
          </g>
        ))}

        {/* ── 边（先画，让节点压在上面） ── */}
        {EDGES.map((e, idx) => {
          const d = pathFor(e);
          const mid = midpointFor(e);
          return (
            <g key={`e-${idx}`}>
              <path
                d={d}
                fill="none"
                stroke={edgeColor(e.kind)}
                strokeWidth={edgeWidth(e.kind)}
                strokeDasharray={edgeDash(e.kind)}
                markerEnd={`url(#arr-${e.kind})`}
              />
              {e.label ? (
                <g>
                  <rect
                    x={mid.x - e.label.length * 3 - 4}
                    y={mid.y - 8}
                    width={e.label.length * 6 + 8}
                    height={14}
                    rx={3}
                    fill={theme.bg.editor}
                    stroke={theme.stroke.tertiary}
                  />
                  <text x={mid.x} y={mid.y + 2} fontSize={9} textAnchor="middle" fill={theme.text.secondary}>
                    {e.label}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}

        {/* ── 节点 ── */}
        {NODES.map((n) => {
          const subLines = n.sub?.split("\n") ?? [];
          const titleY = n.y + 18;
          return (
            <g key={n.id}>
              <rect
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={6}
                fill={nodeFill(n)}
                stroke={nodeBorder(n)}
                strokeWidth={n.emphasis === "accent" ? 1.4 : 1}
              />
              <text x={n.x + 10} y={titleY} fontSize={12} fontWeight={600} fill={theme.text.primary}>
                {n.label}
              </text>
              {subLines.map((s, si) => (
                <text
                  key={si}
                  x={n.x + 10}
                  y={titleY + 16 + si * 12}
                  fontSize={10}
                  fill={theme.text.tertiary}
                >
                  {s}
                </text>
              ))}
              {n.badge ? (
                <g>
                  <rect
                    x={n.x + n.w - n.badge.length * 6 - 10}
                    y={n.y + 4}
                    width={n.badge.length * 6 + 6}
                    height={14}
                    rx={3}
                    fill={theme.fill.secondary}
                    stroke={theme.stroke.secondary}
                  />
                  <text
                    x={n.x + n.w - n.badge.length * 3 - 7}
                    y={n.y + 14}
                    fontSize={9}
                    textAnchor="middle"
                    fill={theme.text.secondary}
                  >
                    {n.badge}
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── 图例 ─────────────────────────────────────────────────────────────────────

function LegendSwatch({ kind, label, desc }: { kind: EdgeKind; label: string; desc: string }): JSX.Element {
  const theme = useHostTheme();
  const colorMap: Record<EdgeKind, string> = {
    writes: theme.text.secondary,
    reads: theme.text.tertiary,
    injects: theme.accent.primary,
    gates: theme.text.tertiary,
  };
  const dash: Record<EdgeKind, string | undefined> = {
    writes: undefined,
    reads: "4 4",
    injects: undefined,
    gates: "2 4",
  };
  return (
    <Row gap={10} align="center">
      <svg width={60} height={12} style={{ flexShrink: 0 }}>
        <line
          x1={2}
          y1={6}
          x2={56}
          y2={6}
          stroke={colorMap[kind]}
          strokeWidth={kind === "injects" ? 2 : 1}
          strokeDasharray={dash[kind]}
        />
        {kind === "gates" ? (
          <circle cx={56} cy={6} r={3} fill={colorMap[kind]} />
        ) : (
          <path d={`M 50 2 L 58 6 L 50 10 z`} fill={colorMap[kind]} />
        )}
      </svg>
      <Stack gap={1} style={{ minWidth: 0 }}>
        <Text size="small" weight="semibold">{label}</Text>
        <Text size="small" tone="tertiary">{desc}</Text>
      </Stack>
    </Row>
  );
}

// ============================================================================
// 旁注：P9 关键闭环 + 关键文件
// ============================================================================

function P9LoopCard(): JSX.Element {
  return (
    <Card>
      <CardHeader>P9 闭环（图中蓝色边）</CardHeader>
      <CardBody>
        <Stack gap={8}>
          <Stack gap={4}>
            <Text weight="semibold" size="small">① PnL → reason 注入</Text>
            <Text size="small" tone="secondary">
              <Code>agent_pnl_attribution</Code> + <Code>agent_skill_run.pnlDelta</Code>
              {" → "}<Code>listSkillRankingsByDefinition()</Code>
              {" → "}reason userPrompt 追加 top-K
            </Text>
          </Stack>
          <Divider />
          <Stack gap={4}>
            <Text weight="semibold" size="small">② Tool Gap → AutoInstaller auto 真装</Text>
            <Text size="small" tone="secondary">
              <Code>tool_gap_log.open</Code> + safety=low + score≥0.85
              {" → "}<Code>installMcpCatalogToProject()</Code>
              {" → "}<Code>mcp_server_config</Code> + <Code>mcp_tool_binding</Code>
            </Text>
          </Stack>
          <Divider />
          <Stack gap={4}>
            <Text weight="semibold" size="small">③ Evolved skill → 召回观察期 auto enable</Text>
            <Text size="small" tone="secondary">
              <Code>agent_skill(evolved, pending_review)</Code> + 召回≥3 + signaled≥2 + success≥60%
              {" → "}<Code>approveSkillPromotion(actor='skill_baseline_observer')</Code>
              {" → "}<Code>state=active</Code>
            </Text>
          </Stack>
        </Stack>
      </CardBody>
    </Card>
  );
}

function MemoryV2Card(): JSX.Element {
  return (
    <Card>
      <CardHeader>Memory V2（Layer B）的 5 个 pipe</CardHeader>
      <CardBody>
        <Stack gap={4}>
          <Text size="small">
            <Text weight="semibold" size="small">Extractor</Text>
            <Text size="small" tone="secondary"> — 把 agent_step 抽成 procedural（"我用 X 工具做了 Y"）</Text>
          </Text>
          <Text size="small">
            <Text weight="semibold" size="small">Reflector</Text>
            <Text size="small" tone="secondary"> — 任务结束后写 reflective（"这次哪步好，哪步差"）</Text>
          </Text>
          <Text size="small">
            <Text weight="semibold" size="small">Embedder</Text>
            <Text size="small" tone="secondary"> — 给 experience 算 embedding，存到 experience_vector_store</Text>
          </Text>
          <Text size="small">
            <Text weight="semibold" size="small">Curator</Text>
            <Text size="small" tone="secondary"> — decay 旧 experience，archive 不再被召回的</Text>
          </Text>
          <Text size="small">
            <Text weight="semibold" size="small">ExperienceRecall</Text>
            <Text size="small" tone="secondary"> — reason 节点用：embedding + keyword 双路召回 → 注入 prompt</Text>
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

function FilesCard(): JSX.Element {
  return (
    <Card>
      <CardHeader>关键代码入口（按 Layer 索引）</CardHeader>
      <CardBody>
        <Stack gap={6}>
          <Text size="small">
            <Pill size="sm" tone="info">A · reason</Pill>
            {" "}<Code>src/runtime/langgraph/nodes/reason.ts</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">A · PnL 注入</Pill>
            {" "}<Code>src/runtime/langgraph/nodes/pnl-aware-skill-block.ts</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">B · Memory pipes</Pill>
            {" "}<Code>src/runtime/experience/*</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">D · 归因</Pill>
            {" "}<Code>src/runtime/attribution/skill-attributor.ts</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">D · AutoInstaller</Pill>
            {" "}<Code>src/runtime/auto-installer/{`{installer,candidate-matcher,lifecycle}`}.ts</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">D · BaselineObserver</Pill>
            {" "}<Code>src/runtime/skill-baseline-observer/observer.ts</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">D · MCP 装机</Pill>
            {" "}<Code>src/runtime/mcp/install-service.ts</Code>
          </Text>
          <Text size="small">
            <Pill size="sm" tone="info">Control</Pill>
            {" "}<Code>src/runtime/config/self-evolve-config.ts</Code>
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function MemoryAndSelfEvolveArchitecture(): JSX.Element {
  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1320 }}>
      <Stack gap={6}>
        <Row align="center" gap={10}>
          <H1>Memory V2 + Self-Evolving 架构图</H1>
          <Pill tone="success" active>P4a–P9 已交付</Pill>
        </Row>
        <Text tone="secondary">
          4 层 + 1 控制平面，6 个 worker，4 类边的方向定义了"记忆怎么沉淀 / skill 怎么进化 / 工具怎么自配置"。
          蓝色边是 P9 的关键回灌路径（PnL → reason / Gap → 真装 / Evolved → enable）。
        </Text>
        <Text size="small" tone="tertiary">
          源：<Link href="vscode://file//Users/jiajun.wu03/repos/mine_repos/qubit-agent/docs/SELF_EVOLVING_AGENT_DESIGN.md">SELF_EVOLVING_AGENT_DESIGN.md</Link>
          {" · "}backlog：<Link href="vscode://file//Users/jiajun.wu03/repos/mine_repos/qubit-agent/docs/SELF_EVOLVING_AGENT_P10_BACKLOG.md">P10_BACKLOG.md</Link>
          {" · commit "}<Code>2630282</Code>
        </Text>
      </Stack>

      {/* ── 架构图主体 ── */}
      <Card>
        <CardBody style={{ padding: 14 }}>
          <ArchitectureSVG />
        </CardBody>
      </Card>

      {/* ── 图例 ── */}
      <Stack gap={8}>
        <H3>图例</H3>
        <Grid columns={4} gap={16}>
          <LegendSwatch kind="writes" label="writes" desc="向 schema 写数据" />
          <LegendSwatch kind="reads" label="reads" desc="从 schema 读数据" />
          <LegendSwatch kind="injects" label="injects / install" desc="P9 关键回灌：prompt 注入 / 真装" />
          <LegendSwatch kind="gates" label="gates" desc="env 开关 gate（self-evolve-config）" />
        </Grid>
      </Stack>

      {/* ── 旁注三个 ── */}
      <Grid columns={3} gap={12}>
        <P9LoopCard />
        <MemoryV2Card />
        <FilesCard />
      </Grid>

      {/* ── KPI ── */}
      <Stack gap={10}>
        <H2>规模与状态</H2>
        <Grid columns={5} gap={12}>
          <Stat value="4" label="Layer + 1 Control" />
          <Stat value="6" label="Self-Evolve Workers" />
          <Stat value="14" label="self_evolve.* metrics" />
          <Stat value="128" label="P9 单跑回归全过" tone="success" />
          <Stat value="20" label="人/日 (P4a→P9)" />
        </Grid>
      </Stack>

      {/* ── 怎么读这张图 ── */}
      <Stack gap={8}>
        <H2>怎么读这张图（30 秒版）</H2>
        <Callout tone="info" title="一句话">
          数据从顶往中流（采集 → 沉淀），worker 从底往中流（消费 → 写回），蓝色边把"已学到的东西"反向注回 Agent Loop，闭合飞轮。
        </Callout>
        <Grid columns={2} gap={12}>
          <Card>
            <CardHeader>从上往下（沉淀路径）</CardHeader>
            <CardBody>
              <Text size="small" tone="secondary">
                <Text weight="semibold" size="small">A → C</Text>：agent loop 跑完就写 agent_step / tool_log / agent_skill_run；
                <Text weight="semibold" size="small"> C → B</Text>：Memory pipes 把 step 抽成 experience，embedding 入向量库；
                <Text weight="semibold" size="small"> B → A</Text>：下一轮 reason 时 ExperienceRecall 召回相关 experience + skill 注入 prompt（旧能力）。
              </Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>从下往上（自进化路径，P4b–P9 新加）</CardHeader>
            <CardBody>
              <Text size="small" tone="secondary">
                <Text weight="semibold" size="small">C → D</Text>：6 个 worker 读 schema（pnl / experience / step / gap / skill_recall）；
                <Text weight="semibold" size="small"> D → C</Text>：写回 pending_review skill / proposal / gap / 真装的 mcp config；
                <Text weight="semibold" size="small"> D → A（蓝色）</Text>：P9 的三处关键回灌——PnL 排行直接进 reason prompt、AutoInstaller auto 真装 mcp、BaselineObserver enable evolved skill。
              </Text>
            </CardBody>
          </Card>
        </Grid>
      </Stack>
    </Stack>
  );
}
