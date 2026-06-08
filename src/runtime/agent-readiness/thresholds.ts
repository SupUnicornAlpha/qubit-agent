/**
 * Agent 五场景就绪度评估的健康度阈值。
 *
 * 设计要点：
 *   - 阈值独立成文件，方便基于真实数据校准（draft 阶段，跑 1-2 轮后调整）。
 *   - 6 个 must-have 指标对应 P0 范围（见 docs/superpowers/specs/2026-06-05-agent-readiness-runner-design.md §2）。
 *   - 其它指标（O-2 ~ E-1）保留接口，P1 阶段补全。
 *
 * 命名规则：
 *   - O-* 编排（Orchestration）
 *   - T-* 工具 / MCP / Exec（Tool）
 *   - S-* / M-* / E-* Skills / Memory / Evolution
 */

/** 单个指标的健康判定结果 */
export type MetricGrade = "green" | "yellow" | "red";

/** 阈值定义：直接给可读的判定函数（避免 enum-of-numbers 容易翻译错） */
export interface MetricThreshold {
  metricId: string;
  description: string;
  /** 输入实测值，输出绿/黄/红 */
  grade: (value: number | null | undefined) => MetricGrade;
}

/**
 * 6 个 P0 must-have 指标的阈值。
 *
 * P1 阶段会补齐余下 13 个（O-2/3/4/5、T-2/4/5/7、S-2/3、M-2、E-1）。
 */
export const MUST_HAVE_THRESHOLDS: Record<string, MetricThreshold> = {
  // ── O-1：工作流终态分布 ────────────────────────────────────────────────
  "O-1": {
    metricId: "O-1",
    description: "工作流是否跑到 completed（vs failed / timeout / cancelled）",
    grade: (completedRatio) => {
      const v = completedRatio ?? 0;
      if (v >= 0.8) return "green";
      if (v >= 0.5) return "yellow";
      return "red";
    },
  },

  // ── T-1：tool_call 失败率 ────────────────────────────────────────────
  "T-1": {
    metricId: "T-1",
    description: "tool_call_log 中 status=error 的占比",
    grade: (errorRate) => {
      const v = errorRate ?? 0;
      if (v <= 0.05) return "green";
      if (v <= 0.15) return "yellow";
      return "red";
    },
  },

  // ── T-3：MCP 熔断 open 比例 ──────────────────────────────────────────
  "T-3": {
    metricId: "T-3",
    description: "mcp_call_log.circuit_state = open 的比例",
    grade: (openRatio) => {
      const v = openRatio ?? 0;
      if (v <= 0.01) return "green";
      if (v <= 0.1) return "yellow";
      return "red";
    },
  },

  // ── T-6：单工作流 LLM token 消耗 ─────────────────────────────────────
  "T-6": {
    metricId: "T-6",
    description: "单工作流 llm_call_log token_total 总消耗（输入+输出）",
    grade: (tokensTotal) => {
      const v = tokensTotal ?? 0;
      if (v <= 200_000) return "green";
      if (v <= 1_000_000) return "yellow";
      return "red";
    },
  },

  // ── S-1：skill 召回 → 真正执行的占比 ─────────────────────────────────
  "S-1": {
    metricId: "S-1",
    description: "skill_recall_log.executed = 1 的占比（召回但没用 ≠ 健康）",
    grade: (executedRatio) => {
      const v = executedRatio ?? 0;
      if (v >= 0.3) return "green";
      if (v >= 0.05) return "yellow";
      return "red";
    },
  },

  // ── M-1：本工作流是否写入了长期记忆 ──────────────────────────────────
  "M-1": {
    metricId: "M-1",
    description: "longterm_memory 在本工作流期间至少写入 1 条",
    grade: (longtermWriteCount) => {
      const v = longtermWriteCount ?? 0;
      if (v >= 1) return "green";
      // 这条没有 yellow：要么写了要么没写
      return "red";
    },
  },
};

/** 整体打分：把单指标等级聚合成 A-F */
export type OverallGrade = "A" | "B" | "C" | "D" | "F";

/**
 * 聚合规则（保守 + 可解释）：
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
