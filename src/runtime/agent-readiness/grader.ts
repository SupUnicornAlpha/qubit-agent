/**
 * 健康度打分：把 SnapshotCollector 抓出来的指标值转成绿/黄/红 + 整体 A-F。
 *
 * 纯函数，不接触 DB / 文件系统，方便快速迭代阈值。
 *
 * v2 升级（2026-06-08）：
 *   - 主聚合走 AQM 加权（A=40%/B=30%/C=20%/D=10%）
 *   - LEGACY 6 指标仍出现在 metricGrades，但不进入主聚合
 *   - 新增 categoryScores 字段，让 reporter 渲染分类汇总表
 */

import {
  AQM_THRESHOLDS,
  aggregateAqm,
  type MetricGrade,
  type OverallGrade,
} from "./thresholds";

/** Reporter 消费的标准 snapshot 形态 */
export interface ReadinessSnapshot {
  workflowRunId: string;
  scenario: string;
  capturedAt: string;
  /** 工作流终态：completed / failed / timeout / cancelled / running */
  workflowStatus: string;
  /** 指标 ID → 实测值；包含 AQM 16 + LEGACY 6 */
  metrics: Record<string, number | null>;
  /** 可选 quality details，用于 reporter 渲染明细（无破坏地添加） */
  quality?: {
    content?: unknown;
    tools?: unknown;
    llm?: unknown;
    orchestration?: unknown;
    judge?: unknown;
  };
}

export interface SnapshotGrade {
  workflowRunId: string;
  scenario: string;
  overall: OverallGrade;
  /** AQM 加权总分（0-1） */
  weightedScore: number;
  /** 各类分数（A/B/C/D），null 表示该类无指标可评 */
  categoryScores: Record<"A" | "B" | "C" | "D", number | null>;
  metricGrades: Record<string, MetricGrade | null>;
  metricDescriptions: Record<string, string>;
  metricValues: Record<string, number | null>;
  metricCategories: Record<string, "A" | "B" | "C" | "D" | "LEGACY">;
}

export function gradeSnapshot(snapshot: ReadinessSnapshot): SnapshotGrade {
  const metricGrades: Record<string, MetricGrade | null> = {};
  const metricDescriptions: Record<string, string> = {};
  const metricValues: Record<string, number | null> = {};
  const metricCategories: Record<string, "A" | "B" | "C" | "D" | "LEGACY"> = {};

  for (const [id, threshold] of Object.entries(AQM_THRESHOLDS)) {
    const value = snapshot.metrics[id] ?? null;
    metricDescriptions[id] = threshold.description;
    metricValues[id] = value;
    metricCategories[id] = threshold.category;
    if (value === null || value === undefined) {
      // 缺值用 nullGrade 决定；默认不计入
      metricGrades[id] = threshold.nullGrade ?? null;
    } else {
      metricGrades[id] = threshold.grade(value);
    }
  }

  const aqm = aggregateAqm({ metricGrades });

  return {
    workflowRunId: snapshot.workflowRunId,
    scenario: snapshot.scenario,
    overall: aqm.overall,
    weightedScore: aqm.weightedScore,
    categoryScores: aqm.categoryScores,
    metricGrades,
    metricDescriptions,
    metricValues,
    metricCategories,
  };
}
