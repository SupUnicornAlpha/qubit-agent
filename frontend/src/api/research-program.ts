import { httpGet, httpPatch, httpPost } from "./client";

export type ResearchAttemptKind =
  | "factor_compute"
  | "factor_evaluate"
  | "sealed_factor"
  | "backtest";
export type ResearchFactorAttemptKind = Exclude<ResearchAttemptKind, "backtest">;
export type ResearchAttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface ResearchProtocolSpec {
  hypothesis: string;
  benchmark: string;
  stoppingRule: string;
  development: {
    datasetSnapshotId: string;
    symbols: string[];
    startDate: string;
    endDate: string;
  };
  evaluation: {
    method: "factor_rank_ic_v1";
    horizonDays: number;
    groupCount: number;
    sealedDatasetId?: string;
    sealedDatasetFingerprint?: string;
  };
  budget: { maxAttempts: number; maxEvaluations: number };
}

export interface ResearchProtocol {
  id: string;
  version: number;
  fingerprint: string;
  spec: ResearchProtocolSpec;
  createdAt: string;
}

export interface ResearchAttempt {
  id: string;
  protocolId: string;
  kind: ResearchAttemptKind;
  candidateId: string;
  candidateJson: unknown;
  requestJson: unknown;
  status: ResearchAttemptStatus;
  resultJson: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ResearchProgramSnapshot {
  program: null | {
    projectId: string;
    activeProtocolId: string;
    status: "active" | "paused";
    maxAttempts: number;
    maxEvaluations: number;
    usedAttempts: number;
    usedEvaluations: number;
  };
  protocols: ResearchProtocol[];
  attempts: ResearchAttempt[];
}

export interface ResearchEvaluatorInfo {
  configured: boolean;
  datasets: Array<{
    id: string;
    label: string;
    startDate: string;
    endDate: string;
    maxEvaluations: number;
    horizonDays: number;
    groupCount: number;
    datasetFingerprint: string;
  }>;
  reason?: string;
}

type ApiResponse<T> = { ok: boolean; data: T; error?: string };
const root = "/api/v1/research-programs";
const projectPath = (projectId: string) => `${root}/${encodeURIComponent(projectId)}`;
function unwrap<T>(response: ApiResponse<T>): T {
  if (!response.ok) throw new Error(response.error || "研究服务未能完成请求。");
  return response.data;
}

export async function getResearchProgram(projectId: string, signal?: AbortSignal) {
  return unwrap(
    await httpGet<ApiResponse<ResearchProgramSnapshot>>(projectPath(projectId), { signal })
  );
}

export async function getResearchEvaluator(signal?: AbortSignal) {
  return unwrap(await httpGet<ApiResponse<ResearchEvaluatorInfo>>(`${root}/evaluator`, { signal }));
}

export async function createResearchProtocol(
  projectId: string,
  spec: ResearchProtocolSpec,
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<unknown>>(
      `${projectPath(projectId)}/protocols`,
      { spec },
      { signal }
    )
  );
}

export async function setResearchProgramStatus(projectId: string, status: "active" | "paused") {
  return unwrap(await httpPatch<ApiResponse<unknown>>(projectPath(projectId), { status }));
}

export async function submitResearchAttempt(
  projectId: string,
  body: {
    factorId: string;
    kind: ResearchFactorAttemptKind;
    idempotencyKey: string;
  },
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<unknown>>(`${projectPath(projectId)}/attempts`, body, { signal })
  );
}

export async function cancelResearchAttempt(
  projectId: string,
  attemptId: string,
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<unknown>>(
      `${projectPath(projectId)}/attempts/${encodeURIComponent(attemptId)}/cancel`,
      undefined,
      { signal }
    )
  );
}
