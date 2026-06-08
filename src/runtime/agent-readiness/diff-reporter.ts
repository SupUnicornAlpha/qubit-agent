/**
 * diff-reporter：两份 snapshot JSON 的差异 Markdown。
 *
 * 用途：
 *   - 调优时跑 baseline → 改一处 → 再跑 → diff 看哪些指标真的动了
 *   - 长期回归：每次 release 跑一份，归档；和上 release 做 diff
 *
 * 输入是 renderJsonReport 的 schema（{ schemaVersion, snapshot, grade }），
 * 但只用 snapshot —— grade 在 diff 时按当前 thresholds 重新算，避免阈值改了之后历史 grade 不可比。
 */

import { gradeSnapshot, type ReadinessSnapshot } from "./grader";
import type { MetricGrade } from "./thresholds";

export interface SnapshotJson {
  schemaVersion: string;
  snapshot: ReadinessSnapshot;
}

export interface DiffSnapshotPair {
  base: SnapshotJson;
  target: SnapshotJson;
}

const ICON: Record<MetricGrade, string> = {
  green: "✅",
  yellow: "⚠️",
  red: "❌",
};

function gradeIcon(g: MetricGrade | null | undefined): string {
  if (!g) return "—";
  return ICON[g];
}
function gradeText(g: MetricGrade | null | undefined): string {
  return g ?? "n/a";
}

/** v2 顺序：AQM 主指标在前，LEGACY 在后 */
const METRIC_ORDER = [
  "A-1", "A-2", "A-3", "A-4",
  "B-1", "B-2", "B-3", "B-7",
  "C-1", "C-2", "C-3-total", "C-3-p95", "C-5",
  "D-1", "D-2", "D-3",
  "O-1", "T-1", "T-3", "T-6", "S-1", "M-1",
];

export function renderDiffMarkdown(pair: DiffSnapshotPair): string {
  const baseGrade = gradeSnapshot(pair.base.snapshot);
  const targetGrade = gradeSnapshot(pair.target.snapshot);
  const lines: string[] = [];

  lines.push("# Agent Readiness Diff Report");
  lines.push("");
  lines.push(`- base:   \`${pair.base.snapshot.workflowRunId}\` · ${pair.base.snapshot.scenario}`);
  lines.push(`- target: \`${pair.target.snapshot.workflowRunId}\` · ${pair.target.snapshot.scenario}`);
  lines.push("");
  lines.push(`总分：**${baseGrade.overall}** → **${targetGrade.overall}**`);
  lines.push("");

  let anyChange = false;
  lines.push("| 指标 | base | target | Δ | grade base→target |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const id of METRIC_ORDER) {
    const bv = pair.base.snapshot.metrics[id] ?? null;
    const tv = pair.target.snapshot.metrics[id] ?? null;
    const bg = baseGrade.metricGrades[id] ?? null;
    const tg = targetGrade.metricGrades[id] ?? null;
    const delta = formatDelta(bv, tv);
    const changed = delta !== "";
    if (changed || bg !== tg) anyChange = true;
    lines.push(
      `| ${id} | ${formatValue(bv)} | ${formatValue(tv)} | ${delta || "·"} | ${gradeIcon(bg)} ${gradeText(bg)} → ${gradeIcon(tg)} ${gradeText(tg)} |`
    );
  }
  lines.push("");

  if (!anyChange) {
    lines.push("> 无变化 (no changes)");
    lines.push("");
  } else {
    lines.push("## 变化解读");
    lines.push("");
    for (const id of METRIC_ORDER) {
      const bv = pair.base.snapshot.metrics[id] ?? null;
      const tv = pair.target.snapshot.metrics[id] ?? null;
      const bg = baseGrade.metricGrades[id] ?? null;
      const tg = targetGrade.metricGrades[id] ?? null;
      if (formatDelta(bv, tv) === "" && bg === tg) continue;
      lines.push(`- **${id}**：${interpret(id, bv, tv, bg, tg)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatValue(value: number | null): string {
  if (value === null || value === undefined) return "n/a";
  if (Number.isInteger(value)) return String(value);
  if (value > -1.0001 && value < 1.0001) return (value * 100).toFixed(1) + "%";
  return value.toFixed(2);
}

function formatDelta(b: number | null, t: number | null): string {
  if (b === null && t === null) return "";
  if (b === t) return "";
  if (b === null) return `↑ from n/a`;
  if (t === null) return `↓ to n/a`;
  if (t > b) return `↑ +${formatNumber(t - b)}`;
  if (t < b) return `↓ ${formatNumber(t - b)}`;
  return "";
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

function interpret(
  id: string,
  bv: number | null,
  tv: number | null,
  bg: MetricGrade | null,
  tg: MetricGrade | null
): string {
  const direction =
    bv === null || tv === null
      ? `${formatValue(bv)} → ${formatValue(tv)}`
      : tv > bv
        ? "上升"
        : tv < bv
          ? "下降"
          : "持平";
  const gradeShift = bg === tg ? "等级未变" : `等级 ${gradeText(bg)} → ${gradeText(tg)}`;
  return `${formatValue(bv)} → ${formatValue(tv)}（${direction}），${gradeShift}`;
}
