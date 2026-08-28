export type EvaluatorType = "llm_judge" | "code";

export interface LlmJudgeEvaluatorConfig {
  id: string;
  type: "llm_judge";
  enabled: boolean;
  sampleRate: number;
  outputScoreName: string;
  maxArtifacts?: number;
  /** 目前仅支持内置 content-judge rubric。 */
  rubric: "content-judge";
}

export type EvaluatorConfig = LlmJudgeEvaluatorConfig;

export interface EvaluatorRunContext {
  workflowRunId: string;
  sessionId: string | null;
  scenarioKey: string | null;
  configFingerprint?: string;
}

export interface EvaluatorRunResult {
  evaluatorId: string;
  skipped: boolean;
  skipReason?: string;
  scoresWritten: number;
}
