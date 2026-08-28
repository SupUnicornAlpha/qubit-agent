/**
 * Agent Eval Platform — 稳定契约（无 DB / 无业务模块依赖）。
 *
 * 对标 Langfuse Score + Observation 原语；垂直评测与通用评测均产出 ScoreDraft。
 */

export type ScoreDataType = "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";

export type ScoreSource = "heuristic" | "llm_judge" | "code" | "human" | "domain_plugin";

export type ObservationType =
  | "workflow.root"
  | "llm.generation"
  | "tool.invocation"
  | "mcp.invocation"
  | "skill.recall"
  | "artifact.emitted";

export interface ScoreValue {
  dataType: ScoreDataType;
  numeric?: number;
  categorical?: string;
  boolean?: boolean;
  text?: string;
}

/** 写入前的评分草稿；持久化层负责分配 id / createdAt。 */
export interface ScoreDraft {
  name: string;
  value: ScoreValue;
  comment?: string;
  source: ScoreSource;
  evaluatorId?: string;
  observationId?: string;
  sessionId?: string;
  evalRunId?: string;
  datasetItemId?: string;
  configFingerprint?: string;
}

export interface AgentScoreRecord extends ScoreDraft {
  id: string;
  workflowRunId: string;
  createdAt: string;
}

export interface ObservationNode {
  id: string;
  type: ObservationType;
  name: string;
  status?: string;
  latencyMs?: number | null;
  tokenCount?: number | null;
  parentId?: string;
  startedAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
  children?: ObservationNode[];
}

export interface ObservationTree {
  workflowRunId: string;
  sessionId: string | null;
  scenarioKey: string | null;
  workflowStatus: string;
  root: ObservationNode;
}

export interface ScoreContributorContext {
  workflowRunId: string;
  sessionId: string | null;
  scenarioKey: string | null;
  configFingerprint?: string;
}

export interface ScoreContributor {
  readonly id: string;
  contribute(ctx: ScoreContributorContext): Promise<ScoreDraft[]>;
}

/** 生产/实验写入时保留的来源（human / llm_judge 不被 sync 覆盖）。 */
export const PRESERVED_SCORE_SOURCES: readonly ScoreSource[] = ["human", "llm_judge"];
