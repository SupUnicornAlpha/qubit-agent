/**
 * 健康度打分：把 SnapshotCollector 抓出来的指标值转成绿/黄/红 + 整体 A-F。
 *
 * 纯函数，不接触 DB / 文件系统，方便快速迭代阈值。
 */

import {
  aggregateGrade,
  MUST_HAVE_THRESHOLDS,
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
  /** 指标 ID → 实测值；6 个 must-have 必填，其它指标 P1 后扩展 */
  metrics: Record<string, number | null>;
}

export interface SnapshotGrade {
  workflowRunId: string;
  scenario: string;
  overall: OverallGrade;
  metricGrades: Record<string, MetricGrade>;
  metricDescriptions: Record<string, string>;
  metricValues: Record<string, number | null>;
}

export function gradeSnapshot(snapshot: ReadinessSnapshot): SnapshotGrade {
  const metricGrades: Record<string, MetricGrade> = {};
  const metricDescriptions: Record<string, string> = {};
  const metricValues: Record<string, number | null> = {};

  for (const [id, threshold] of Object.entries(MUST_HAVE_THRESHOLDS)) {
    const value = snapshot.metrics[id] ?? null;
    metricGrades[id] = threshold.grade(value);
    metricDescriptions[id] = threshold.description;
    metricValues[id] = value;
  }

  const overall = aggregateGrade(Object.values(metricGrades));

  return {
    workflowRunId: snapshot.workflowRunId,
    scenario: snapshot.scenario,
    overall,
    metricGrades,
    metricDescriptions,
    metricValues,
  };
}
