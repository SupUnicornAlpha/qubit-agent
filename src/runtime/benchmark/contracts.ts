/**
 * QUBIT benchmark / flywheel 的稳定契约。
 *
 * 这些类型刻意只保存可评测的摘要，不复制请求正文、行情 bars 或任何密钥。生产
 * RunEnvelope 与 L0 fixture 使用同一份形状，防止 benchmark 与生产评分漂移。
 */

export type BenchmarkSuite = "production" | "L0" | "L1" | "L2";
export type WorkflowTerminalStatus = "completed" | "failed" | "cancelled";
export type AssertionStatus = "pass" | "fail" | "skipped";

export interface RunTool {
  name: string;
  status: "success" | "error" | "timeout" | "sandbox_blocked" | string;
  errorClass?: "transient" | "permanent" | "blocked" | "unknown";
  latencyMs?: number;
  /** 参数的不可逆摘要；只用于识别无意义重复调用。 */
  requestFingerprint?: string;
  /** 已由工具适配器确认的空语义结果（例如 items_empty / no_bars）。 */
  semanticEmpty?: boolean;
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
}

export interface AssertionResult {
  id: string;
  status: AssertionStatus;
  detail: string;
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
      };
    };
    soft: { score: number | null; status: "pending" | "scored" | "skipped" };
    outcome: { score: number | null; status: "pending" | "scored" | "skipped" };
  };
  pass: boolean;
  score: number;
  /** 缺 telemetry 的历史 run 可评分，但不得作为 challenger 晋级证据。 */
  promotionEligible: boolean;
  deliveryVerdict?: RunEnvelope["deliveryVerdict"];
}
