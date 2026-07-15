/**
 * Agent 五场景就绪度评估的健康度阈值。
 *
 * 设计要点：
 *   - 阈值独立成文件，方便基于真实数据校准（draft 阶段，跑 1-2 轮后调整）。
 *   - 原 6 个 must-have 指标保留为兼容（O-1 / T-1 / T-3 / T-6 / S-1 / M-1）。
 *   - 新 16 个 AQM 指标按 A/B/C/D 类组织（详见 docs/superpowers/specs/2026-06-08-agent-quality-metrics.md）。
 *
 * 命名规则：
 *   - 旧：O-* / T-* / S-* / M-*  → 保留兼容（标 LEGACY，grader 可忽略）
 *   - 新：A-* / B-* / C-* / D-*  → AQM 主指标
 */

/** 单个指标的健康判定结果 */
export type MetricGrade = "green" | "yellow" | "red";

/** 阈值定义：直接给可读的判定函数（避免 enum-of-numbers 容易翻译错） */
export interface MetricThreshold {
  metricId: string;
  description: string;
  /** 输入实测值，输出绿/黄/红 */
  grade: (value: number | null | undefined) => MetricGrade;
  /** 缺值（无法判定）时的等级；默认 null → 不计入聚合 */
  nullGrade?: MetricGrade | null;
  /** 指标类别：A=内容、B=工具/Skill、C=LLM、D=编排、LEGACY=旧 6 兼容 */
  category: "A" | "B" | "C" | "D" | "LEGACY";
}

/** 渐进比例阈值生成器（>=greenAt → green，>=yellowAt → yellow，否则 red） */
function gtRatio(greenAt: number, yellowAt: number): MetricThreshold["grade"] {
  return (v) => {
    const x = v ?? 0;
    if (x >= greenAt) return "green";
    if (x >= yellowAt) return "yellow";
    return "red";
  };
}

/** 反向比例阈值（值越小越好；<=greenAt → green） */
function ltRatio(greenAt: number, yellowAt: number): MetricThreshold["grade"] {
  return (v) => {
    const x = v ?? 0;
    if (x <= greenAt) return "green";
    if (x <= yellowAt) return "yellow";
    return "red";
  };
}

/**
 * 16 个 AQM 指标 + 旧 6 兼容指标的阈值。
 */
export const AQM_THRESHOLDS: Record<string, MetricThreshold> = {
  // ── A 类 · 内容质量 ───────────────────────────────────────────────────
  "A-1": {
    metricId: "A-1",
    description: "产物完整性：必备 artifact 表非空比例",
    grade: gtRatio(1.0, 0.5),
    category: "A",
  },
  "A-2": {
    metricId: "A-2",
    description: "内容相关性：goal 关键词在产物字段中的命中率",
    grade: gtRatio(0.6, 0.3),
    category: "A",
  },
  "A-3": {
    metricId: "A-3",
    description: "内容专业度：LLM-as-Judge 1-5 分均值",
    grade: gtRatio(3.5, 2.5),
    nullGrade: null,
    category: "A",
  },
  "A-4": {
    metricId: "A-4",
    description: "内部一致性：strategy/order/fusion 引用合法率",
    grade: gtRatio(0.95, 0.7),
    nullGrade: null,
    category: "A",
  },
  "A-5": {
    metricId: "A-5",
    description: "效果质量门：IC/RankIC、回测、推荐快照等场景质量 gate 通过率",
    grade: gtRatio(1.0, 0.5),
    nullGrade: null,
    category: "A",
  },

  // ── B 类 · 工具/Skill 调用质量 ────────────────────────────────────────
  "B-1": {
    metricId: "B-1",
    description: "必备工具召回率",
    grade: gtRatio(1.0, 0.6),
    category: "B",
  },
  "B-2": {
    metricId: "B-2",
    description: "参数合理性比例（1 - 异常率）",
    grade: gtRatio(0.98, 0.9),
    category: "B",
  },
  "B-3": {
    metricId: "B-3",
    description: "工具失败率（含 timeout / sandbox_blocked）",
    grade: ltRatio(0.05, 0.15),
    category: "B",
  },
  "B-7": {
    metricId: "B-7",
    description: "单(toolName,request) 最大重复次数（绿 ≤2）",
    grade: ltRatio(2, 4),
    category: "B",
  },

  // ── C 类 · LLM 调用质量与适配 ─────────────────────────────────────────
  "C-1": {
    metricId: "C-1",
    description: "LLM 调用成功率（含 fallback）",
    grade: gtRatio(0.99, 0.95),
    nullGrade: null,
    category: "C",
  },
  "C-2": {
    metricId: "C-2",
    description: "LLM 主路径失败比例（error+timeout+fallback）",
    grade: ltRatio(0.05, 0.2),
    nullGrade: null,
    category: "C",
  },
  "C-3-total": {
    metricId: "C-3-total",
    description: "单工作流 LLM token 总消耗",
    grade: ltRatio(200_000, 1_000_000),
    category: "C",
  },
  "C-3-p95": {
    metricId: "C-3-p95",
    description: "单次 LLM 调用 p95 token 消耗",
    grade: ltRatio(32_000, 64_000),
    nullGrade: null,
    category: "C",
  },
  "C-5": {
    metricId: "C-5",
    description: "LLM 输出截断率（length / max_tokens / incomplete）",
    grade: ltRatio(0.01, 0.05),
    nullGrade: null,
    category: "C",
  },

  // ── D 类 · 编排质量 ──────────────────────────────────────────────────
  "D-1": {
    metricId: "D-1",
    description: "工作流终态分布（completed=1，否则 0）",
    grade: gtRatio(0.99, 0.5),
    category: "D",
  },
  "D-2": {
    metricId: "D-2",
    description: "步数效率：max(step_index)+1 / max_iterations，越低越好",
    grade: ltRatio(0.7, 1.0),
    nullGrade: null,
    category: "D",
  },
  "D-3": {
    metricId: "D-3",
    description: "reason+act 时间占比",
    grade: gtRatio(0.6, 0.4),
    nullGrade: null,
    category: "D",
  },
  "D-4": {
    metricId: "D-4",
    description: "内部终态回答：orchestrator 是否产出非空 answerText",
    grade: gtRatio(1.0, 0.5),
    category: "D",
  },
  "D-5": {
    metricId: "D-5",
    description: "用户回复投影：最终回答是否写入关联的 assistant chat_message",
    grade: gtRatio(1.0, 0.5),
    category: "D",
  },

  // ── LEGACY · 原 6 兼容（grader 不计入主聚合，仍保留出现在 reporter） ──
  "O-1": {
    metricId: "O-1",
    description: "[LEGACY] 工作流是否 completed",
    grade: gtRatio(0.99, 0.5),
    category: "LEGACY",
  },
  "T-1": {
    metricId: "T-1",
    description: "[LEGACY] tool_call_log error 比例",
    grade: ltRatio(0.05, 0.15),
    category: "LEGACY",
  },
  "T-3": {
    metricId: "T-3",
    description: "[LEGACY] mcp_call_log circuit_state=open 比例",
    grade: ltRatio(0.01, 0.1),
    category: "LEGACY",
  },
  "T-6": {
    metricId: "T-6",
    description: "[LEGACY] 单工作流 token 总消耗",
    grade: ltRatio(200_000, 1_000_000),
    category: "LEGACY",
  },
  "S-1": {
    metricId: "S-1",
    description: "[LEGACY] skill 召回 → 执行率",
    grade: gtRatio(0.3, 0.05),
    nullGrade: null,
    category: "LEGACY",
  },
  "M-1": {
    metricId: "M-1",
    description: "[LEGACY] 长期记忆写入条数",
    grade: (v) => ((v ?? 0) >= 1 ? "green" : "red"),
    category: "LEGACY",
  },
};

/** 兼容旧调用的 alias */
export const MUST_HAVE_THRESHOLDS: Record<string, MetricThreshold> =
  Object.fromEntries(
    Object.entries(AQM_THRESHOLDS).filter(([, t]) => t.category === "LEGACY")
  );

/** 整体打分：把单指标等级聚合成 A-F */
export type OverallGrade = "A" | "B" | "C" | "D" | "F";

/**
 * 默认聚合（保守 + 可解释）：
 *   - 任何红灯  → ≤ C
 *   - 半数红灯  → F
 *   - 仅黄灯    → B
 *   - 全绿      → A
 */
export function aggregateGrade(grades: MetricGrade[]): OverallGrade {
  if (grades.length === 0) return "F";
  const red = grades.filter((g) => g === "red").length;
  const yellow = grades.filter((g) => g === "yellow").length;
  const total = grades.length;

  if (red === 0 && yellow === 0) return "A";
  if (red === 0) return "B";
  if (red <= total / 4) return "C";
  if (red <= total / 2) return "D";
  return "F";
}

/**
 * AQM 加权聚合：A=40% / B=30% / C=20% / D=10%。
 *   - 单类内：grade → 分数（green=1, yellow=0.5, red=0），求平均
 *   - 跨类：按权重加权
 *   - 总分 → A-F：>=0.9=A, >=0.75=B, >=0.6=C, >=0.4=D, 否则 F
 */
export interface AqmAggregateInput {
  metricGrades: Record<string, MetricGrade | null>;
}

export interface AqmAggregateResult {
  overall: OverallGrade;
  weightedScore: number;
  /** 各类分数（已归一化到 [0,1]，null 表示该类无指标可评） */
  categoryScores: Record<"A" | "B" | "C" | "D", number | null>;
}

const CATEGORY_WEIGHTS = { A: 0.4, B: 0.3, C: 0.2, D: 0.1 } as const;

function gradeToNumber(g: MetricGrade): number {
  if (g === "green") return 1;
  if (g === "yellow") return 0.5;
  return 0;
}

export function aggregateAqm(input: AqmAggregateInput): AqmAggregateResult {
  const buckets: Record<"A" | "B" | "C" | "D", MetricGrade[]> = {
    A: [],
    B: [],
    C: [],
    D: [],
  };
  for (const [id, grade] of Object.entries(input.metricGrades)) {
    if (!grade) continue;
    const t = AQM_THRESHOLDS[id];
    if (!t) continue;
    if (t.category === "LEGACY") continue;
    buckets[t.category].push(grade);
  }
  const categoryScores: Record<"A" | "B" | "C" | "D", number | null> = {
    A: null,
    B: null,
    C: null,
    D: null,
  };
  let totalWeight = 0;
  let totalScore = 0;
  let anyYellow = false;
  let anyRed = false;
  let halfPlusRed = false;
  let allMetrics = 0;
  let totalRed = 0;
  for (const [cat, grades] of Object.entries(buckets) as Array<
    [keyof typeof buckets, MetricGrade[]]
  >) {
    if (!grades.length) continue;
    const avg = grades.reduce((acc, g) => acc + gradeToNumber(g), 0) / grades.length;
    categoryScores[cat] = Number(avg.toFixed(3));
    const w = CATEGORY_WEIGHTS[cat];
    totalWeight += w;
    totalScore += avg * w;
    for (const g of grades) {
      allMetrics++;
      if (g === "yellow") anyYellow = true;
      if (g === "red") {
        anyRed = true;
        totalRed++;
      }
    }
  }
  if (allMetrics > 0 && totalRed > allMetrics / 2) halfPlusRed = true;
  const weightedScore =
    totalWeight === 0 ? 0 : Number((totalScore / totalWeight).toFixed(3));

  // 等级规则：先看 grade 分布的硬约束
  //   - 全绿 → A
  //   - 无红 (有黄) → B
  //   - 红比 ≤ 10%   → C
  //   - 红比 ≤ 50%   → D
  //   - 红比 > 50%   → F
  let overall: OverallGrade;
  if (!anyRed && !anyYellow && allMetrics > 0) overall = "A";
  else if (!anyRed && allMetrics > 0) overall = "B";
  else if (allMetrics === 0) overall = "F"; // 没任何指标可评
  else if (halfPlusRed) overall = "F";
  else if (totalRed / allMetrics <= 0.1) overall = "C";
  else overall = "D";

  return { overall, weightedScore, categoryScores };
}
