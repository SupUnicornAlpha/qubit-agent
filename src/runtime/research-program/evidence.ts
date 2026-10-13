import { evidenceDigest } from "./evidence-checksum";
export { evidenceDigest, verifyEvidenceChecksum } from "./evidence-checksum";
import { type FactorRecord, factorService } from "../factor/factor-service";
import { getMarketSnapshotById } from "../market/contracts/market-snapshot-service";
import { comparisonFactorFingerprint } from "./factor-comparison-runner";
import { researchProgramService } from "./service";
import { ResearchProgramError } from "./types";

export async function exportResearchEvidence(projectId: string, attemptId: string) {
  const detail = await researchProgramService.get(projectId);
  const attempt = detail.attempts.find((item) => item.id === attemptId);
  if (!attempt) throw new ResearchProgramError("research_attempt_not_found", 404);
  if (attempt.requestJson.operation !== "incremental_compare")
    throw new ResearchProgramError(
      "evidence_comparison_only",
      400,
      "当前证据包支持因子增量比较，封存原始数据不会导出。"
    );
  if (attempt.status === "pending" || attempt.status === "running")
    throw new ResearchProgramError(
      "evidence_attempt_not_terminal",
      409,
      "实验尚未结束，请在终态后导出证据。"
    );
  const protocol = detail.protocols.find((item) => item.id === attempt.protocolId);
  if (!protocol || !detail.program)
    throw new ResearchProgramError("research_protocol_not_found", 404);
  const references = attempt.requestJson.references as Record<string, unknown>[];
  if (!Array.isArray(references) || !protocol.spec.comparison)
    throw new ResearchProgramError("evidence_frozen_inputs_missing", 409);
  const frozen = [attempt.candidateJson, ...references];
  const factors = [];
  for (const saved of frozen) {
    const fingerprint = comparisonFactorFingerprint(saved as unknown as FactorRecord);
    let status: "unchanged" | "changed" | "unavailable" = "unavailable";
    try {
      const current = await factorService.get(String(saved.id));
      if (current.projectId === projectId)
        status = comparisonFactorFingerprint(current) === fingerprint ? "unchanged" : "changed";
    } catch {
      /* Missing source does not erase historical evidence. */
    }
    factors.push({ factorId: String(saved.id), fingerprint, status });
  }
  let snapshotStatus: "available" | "unavailable" = "unavailable";
  let snapshotManifest: unknown = null;
  try {
    const record = await getMarketSnapshotById(protocol.spec.development.datasetSnapshotId);
    if (record) {
      snapshotStatus = "available";
      snapshotManifest = {
        snapshotId: record.snapshot.snapshotId,
        contentChecksum: evidenceDigest(record),
        asOf: record.snapshot.asOf,
        timeframe: record.meta.timeframe,
        sourceIds: record.meta.sourceIds,
      };
    }
  } catch {
    /* Integrity failure is surfaced as unavailable, never as verified data. */
  }
  const report = attempt.resultJson as {
    version?: string;
    scope?: string;
    verdict?: string;
  } | null;
  const complete =
    attempt.status === "completed" &&
    report?.version === "factor-incremental-v1" &&
    report.scope === "development_only";
  const blockers = [
    ...(!complete ? ["comparison_not_completed"] : []),
    ...(snapshotStatus !== "available" ? ["snapshot_missing_or_invalid"] : []),
    ...(factors.some((f) => f.status !== "unchanged")
      ? ["live_factor_definitions_drifted_or_missing"]
      : []),
  ];
  const evidence = {
    exportedAt: new Date().toISOString(),
    projectId,
    attempt: {
      id: attempt.id,
      status: attempt.status,
      candidateId: attempt.candidateId,
      candidate: attempt.candidateJson,
      request: attempt.requestJson,
      requestFingerprint: attempt.requestFingerprint,
      result: attempt.resultJson,
      error: attempt.error,
      createdAt: attempt.createdAt,
      endedAt: attempt.endedAt,
    },
    protocol,
    searchHistory: {
      scope: "project_ledger_at_export",
      usedAttempts: detail.program.usedAttempts,
      usedEvaluations: detail.program.usedEvaluations,
      entries: detail.attempts.map((a) => ({
        id: a.id,
        protocolId: a.protocolId,
        candidateId: a.candidateId,
        kind: a.kind,
        status: a.status,
        createdAt: a.createdAt,
      })),
    },
    currentSources: {
      checkedAt: new Date().toISOString(),
      snapshotStatus,
      snapshotManifest,
      factors,
    },
    handoff: {
      status: blockers.length
        ? "requires_repair"
        : report?.verdict === "worth_validation"
          ? "ready_for_review"
          : "retain_for_research",
      blockers,
      nextStep: blockers.length
        ? "先修复输入或复核失败原因；冻结的历史证据仍保留。"
        : report?.verdict === "worth_validation"
          ? "人工复核后构建策略候选，登记执行约束，并进行独立组合验证。"
          : "保留本次证据；当前固定方法未给出进一步验证建议。",
      independentValidation: "not_established",
      tradingEligible: false,
    },
    limitations: [
      "证据包是研究交接材料，不是可执行策略或独立验证回执。",
      "当前源检查与实验时的冻结证据分开；源变化不会重写历史结果。",
      "包含整个项目的尝试索引，但不证明不存在项目外的搜索。",
      "不包含原始行情、封存数据、凭据或运行时文件路径。重算仍需合法获得相同快照与对应实现。",
      "SHA-256 仅检测内容一致性，不提供身份签名；不能作为晋级或授权凭证。",
    ],
  };
  return {
    format: "qubit-research-evidence-v1" as const,
    checksum: evidenceDigest(evidence),
    evidence,
  };
}
