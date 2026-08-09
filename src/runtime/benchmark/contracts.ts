/**
 * QUBIT benchmark / flywheel 的稳定契约。
 *
 * 这些类型刻意只保存可评测的摘要，不复制请求正文、行情 bars 或任何密钥。生产
 * RunEnvelope 与 L0 fixture 使用同一份形状，防止 benchmark 与生产评分漂移。
 *
 * v0.2：在 Hard/Trajectory 之上补齐 Soft 多维（工具召回、记忆搜索、编排 handoff、
 * recipe 必备工具），与 Prime Core + Bun bridge 架构对齐。
 */

export type BenchmarkSuite = "production" | "L0" | "L1" | "L2";
export type WorkflowTerminalStatus = "completed" | "failed" | "cancelled";
export type AssertionStatus = "pass" | "fail" | "skipped";

/** Soft / UpgradeGate 可观测维度（与 case.dimensions 对齐）。 */
export type SoftDimensionId =
  | "tools"
  | "memory"
  | "skills"
  | "orchestration"
  | "recipe"
  | "content";

export interface RunTool {
  name: string;
  status: "success" | "error" | "timeout" | "sandbox_blocked" | string;
  errorClass?: "transient" | "permanent" | "blocked" | "unknown";
  latencyMs?: number;
  /** 参数的不可逆摘要；只用于识别无意义重复调用。 */
  requestFingerprint?: string;
  /** 已由工具适配器确认的空语义结果（例如 items_empty / no_bars）。 */
  semanticEmpty?: boolean;
  /** 记忆类工具返回的 hit 数（仅 memory.* / workspace.memory.*）。 */
  memoryHitCount?: number;
}

export interface RunArtifact {
  kind: string;
  id: string;
  ok: boolean;
  asof?: string;
  dataAsof?: string;
  side?: "long" | "short" | "neutral";
  hasStopLoss?: boolean;
  hasTakeProfit?: boolean;
  hasInvalidation?: boolean;
}

/** memory.recall / workspace.memory.search 遥测摘要。 */
export interface RunMemoryTelemetry {
  telemetryAvailable: boolean;
  recallAttempts: number;
  recallSuccesses: number;
  recallHits: number;
  searchAttempts: number;
  searchSuccesses: number;
  searchHits: number;
  errorCount: number;
}

/** Dedicated agent_skill recall/injection telemetry (not procedural memory). */
export interface RunSkillTelemetry {
  telemetryAvailable: boolean;
  recallCount: number;
  executedCount: number;
  recalledNames: string[];
  executedNames: string[];
}

/** agent.invoke / specialist handoff 遥测摘要。 */
export interface RunOrchestrationTelemetry {
  telemetryAvailable: boolean;
  invokeAttempts: number;
  invokeSuccesses: number;
  /** 仍是 goal stub（如 "invoke completed: …"）而非真实叙事的次数。 */
  stubNarrativeCount: number;
  /** 成功 invoke 的叙事总字符（越大越可能有实质回传）。 */
  narrativeChars: number;
}

/** 场景 recipe / expectation 必备工具覆盖。 */
export interface RunRecipeTelemetry {
  telemetryAvailable: boolean;
  requiredTools: string[];
  matchedTools: string[];
  missedTools: string[];
}

export interface RunEnvelope {
  workflowRunId: string;
  suite: BenchmarkSuite;
  scenarioKey: string | null;
  harnessVersion: string;
  terminal: {
    status: string;
    reasonCode?: string;
  };
  tools: RunTool[];
  artifacts: RunArtifact[];
  artifactGate: {
    available: boolean;
    ok?: boolean;
    missing: string[];
    /** 旧运行没有 gate event 时必须保持 undefined，不能伪造 first pass。 */
    firstPass?: boolean;
    reinjectCount?: number;
  };
  delivery: {
    observed: boolean;
    hasUserFinalAnswer?: boolean;
  };
  /** Thin-loop DeliveryVerdict projection; missing → observability incomplete for promotion. */
  deliveryVerdict?: {
    available: boolean;
    state?: "delivered" | "delivered_with_gaps" | "partial" | "failed";
    reasonCodes?: string[];
  };
  /** P0 已有来源尚未记录 contract / capability telemetry，须显式标 skipped。 */
  contract?: { telemetryAvailable: boolean; permanentExecutionCount: number };
  capability?: { telemetryAvailable: boolean; disabledMcpExecutionCount: number };
  risk?: { telemetryAvailable: boolean; decisionRecorded: boolean };
  shortRisk?: { telemetryAvailable: boolean; coverageRecorded: boolean };
  /** v0.2：记忆搜索遥测；缺省 → soft.memory = skipped。 */
  memory?: RunMemoryTelemetry;
  /** Rust/Bun unified Skills telemetry. */
  skills?: RunSkillTelemetry;
  /** v0.2：编排 / specialist invoke 遥测。 */
  orchestration?: RunOrchestrationTelemetry;
  /** v0.2：recipe 必备工具覆盖。 */
  recipe?: RunRecipeTelemetry;
}

export interface AssertionResult {
  id: string;
  status: AssertionStatus;
  detail: string;
}

export interface SoftDimensionScore {
  id: SoftDimensionId;
  score: number | null;
  status: "scored" | "skipped" | "not_applicable";
  detail: string;
  metrics?: Record<string, number | null>;
}

export interface RunScorecard {
  workflowRunId: string;
  suite: BenchmarkSuite;
  harnessVersion: string;
  layers: {
    hard: {
      pass: boolean;
      complete: boolean;
      score: number;
      assertions: AssertionResult[];
    };
    trajectory: {
      pass: boolean;
      veto: boolean;
      score: number | null;
      metrics: {
        toolSuccessRate: number | null;
        duplicateToolCalls: number;
        semanticEmptyRetries: number;
        reinjectCount: number | null;
        requiredToolRecall: number | null;
      };
    };
    soft: {
      score: number | null;
      status: "pending" | "scored" | "skipped";
      dimensions: SoftDimensionScore[];
    };
    outcome: { score: number | null; status: "pending" | "scored" | "skipped" };
  };
  pass: boolean;
  score: number;
  /** 缺 telemetry 的历史 run 可评分，但不得作为 challenger 晋级证据。 */
  promotionEligible: boolean;
  deliveryVerdict?: RunEnvelope["deliveryVerdict"];
}
