import { createHash } from "node:crypto";

export type FinalHoldoutContract = {
  version: "final-holdout-v1";
  strategyVersionId: string;
  datasetSnapshotId: string;
  trainEnd: string;
  holdoutStart: string;
  holdoutEnd: string;
  purgeDays: number;
  embargoDays: number;
  fingerprint: string;
};

/** Immutable declaration; callers must create it before reading holdout performance. */
export function createFinalHoldoutContract(
  input: Omit<FinalHoldoutContract, "version" | "fingerprint">
): FinalHoldoutContract {
  if (![input.trainEnd, input.holdoutStart, input.holdoutEnd].every(isIsoDate)) {
    throw new Error("final_holdout_date_invalid");
  }
  if (!(input.trainEnd < input.holdoutStart && input.holdoutStart <= input.holdoutEnd)) {
    throw new Error("final_holdout_dates_not_strictly_after_training");
  }
  if (input.purgeDays < 1 || input.embargoDays < 1)
    throw new Error("final_holdout_purge_embargo_required");
  const body = { version: "final-holdout-v1" as const, ...input };
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
  return { ...body, fingerprint: `holdout_${fingerprint}` };
}

/**
 * Accept a holdout result as promotion evidence only when its persisted
 * contract has not been edited and still belongs to the exact strategy and
 * immutable dataset snapshot under review.
 */
export function matchesFinalHoldoutEvidence(
  metricsJson: unknown,
  expected: { strategyVersionId: string | null; datasetSnapshotId: string | null }
): boolean {
  if (!expected.strategyVersionId || !expected.datasetSnapshotId) return false;
  if (!metricsJson || typeof metricsJson !== "object" || Array.isArray(metricsJson)) return false;
  const contract = (metricsJson as Record<string, unknown>).contract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return false;
  const values = contract as Record<string, unknown>;
  if (
    values.version !== "final-holdout-v1" ||
    values.strategyVersionId !== expected.strategyVersionId ||
    values.datasetSnapshotId !== expected.datasetSnapshotId ||
    typeof values.trainEnd !== "string" ||
    typeof values.holdoutStart !== "string" ||
    typeof values.holdoutEnd !== "string" ||
    typeof values.purgeDays !== "number" ||
    !Number.isInteger(values.purgeDays) ||
    typeof values.embargoDays !== "number" ||
    !Number.isInteger(values.embargoDays) ||
    typeof values.fingerprint !== "string"
  ) {
    return false;
  }
  try {
    const canonical = createFinalHoldoutContract({
      strategyVersionId: values.strategyVersionId,
      datasetSnapshotId: values.datasetSnapshotId,
      trainEnd: values.trainEnd,
      holdoutStart: values.holdoutStart,
      holdoutEnd: values.holdoutEnd,
      purgeDays: values.purgeDays,
      embargoDays: values.embargoDays,
    });
    return canonical.fingerprint === values.fingerprint;
  } catch {
    return false;
  }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
