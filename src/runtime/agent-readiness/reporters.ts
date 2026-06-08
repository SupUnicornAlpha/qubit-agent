/**
 * Reporters：把 snapshot + grade 渲染成机器可读 (JSON) 与人读 (Markdown) 文本。
 *
 * 设计原则：
 *   - 纯函数；不接 IO，方便 fork-test 和 diff 工具复用。
 *   - JSON 输出版本号字段 (`schemaVersion`)，将来 P1 加指标不破坏既有消费者。
 *   - Markdown 输出每个指标用 ✅ / ⚠️ / ❌ 视觉化，并按 A/B/C/D 类分块。
 *
 * v2（2026-06-08）：
 *   - schemaVersion 提到 2.0；保留 1.0 数据可读
 *   - 按类别分组：A 内容 / B 工具 / C LLM / D 编排 / LEGACY 兼容
 *   - 总分换成 AQM 加权 + 总等级 + 各类小分
 *   - 红灯指标的下一步建议覆盖到所有 16 个指标
 */

import type { ReadinessSnapshot, SnapshotGrade } from "./grader";
import { gradeSnapshot } from "./grader";
import type { MetricGrade } from "./thresholds";

const SCHEMA_VERSION = "2.0";

const GRADE_ICON: Record<MetricGrade, string> = {
  green: "✅",
  yellow: "⚠️",
  red: "❌",
};

interface CategoryView {
  title: string;
  metrics: ReadonlyArray<string>;
}

const CATEGORY_VIEWS: Record<"A" | "B" | "C" | "D" | "LEGACY", CategoryView> = {
  A: { title: "A 类 · 内容质量", metrics: ["A-1", "A-2", "A-3", "A-4"] },
  B: { title: "B 类 · 工具/Skill 调用质量", metrics: ["B-1", "B-2", "B-3", "B-7"] },
  C: {
    title: "C 类 · LLM 调用质量",
    metrics: ["C-1", "C-2", "C-3-total", "C-3-p95", "C-5"],
  },
  D: { title: "D 类 · 编排质量", metrics: ["D-1", "D-2", "D-3"] },
  LEGACY: { title: "LEGACY · 旧 6 指标兼容", metrics: ["O-1", "T-1", "T-3", "T-6", "S-1", "M-1"] },
};

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
  lines.push(`- **总分（AQM）**：${grade.overall}（加权得分 ${grade.weightedScore}）`);
  lines.push("");
  lines.push("## 各类小分");
  lines.push("");
  lines.push("| 类别 | 权重 | 分数 |");
  lines.push("| --- | --- | --- |");
  lines.push(`| A 内容质量 | 40% | ${formatScore(grade.categoryScores.A)} |`);
  lines.push(`| B 工具/Skill 调用 | 30% | ${formatScore(grade.categoryScores.B)} |`);
  lines.push(`| C LLM 调用 | 20% | ${formatScore(grade.categoryScores.C)} |`);
  lines.push(`| D 编排 | 10% | ${formatScore(grade.categoryScores.D)} |`);
  lines.push("");

  for (const cat of ["A", "B", "C", "D", "LEGACY"] as const) {
    const view = CATEGORY_VIEWS[cat];
    lines.push(`## ${view.title}`);
    lines.push("");
    lines.push("| 指标 | 值 | 等级 | 描述 |");
    lines.push("| --- | --- | --- | --- |");
    for (const id of view.metrics) {
      const g = grade.metricGrades[id];
      const value = grade.metricValues[id];
      const desc = grade.metricDescriptions[id] ?? "";
      const icon = g ? GRADE_ICON[g] : "—";
      const gradeText = g ?? "n/a";
      lines.push(
        `| ${id} | ${formatValue(id, value)} | ${icon} ${gradeText} | ${desc} |`
      );
    }
    lines.push("");
  }

  // Judge 详情（如果有）
  const judgeDetail = (snapshot.quality?.judge ?? null) as
    | { judged?: Array<{ kind: string; identifier: string; score: { overall: number; issues: string[] } }>; failed?: unknown[] }
    | null;
  if (judgeDetail && Array.isArray(judgeDetail.judged) && judgeDetail.judged.length) {
    lines.push("## A-3 LLM-as-Judge 评分明细");
    lines.push("");
    lines.push("| 产物 | overall | issues |");
    lines.push("| --- | --- | --- |");
    for (const j of judgeDetail.judged) {
      const issues = (j.score.issues ?? []).join("; ");
      lines.push(
        `| ${j.kind} \`${j.identifier.slice(0, 8)}\` | ${j.score.overall.toFixed(1)} | ${issues || "—"} |`
      );
    }
    lines.push("");
  }

  // 红灯指标的 next-step 提示（仅 AQM 主指标，不包含 LEGACY）
  const allMetrics = ["A", "B", "C", "D"].flatMap((c) => CATEGORY_VIEWS[c as "A"].metrics);
  const reds = allMetrics.filter((id) => grade.metricGrades[id] === "red");
  lines.push("## 下一步建议");
  lines.push("");
  if (reds.length === 0) {
    lines.push("- AQM 主指标无红灯，建议关注黄灯项 + 跨场景 diff。");
  } else {
    for (const id of reds) {
      lines.push(`- **${id}**：${suggestForRed(id)}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function formatValue(id: string, value: number | null): string {
  if (value === null || value === undefined) return "n/a";
  // token 类不格式化为百分比
  if (id === "T-6" || id === "C-3-total" || id === "C-3-p95" || id === "M-1" || id === "B-7") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(2);
  }
  // A-3 是 1-5 分数
  if (id === "A-3") return value.toFixed(2);
  // D-2 是 0-1 比例
  if (Number.isInteger(value)) return String(value);
  if (value > -1.0001 && value < 1.0001) {
    return (value * 100).toFixed(1) + "%";
  }
  return value.toFixed(2);
}

function formatScore(s: number | null): string {
  if (s === null || s === undefined) return "n/a";
  return (s * 100).toFixed(1) + "%";
}

function suggestForRed(id: string): string {
  const tips: Record<string, string> = {
    "A-1": "必备产物表为空——Agent 没真正落库；检查 reason → act → 落库链路是否被早退（respond_final 直接走捷径）。",
    "A-2": "产物字段未提及 goal 关键词；可能 Agent 根本没解析 goal，或在不同 ticker 上跑。",
    "A-3": "LLM judge 给低分；查看 'A-3 评分明细' issues，再回头改 prompt / 工具链。",
    "A-4": "产物之间引用断开（strategy 引用了不存在的 factor / order 引用了不存在的 strategy）；说明产物落库不一致。",
    "B-1": "必备工具未被调用；可能 prompt 没暴露工具描述、或 reason 节点没把工具列表给 LLM。",
    "B-2": "调用参数异常（qty<=0 / NaN / 非法日期）；加严工具入参 schema 校验。",
    "B-3": "工具失败率过高，看 tool_call_log error_message 聚类，常见是参数 schema 校验或资源未就绪。",
    "B-7": "同一(toolName,request) 重复调用 ≥5 次；Agent 进了死循环，检查 dispatcher 去重。",
    "C-1": "LLM 调用成功率低；查 llm_call_log error_message 是否网关问题 / rate limit。",
    "C-2": "主路径失败比例高（含 fallback）；考虑提主模型超时/重试 / 模型容量是否合适。",
    "C-3-total": "token 消耗过大，考虑收敛 system prompt / 增加 cached_tokens 命中 / 减少不必要的工具枚举。",
    "C-3-p95": "单次调用 token 太大，可能 prompt 塞爆；做 prompt 长度上限。",
    "C-5": "LLM 输出截断率高，check max_tokens / prompt 是否要求过长。",
    "D-1": "工作流没跑到 completed，先去 agent_step / workflow_run 查 lastError 与卡住的 phase。",
    "D-2": "步数触顶（max_iterations）；说明 ReAct 没收敛，可能要加 reflection 或缩 reason 步骤。",
    "D-3": "reason+act 占比低，说明大量时间花在 observe/external，看是不是工具调用太慢。",
  };
  return tips[id] ?? "请人工检查对应指标的源数据。";
}
