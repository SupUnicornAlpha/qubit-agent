import { httpGet, httpPatch, httpPost } from "./client";

export type ResearchAttemptKind =
  | "factor_compute"
  | "factor_evaluate"
  | "sealed_factor"
  | "backtest"
  | "sealed_strategy"
  | "paper_step";
export type ResearchFactorAttemptKind = Exclude<
  ResearchAttemptKind,
  "backtest" | "sealed_strategy" | "paper_step"
>;
export type ResearchAttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface FactorComparisonSpec {
  method: "rank_blend_v1";
  references: Array<{ factorId: string; direction: 1 | -1; fingerprint?: string }>;
  candidateDirection: 1 | -1;
  candidateWeight: number;
  costBps: number;
}
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
  comparison?: FactorComparisonSpec;
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
  deployment?: "local_process" | "operator_managed";
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
    evidenceStatus?: "attested" | "research_only";
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

export async function submitFactorComparison(
  projectId: string,
  body: { factorId: string; idempotencyKey: string },
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<ResearchAttempt>>(`${projectPath(projectId)}/comparisons`, body, {
      signal,
    })
  );
}

export interface ResearchEvidenceBundle {
  format: "qubit-research-evidence-v1";
  checksum: string;
  evidence: {
    handoff: {
      status: "requires_repair" | "ready_for_review" | "retain_for_research";
      blockers: string[];
      nextStep: string;
      tradingEligible: false;
    };
    currentSources: {
      snapshotStatus: string;
      factors: Array<{ factorId: string; status: string }>;
    };
    searchHistory: { usedAttempts: number; usedEvaluations: number };
  };
}
export async function getResearchEvidence(
  projectId: string,
  attemptId: string,
  signal?: AbortSignal
) {
  return unwrap(
    await httpGet<ApiResponse<ResearchEvidenceBundle>>(
      `${projectPath(projectId)}/attempts/${encodeURIComponent(attemptId)}/evidence`,
      { signal }
    )
  );
}

export interface ResearchStrategyExecution {
  capital: number;
  topN: number;
  rebalance: "daily" | "weekly" | "monthly";
  commissionBps: number;
  slippageBps: number;
  minCommission: number;
  maxVolumeParticipation: number;
}
export interface ResearchStrategyVersion {
  id: string;
  createdAt: string;
  fingerprint: string;
  recipe: {
    sourceAttemptId: string;
    sourceProtocolId: string;
    factor: { id: string; name: string; expr: string; direction: 1 | -1 };
    development: ResearchProtocolSpec["development"];
    execution: ResearchStrategyExecution;
    allocation: string;
    timing: string;
    scope: "development_only";
  };
}
export async function listResearchStrategies(projectId: string, signal?: AbortSignal) {
  return unwrap(
    await httpGet<ApiResponse<ResearchStrategyVersion[]>>(`${projectPath(projectId)}/strategies`, {
      signal,
    })
  );
}
export async function createResearchStrategy(
  projectId: string,
  sourceAttemptId: string,
  execution: ResearchStrategyExecution,
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<ResearchStrategyVersion>>(
      `${projectPath(projectId)}/strategies`,
      { sourceAttemptId, execution },
      { signal }
    )
  );
}
export async function runResearchStrategy(
  projectId: string,
  versionId: string,
  idempotencyKey: string,
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<{ attemptId: string; jobId: string }>>(
      `${projectPath(projectId)}/strategies/${encodeURIComponent(versionId)}/backtests`,
      { idempotencyKey },
      { signal }
    )
  );
}

export async function getResearchStrategyArtifact(
  projectId: string,
  versionId: string,
  signal?: AbortSignal
) {
  return unwrap(
    await httpGet<ApiResponse<unknown>>(
      `${projectPath(projectId)}/strategies/${encodeURIComponent(versionId)}/artifact`,
      { signal }
    )
  );
}

export async function manageResearchStrategy<T>(
  projectId: string,
  versionId: string,
  command: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(
    `/api/v1/research-programs/${encodeURIComponent(projectId)}/strategies/${encodeURIComponent(versionId)}/manage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      signal,
    }
  );
  const body = await response.json();
  if (!response.ok || !body.ok)
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${response.status}`);
  return body.data as T;
}

export interface ResearchDataImport {
  id: string;
  status: "running" | "completed" | "failed";
  snapshotId?: string;
  error?: string;
  request: {
    provider: "yahoo_chart";
    symbols: string[];
    startDate: string;
    endDate: string;
    idempotencyKey: string;
  };
  limitations: string[];
  provenance: Array<{
    symbol: string;
    url: string;
    retrievedAt: string;
    sha256: string;
    rows: number;
  }>;
}
export async function getResearchDataImports(projectId: string, signal?: AbortSignal) {
  return unwrap(
    await httpGet<ApiResponse<ResearchDataImport[]>>(`${projectPath(projectId)}/data`, { signal })
  );
}
export async function importResearchData(
  projectId: string,
  request: ResearchDataImport["request"],
  signal?: AbortSignal
) {
  return unwrap(
    await httpPost<ApiResponse<ResearchDataImport>>(`${projectPath(projectId)}/data`, request, {
      signal,
    })
  );
}
