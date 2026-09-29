import { createHash } from "node:crypto";
import { verifyPointInTimeIntegrity } from "../backtest/pit-verifier";
import type { BacktestDataset } from "../provider/types";
import { checkFactorTruncation } from "./factor-truncation-check";

/** Evidence about this expression on this frozen input, never a trading permission. */
export function assessFactorDataIntegrity(input: {
  factorId: string;
  expr: string;
  lang: string;
  providerKey: string;
  dataset: BacktestDataset;
  startDate: string;
  endDate: string;
}) {
  const pit = verifyPointInTimeIntegrity(input.dataset);
  const truncation =
    input.lang === "qlib_expr" && input.providerKey === "qlib_expr"
      ? checkFactorTruncation({ expr: input.expr, dataset: input.dataset })
      : null;
  const status =
    pit.verdict === "point_in_time_violated" || truncation?.status === "failed"
      ? ("failed" as const)
      : pit.pass &&
          truncation?.status === "passed" &&
          input.dataset.qualification.useClass === "strategy_validation"
        ? ("passed" as const)
        : ("research_only" as const);
  return {
    version: "factor-data-integrity-v1" as const,
    factorId: input.factorId,
    expressionHash: createHash("sha256").update(`${input.lang}\n${input.expr}`).digest("hex"),
    expression: input.expr,
    providerKey: input.providerKey,
    datasetSnapshotId: input.dataset.snapshotId,
    startDate: input.startDate,
    endDate: input.endDate,
    asOf: input.dataset.asOf,
    sourceIds: input.dataset.sourceIds,
    qualification: input.dataset.qualification,
    status,
    pit,
    truncation,
    limitations: [
      "截断一致性只能发现部分前视依赖，通过不等于没有数据泄漏，也不构成独立验证。",
      ...(truncation ? [] : ["此执行器尚未接入截断一致性检查。"]),
    ],
  };
}

export type FactorDataIntegrityReport = ReturnType<typeof assessFactorDataIntegrity>;

export function matchesFactorDataIntegrity(
  value: unknown,
  expected: {
    factorId: string;
    expr: string;
    lang: string;
    datasetSnapshotId: string | null;
  }
): boolean {
  if (!value || typeof value !== "object" || !expected.datasetSnapshotId) return false;
  const report = value as Partial<FactorDataIntegrityReport>;
  return (
    report.version === "factor-data-integrity-v1" &&
    report.status === "passed" &&
    report.factorId === expected.factorId &&
    report.datasetSnapshotId === expected.datasetSnapshotId &&
    report.expressionHash ===
      createHash("sha256").update(`${expected.lang}\n${expected.expr}`).digest("hex") &&
    report.pit?.verdict === "point_in_time_clean" &&
    report.qualification?.useClass === "strategy_validation" &&
    report.qualification?.pointInTime === "verified" &&
    report.truncation?.status === "passed"
  );
}
