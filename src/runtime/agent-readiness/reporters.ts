/**
 * Reporters：把 snapshot + grade 渲染成机器可读 (JSON) 与人读 (Markdown) 文本。
 *
 * 设计原则：
 *   - 纯函数；不接 IO，方便 fork-test 和 diff 工具复用。
 *   - JSON 输出版本号字段 (`schemaVersion`)，将来 P1 加指标不破坏既有消费者。
 *   - Markdown 输出每个指标用 ✅ / ⚠️ / ❌ 视觉化。
 */

import type { ReadinessSnapshot, SnapshotGrade } from "./grader";
import { gradeSnapshot } from "./grader";
import type { MetricGrade } from "./thresholds";

const SCHEMA_VERSION = "1.0";

const GRADE_ICON: Record<MetricGrade, string> = {
  green: "✅",
  yellow: "⚠️",
  red: "❌",
};

/** 指标在 markdown 表格中的展示顺序 */
const METRIC_ORDER = ["O-1", "T-1", "T-3", "T-6", "S-1", "M-1"];

export function renderJsonReport(snapshot: ReadinessSnapshot): string {
  const grade = gradeSnapshot(snapshot);
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      snapshot,
      grade,
    },
    null,
    2
  );
}

export function renderMarkdownReport(snapshot: ReadinessSnapshot): string {
  const grade = gradeSnapshot(snapshot);
  const lines: string[] = [];

  lines.push(`# Agent 就绪度报告 — ${snapshot.scenario}`);
  lines.push("");
  lines.push(`- 场景：\`${snapshot.scenario}\``);
  lines.push(`- workflowRunId：\`${snapshot.workflowRunId}\``);
  lines.push(`- 终态：\`${snapshot.workflowStatus}\``);
  lines.push(`- 抓取时间：${snapshot.capturedAt}`);
  lines.push(`- 总分：**${grade.overall}**`);
  lines.push("");

  lines.push("## 指标明细");
  lines.push("");
  lines.push("| 指标 | 值 | 等级 | 描述 |");
  lines.push("| --- | --- | --- | --- |");
  for (const id of METRIC_ORDER) {
    const g = grade.metricGrades[id] ?? "red";
    const value = grade.metricValues[id];
    const desc = grade.metricDescriptions[id] ?? "";
    const icon = GRADE_ICON[g];
    lines.push(`| ${id} | ${formatValue(value)} | ${icon} ${g} | ${desc} |`);
  }
  lines.push("");

  // 红灯指标的 next-step 提示
  const reds = METRIC_ORDER.filter((id) => grade.metricGrades[id] === "red");
  lines.push("## 下一步建议");
  lines.push("");
  if (reds.length === 0) {
    lines.push("- 当前没有红灯指标，建议把更多 P1 指标接入做更细粒度评估。");
  } else {
    for (const id of reds) {
      lines.push(`- **${id}**：${suggestForRed(id)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function formatValue(value: number | null): string {
  if (value === null || value === undefined) return "n/a";
  if (Number.isInteger(value)) return String(value);
  // 比例类指标按百分比展示
  if (value > -1.0001 && value < 1.0001) {
    return (value * 100).toFixed(1) + "%";
  }
  return value.toFixed(2);
}

function suggestForRed(id: string): string {
  switch (id) {
    case "O-1":
      return "工作流没跑到 completed，先去 agent_step / workflow_run 查 lastError 与卡住的 phase。";
    case "T-1":
      return "tool 失败率过高，看 tool_call_log error_message 聚类，常见是参数 schema 校验或资源未就绪。";
    case "T-3":
      return "MCP 触发熔断，检查目标服务是否 down 或限流配置过紧。";
    case "T-6":
      return "token 消耗过大，考虑收敛 system prompt / 增加 cached_tokens 命中 / 减少不必要的工具枚举。";
    case "S-1":
      return "skill 召回了但没被用上，检查 skill 的 description 是否对路，或 prompt 是否提示模型采纳。";
    case "M-1":
      return "工作流没向 longterm_memory 写入任何内容，确认 ResearchAgent / FactorAgent 的记忆落库链路是否被禁用。";
    default:
      return "请人工检查对应指标的源数据。";
  }
}
