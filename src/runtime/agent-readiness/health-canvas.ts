/**
 * Health Canvas 自动生成（Round 9 复盘 2026-06-09 新增）。
 *
 * 与 scenarios canvas (canvas-report.ts) 配套：一份 health-canvas 渲染
 * Tools / MCP / LLM-Cost / Skill / Errors 五块跨场景健康度数据，给评测复盘
 * 用。同样走 inline-data 模式，不依赖运行时 fetch。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCanvasDir } from "./canvas-report";
import type { HealthReport } from "./health-aggregator";

export interface HealthCanvasInput {
  roundLabel: string;
  report: HealthReport;
  reportDir: string;
}

/**
 * 把渲染好的 health canvas 写入 ~/.cursor/projects/<workspace>/canvases/。
 *
 * @returns 写入的绝对路径；若 canvases 目录推导失败返回 null
 */
export async function writeHealthCanvas(
  input: HealthCanvasInput & { fileBaseName: string }
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
    await writeFile(file, renderHealthCanvasTsx(input), "utf8");
    return file;
  } catch (err) {
    console.warn(`[health-canvas] failed to write ${file}:`, err);
    return null;
  }
}

export function renderHealthCanvasTsx(input: HealthCanvasInput): string {
  const data = {
    roundLabel: input.roundLabel,
    reportDir: input.reportDir,
    generatedAt: input.report.generatedAt,
    workflowCount: input.report.workflowRunIds.length,
    summary: input.report.summary,
    tools: input.report.tools.slice(0, 15),
    mcp: input.report.mcp,
    llm: input.report.llm,
    skills: input.report.skills.slice(0, 15),
    errors: input.report.errors,
  };
  const json = JSON.stringify(data, null, 2);

  return `/**
 * Agent Health Canvas — ${input.roundLabel}
 *
 * 评测健康度自动生成（覆盖 tool/mcp/llm/skill/error 五维度）。
 * 由 src/runtime/agent-readiness/health-canvas.ts 自动生成；手改会被下次评测覆盖。
 */
import {
  Card,
  CardBody,
  CardHeader,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
  H1,
  H2,
  Callout,
  useHostTheme,
} from "cursor/canvas";

const DATA = ${json} as const;

type Grade = "green" | "yellow" | "red";

function gradeTone(g: Grade | string): "success" | "warning" | "danger" {
  if (g === "green") return "success";
  if (g === "yellow") return "warning";
  return "danger";
}

function gradeLabel(g: Grade | string): string {
  if (g === "green") return "绿";
  if (g === "yellow") return "黄";
  if (g === "red") return "红";
  return "—";
}

function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v < 1000) return \`\${v.toFixed(0)}ms\`;
  return \`\${(v / 1000).toFixed(1)}s\`;
}

function fmtTokens(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v < 1000) return v.toFixed(0);
  return \`\${(v / 1000).toFixed(1)}k\`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return \`\${(v * 100).toFixed(0)}%\`;
}

function fmtUSD(v: number): string {
  if (v < 0.01) return \`$\${v.toFixed(4)}\`;
  return \`$\${v.toFixed(2)}\`;
}

export default function AgentHealthCanvas() {
  const theme = useHostTheme();
  const s = DATA.summary;
  return (
    <Stack gap={24} style={{ padding: 24, maxWidth: 1200, color: theme.fg }}>
      <Stack gap={8}>
        <H1>Agent 健康度报告 — {DATA.roundLabel}</H1>
        <Text size="sm" style={{ color: theme.fgMuted }}>
          {DATA.generatedAt} · {DATA.workflowCount} 个 workflow · 报告目录 <Text mono>{DATA.reportDir}</Text>
        </Text>
      </Stack>

      <Row gap={16} wrap>
        <Stat label="工具调用总数" value={String(s.totalToolCalls)} />
        <Stat label="MCP 调用总数" value={String(s.totalMcpCalls)} />
        <Stat label="LLM 调用总数" value={String(s.totalLlmCalls)} />
        <Stat label="总 Token" value={\`\${(s.totalTokens / 1000).toFixed(0)}k\`} />
        <Stat label="总成本" value={fmtUSD(s.totalCostUsd)} />
        <Stat
          label="红灯（tool/mcp）"
          value={\`\${s.redToolCount} / \${s.redMcpCount}\`}
          tone={s.redToolCount + s.redMcpCount === 0 ? "success" : "danger"}
        />
      </Row>

      {s.redToolCount + s.redMcpCount > 0 ? (
        <Callout tone="danger" title={\`本轮发现 \${s.redToolCount} 个工具 + \${s.redMcpCount} 个 MCP server 处于红灯状态\`}>
          下方"H-Tools"/"H-MCP"表里的红色标记是优先修复对象——sandbox_blocked、circuit_open、成功率 &lt; 90% 都会触发红灯。
        </Callout>
      ) : null}

      <Card>
        <CardHeader title="H-Tools · 工具调用矩阵（top 15，按调用次数倒序）" />
        <CardBody style={{ padding: 0 }}>
          <Table
            columns={[
              { key: "health", header: "健康", width: 50, align: "center" },
              { key: "name", header: "工具", width: 200 },
              { key: "kind", header: "kind", width: 80 },
              { key: "calls", header: "调用", width: 60, align: "right" },
              { key: "ok", header: "成功率", width: 70, align: "right" },
              { key: "avg", header: "avg lat", width: 80, align: "right" },
              { key: "p95", header: "p95 lat", width: 80, align: "right" },
              { key: "sbx", header: "sandbox", width: 70, align: "right" },
              { key: "err", header: "top error", width: 250 },
            ]}
            rows={DATA.tools.map((t) => ({
              key: \`\${t.toolKind}::\${t.toolName}\`,
              health: <Pill tone={gradeTone(t.healthGrade)} size="sm">{gradeLabel(t.healthGrade)}</Pill>,
              name: <Text mono size="sm">{t.toolName}</Text>,
              kind: t.toolKind,
              calls: t.totalCalls,
              ok: fmtPct(t.successRate),
              avg: fmtMs(t.avgLatencyMs),
              p95: fmtMs(t.p95LatencyMs),
              sbx: t.sandboxBlockedCount > 0 ? <Pill tone="danger" size="sm">{t.sandboxBlockedCount}</Pill> : 0,
              err: t.topErrors[0]?.message ? <Text size="xs" style={{ color: theme.fgMuted }}>{t.topErrors[0].message}</Text> : <Text size="xs" style={{ color: theme.fgMuted }}>—</Text>,
            }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="H-MCP · MCP server 健康度" />
        <CardBody style={{ padding: 0 }}>
          <Table
            columns={[
              { key: "h", header: "健康", width: 50, align: "center" },
              { key: "s", header: "server", width: 200 },
              { key: "calls", header: "调用", width: 60, align: "right" },
              { key: "ok", header: "成功", width: 60, align: "right" },
              { key: "fail", header: "失败", width: 60, align: "right" },
              { key: "to", header: "超时", width: 60, align: "right" },
              { key: "sbx", header: "sandbox", width: 70, align: "right" },
              { key: "co", header: "circuit_open", width: 100, align: "right" },
              { key: "avg", header: "avg lat", width: 80, align: "right" },
            ]}
            rows={DATA.mcp.map((m) => ({
              key: m.serverName,
              h: <Pill tone={gradeTone(m.healthGrade)} size="sm">{gradeLabel(m.healthGrade)}</Pill>,
              s: <Text mono size="sm">{m.serverName}</Text>,
              calls: m.totalCalls,
              ok: m.successCount,
              fail: m.failedCount,
              to: m.timeoutCount,
              sbx: m.sandboxBlockedCount,
              co: m.circuitOpenCount > 0 ? <Pill tone="danger" size="sm">{m.circuitOpenCount}</Pill> : 0,
              avg: fmtMs(m.avgLatencyMs),
            }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="H-LLM · Token 消耗与成本（按总 token 倒序）" />
        <CardBody style={{ padding: 0 }}>
          <Table
            columns={[
              { key: "m", header: "provider/model", width: 220 },
              { key: "c", header: "调用", width: 60, align: "right" },
              { key: "ok", header: "success", width: 70, align: "right" },
              { key: "fb", header: "fallback", width: 70, align: "right" },
              { key: "err", header: "error", width: 60, align: "right" },
              { key: "pt", header: "prompt", width: 70, align: "right" },
              { key: "ct", header: "completion", width: 90, align: "right" },
              { key: "tt", header: "total", width: 70, align: "right" },
              { key: "cost", header: "USD", width: 70, align: "right" },
              { key: "avg", header: "avg/call", width: 80, align: "right" },
              { key: "p95", header: "p95/call", width: 80, align: "right" },
              { key: "tr", header: "截断率", width: 70, align: "right" },
            ]}
            rows={DATA.llm.map((l) => ({
              key: \`\${l.provider}/\${l.model}\`,
              m: <Text mono size="sm">{l.provider}/{l.model}</Text>,
              c: l.totalCalls,
              ok: l.successCount,
              fb: l.fallbackCount > 0 ? <Pill tone="warning" size="sm">{l.fallbackCount}</Pill> : 0,
              err: l.errorCount > 0 ? <Pill tone="danger" size="sm">{l.errorCount}</Pill> : 0,
              pt: \`\${(l.totalPromptTokens / 1000).toFixed(0)}k\`,
              ct: \`\${(l.totalCompletionTokens / 1000).toFixed(0)}k\`,
              tt: \`\${(l.totalTokens / 1000).toFixed(0)}k\`,
              cost: fmtUSD(l.totalCostUsd),
              avg: fmtTokens(l.avgTokensPerCall),
              p95: fmtTokens(l.p95TokensPerCall),
              tr: l.truncationRate > 0.05
                ? <Pill tone="warning" size="sm">{fmtPct(l.truncationRate)}</Pill>
                : fmtPct(l.truncationRate),
            }))}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="H-Skill · Skill 召回与执行率（top 15）" />
        <CardBody style={{ padding: 0 }}>
          {DATA.skills.length === 0 ? (
            <Text size="sm" style={{ color: theme.fgMuted, padding: 12 }}>本轮评测未触发 skill 召回。</Text>
          ) : (
            <Table
              columns={[
                { key: "s", header: "skill", width: 280 },
                { key: "r", header: "召回", width: 70, align: "right" },
                { key: "e", header: "执行", width: 70, align: "right" },
                { key: "er", header: "执行率", width: 80, align: "right" },
                { key: "sc", header: "avg score", width: 90, align: "right" },
              ]}
              rows={DATA.skills.map((s) => ({
                key: s.skillId,
                s: <Text mono size="sm">{s.skillId}</Text>,
                r: s.recallCount,
                e: s.executedCount,
                er: fmtPct(s.executedRate),
                sc: s.avgScore !== null ? s.avgScore.toFixed(2) : "—",
              }))}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="H-Errors · 错误聚合（top 10 patterns）" />
        <CardBody style={{ padding: 0 }}>
          {DATA.errors.length === 0 ? (
            <Text size="sm" style={{ color: theme.fgMuted, padding: 12 }}>本轮评测未发现需要聚合的错误。</Text>
          ) : (
            <Table
              columns={[
                { key: "src", header: "来源", width: 60 },
                { key: "n", header: "次数", width: 60, align: "right" },
                { key: "p", header: "pattern", width: 400 },
                { key: "ex", header: "示例", width: 400 },
              ]}
              rows={DATA.errors.map((e, i) => ({
                key: \`\${e.source}-\${i}\`,
                src: <Pill tone={e.source === "tool" ? "neutral" : e.source === "mcp" ? "warning" : "danger"} size="sm">{e.source}</Pill>,
                n: e.count,
                p: <Text mono size="xs">{e.pattern}</Text>,
                ex: <Text size="xs" style={{ color: theme.fgMuted }}>{e.examples[0] ?? "—"}</Text>,
              }))}
            />
          )}
        </CardBody>
      </Card>

      <H2>下一步建议</H2>
      <Stack gap={6}>
        <Text size="sm" style={{ color: theme.fgMuted }}>
          • 红灯 tool / mcp 优先修：看"top error" 列定位症状，搜对应 trace 看上下文。
        </Text>
        <Text size="sm" style={{ color: theme.fgMuted }}>
          • LLM 截断率 &gt; 5%：提高 max_tokens 或者拆分 prompt；C-3 token p95 超 32k 也属于该类。
        </Text>
        <Text size="sm" style={{ color: theme.fgMuted }}>
          • Skill 执行率 &lt; 30%：召回质量或工具 gating 有问题；从 scope_id × skill_id 维度去 skill_recall_log 看。
        </Text>
      </Stack>
    </Stack>
  );
}
`;
}
