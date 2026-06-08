/**
 * Cursor Canvas 自动生成（Round 7 复盘 2026-06-08 新增）
 *
 * 把一轮评测的 5 scenario 结果渲染成 `.canvas.tsx`，写到
 * `~/.cursor/projects/<workspace>/canvases/` 目录。Cursor IDE 自动识别。
 *
 * 设计：
 *   - 单文件 React 组件（canvas skill 要求）
 *   - 只 import 'cursor/canvas'（canvas skill 要求）
 *   - 所有数据 inline，无网络调用
 *   - 失败不阻塞主流程：写文件出错只记 warn
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OverallGrade, MetricGrade } from "./thresholds";

export interface CanvasScenarioRow {
  scenario: string;
  workflowRunId: string;
  workflowStatus: string;
  overall: OverallGrade;
  weightedScore?: number;
  categoryScores?: Record<"A" | "B" | "C" | "D", number | null>;
  metricGrades: Record<string, MetricGrade | null>;
  metricValues: Record<string, number | null>;
  elapsedMs: number;
  timedOut: boolean;
  startError?: string;
}

export interface CanvasReportInput {
  roundLabel: string;
  /** 评测开始时间 ISO 字符串（用于标题副文案） */
  startedAt: string;
  /** 报告目录绝对路径（链接出来）*/
  reportDir: string;
  /** 5 个 scenario 的结果（顺序与 SCENARIO_ORDER 一致） */
  rows: CanvasScenarioRow[];
  /** dev server URL（如 http://127.0.0.1:17385） */
  devServer: string;
  /** project id */
  projectId: string;
}

/**
 * 根据当前 workspace 推导 Cursor canvases 目录。
 *
 * Cursor 用 `~/.cursor/projects/<slug>/canvases/` 存放 canvas。slug 是工作区
 * 绝对路径替换 `/` 为 `-` 再裁掉首 `-`：
 *   /Users/jiajun.wu03/repos/mine_repos/qubit-agent
 *   → Users-jiajun.wu03-repos-mine_repos-qubit-agent 实际是
 *   → Users-jiajun-wu03-repos-mine-repos-qubit-agent（`.` 和 `_` 也变 `-`）
 *
 * 为避免猜错，我们 fallback：扫 ~/.cursor/projects/ 下含 "qubit-agent" 的目录。
 * 命中 0 个 → 返回 null（caller 跳过 canvas 生成）。
 */
export async function resolveCanvasDir(): Promise<string | null> {
  const projectsRoot = join(homedir(), ".cursor", "projects");
  try {
    const entries = await readdir(projectsRoot);
    /** 用 "qubit-agent" 作为 marker，匹配当前 workspace */
    const matched = entries.find((e) => e.endsWith("qubit-agent"));
    if (!matched) return null;
    return join(projectsRoot, matched, "canvases");
  } catch {
    return null;
  }
}

/**
 * 渲染 .canvas.tsx 内容字符串。
 *
 * 注意：不能在这里 import 'cursor/canvas'——这文件是 server-side 运行时的一部分，
 * 没那个 package。我们只生成字符串内容，让 Cursor IDE 编译时去解析 'cursor/canvas'。
 */
export function renderCanvasTsx(input: CanvasReportInput): string {
  const data = {
    roundLabel: input.roundLabel,
    startedAt: input.startedAt,
    reportDir: input.reportDir,
    devServer: input.devServer,
    projectId: input.projectId,
    rows: input.rows,
  };

  const json = JSON.stringify(data, null, 2);

  return `/**
 * Agent Readiness 评测自动生成 Canvas — ${input.roundLabel}
 *
 * 评测开始：${input.startedAt}
 * 报告目录：${input.reportDir}
 *
 * 此文件由 src/runtime/agent-readiness/canvas-report.ts 自动生成；
 * 手改会被下次评测覆盖。
 */

import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

const DATA = ${json} as const;

type Grade = "A" | "B" | "C" | "D" | "F";

function gradePill(g: Grade | string): "success" | "warning" | "danger" | "neutral" {
  if (g === "A" || g === "B") return "success";
  if (g === "C") return "warning";
  if (g === "D" || g === "F") return "danger";
  return "neutral";
}

function tonePill(
  tone: string | null
): { label: string; pillTone: "success" | "warning" | "danger" | "neutral" } {
  switch (tone) {
    case "green":
      return { label: "绿", pillTone: "success" };
    case "yellow":
      return { label: "黄", pillTone: "warning" };
    case "red":
      return { label: "红", pillTone: "danger" };
    default:
      return { label: "n/a", pillTone: "neutral" };
  }
}

function formatScore(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v <= 1) return \`\${(v * 100).toFixed(0)}%\`;
  if (v > 1000) return \`\${(v / 1000).toFixed(0)}k\`;
  return v.toFixed(2);
}

export default function AgentReadinessCanvas() {
  const theme = useHostTheme();
  const rows = DATA.rows;
  const passCount = rows.filter((r) => r.overall === "A" || r.overall === "B" || r.overall === "C").length;
  const totalTokens = rows.reduce((s, r) => s + (Number(r.metricValues["C-3-total"]) || 0), 0);
  const totalElapsedSec = rows.reduce((s, r) => s + r.elapsedMs / 1000, 0);
  const avgScore =
    rows.reduce((s, r) => s + (r.weightedScore ?? 0), 0) / Math.max(1, rows.length);

  return (
    <Stack gap={24} style={{ padding: 24, maxWidth: 1200, color: theme.fg }}>
      <Stack gap={8}>
        <H1>Agent 五场景就绪度评测 — {DATA.roundLabel}</H1>
        <Text size="sm" style={{ color: theme.fgMuted }}>
          {DATA.startedAt} · {DATA.devServer} · project {DATA.projectId.slice(0, 12)}…
        </Text>
      </Stack>

      <Row gap={16} wrap>
        <Stat label="场景通过率（C 及以上）" value={\`\${passCount} / \${rows.length}\`} tone={passCount === rows.length ? "success" : passCount > 0 ? "warning" : "danger"} />
        <Stat label="平均加权分" value={(avgScore * 100).toFixed(0) + "%"} tone={avgScore >= 0.7 ? "success" : avgScore >= 0.5 ? "warning" : "danger"} />
        <Stat label="总 Token" value={\`\${(totalTokens / 1000).toFixed(0)}k\`} />
        <Stat label="总用时" value={\`\${(totalElapsedSec / 60).toFixed(1)}min\`} />
      </Row>

      <Callout tone="info" title="评测路径">
        通过 dev server HTTP API（POST /api/v1/workflows + /api/v1/analyst/run，
        与 UI 路径一致），由 orchestrator LangGraph 主链路派发。报告目录：
        <Text mono>{DATA.reportDir}</Text>
      </Callout>

      <Card>
        <CardHeader title="场景汇总（AQM v2 加权评分）" subtitle="A 内容 40% · B 工具 30% · C LLM 20% · D 编排 10%" />
        <CardBody style={{ padding: 0 }}>
          <Table
            columns={[
              { key: "scenario", header: "场景", width: 100 },
              { key: "wf", header: "workflow", width: 86 },
              { key: "grade", header: "总分", width: 48, align: "center" },
              { key: "score", header: "加权", width: 60, align: "right" },
              { key: "A", header: "A 内容", width: 60, align: "right" },
              { key: "B", header: "B 工具", width: 60, align: "right" },
              { key: "C", header: "C LLM", width: 60, align: "right" },
              { key: "D", header: "D 编排", width: 60, align: "right" },
              { key: "elapsed", header: "用时", width: 70, align: "right" },
              { key: "status", header: "状态" },
            ]}
            rows={rows.map((r) => ({
              key: r.scenario,
              scenario: r.scenario,
              wf: r.workflowRunId.slice(0, 8),
              grade: <Pill tone={gradePill(r.overall)} size="sm">{r.overall}</Pill>,
              score: formatScore(r.weightedScore),
              A: formatScore(r.categoryScores?.A ?? null),
              B: formatScore(r.categoryScores?.B ?? null),
              C: formatScore(r.categoryScores?.C ?? null),
              D: formatScore(r.categoryScores?.D ?? null),
              elapsed: \`\${(r.elapsedMs / 1000).toFixed(0)}s\`,
              status: r.timedOut ? (
                <Pill tone="warning" size="sm">timeout</Pill>
              ) : r.startError ? (
                <Pill tone="danger" size="sm">start_error</Pill>
              ) : (
                <Pill tone="neutral" size="sm">{r.workflowStatus}</Pill>
              ),
            }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="AQM 主指标明细" subtitle="A-1 产物完整 · A-2 关键词命中 · B-1 工具召回 · B-3 失败率 · C-2 主路径失败 · D-2 步数效率" />
        <CardBody style={{ padding: 0 }}>
          <Table
            columns={[
              { key: "s", header: "场景", width: 100 },
              { key: "A1", header: "A-1 产物", width: 80 },
              { key: "A2", header: "A-2 关键词", width: 86 },
              { key: "B1", header: "B-1 召回", width: 80 },
              { key: "B3", header: "B-3 失败率", width: 84 },
              { key: "C2", header: "C-2 主路径失败", width: 110 },
              { key: "C3", header: "C-3 token p95", width: 100 },
              { key: "D2", header: "D-2 步数效率", width: 100 },
            ]}
            rows={rows.map((r) => {
              const g = (k: string) => tonePill(r.metricGrades[k] ?? null);
              const v = (k: string) => formatScore(r.metricValues[k] ?? null);
              const cell = (k: string) => (
                <Row gap={4}>
                  <Pill tone={g(k).pillTone} size="sm">{g(k).label}</Pill>
                  <Text size="sm">{v(k)}</Text>
                </Row>
              );
              return {
                key: r.scenario,
                s: r.scenario,
                A1: cell("A-1"),
                A2: cell("A-2"),
                B1: cell("B-1"),
                B3: cell("B-3"),
                C2: cell("C-2"),
                C3: cell("C-3-p95"),
                D2: cell("D-2"),
              };
            })}
          />
        </CardBody>
      </Card>

      <Grid columns={2} gap={16}>
        {rows.map((r) => (
          <Card key={r.scenario}>
            <CardHeader
              title={r.scenario}
              subtitle={\`workflow=\${r.workflowRunId.slice(0, 8)} · \${(r.elapsedMs / 1000).toFixed(0)}s\`}
            />
            <CardBody>
              <Stack gap={8}>
                <Row gap={8}>
                  <Pill tone={gradePill(r.overall)} size="sm">{r.overall}</Pill>
                  <Pill tone={r.timedOut ? "warning" : "neutral"} size="sm">{r.workflowStatus}</Pill>
                  {r.startError ? <Pill tone="danger" size="sm">start_error</Pill> : null}
                </Row>
                <Row gap={12} wrap>
                  <Text size="sm" style={{ color: theme.fgMuted }}>A: {formatScore(r.categoryScores?.A ?? null)}</Text>
                  <Text size="sm" style={{ color: theme.fgMuted }}>B: {formatScore(r.categoryScores?.B ?? null)}</Text>
                  <Text size="sm" style={{ color: theme.fgMuted }}>C: {formatScore(r.categoryScores?.C ?? null)}</Text>
                  <Text size="sm" style={{ color: theme.fgMuted }}>D: {formatScore(r.categoryScores?.D ?? null)}</Text>
                </Row>
                {r.startError ? (
                  <Text size="sm" style={{ color: theme.fgMuted }}>{r.startError.slice(0, 200)}</Text>
                ) : null}
              </Stack>
            </CardBody>
          </Card>
        ))}
      </Grid>

      <Callout tone="neutral" title="如何深入">
        <Text size="sm">
          每个 scenario 的完整 trace / JSON / Markdown 报告在
          <Text mono>{DATA.reportDir}</Text>
          下，文件名 <Text mono>{"trace-<scenario>-<workflowRunId>.md"}</Text>。
          打开任一 trace 文件可看每一步 ReAct（reason/act/observe）的完整内容。
        </Text>
      </Callout>
    </Stack>
  );
}
`;
}

/**
 * 把渲染好的 canvas 写入 ~/.cursor/projects/<workspace>/canvases/。
 *
 * @returns 写入的绝对路径；若 canvases 目录推导失败返回 null
 */
export async function writeCanvasReport(
  input: CanvasReportInput & { fileBaseName: string }
): Promise<string | null> {
  const dir = await resolveCanvasDir();
  if (!dir) return null;
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    /** 目录可能本来就在；ignore */
  }
  const file = join(dir, `${input.fileBaseName}.canvas.tsx`);
  try {
    await writeFile(file, renderCanvasTsx(input), "utf8");
    return file;
  } catch (err) {
    console.warn(`[canvas-report] failed to write ${file}:`, err);
    return null;
  }
}
