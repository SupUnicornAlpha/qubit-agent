import {
  type ReasoningHarnessMode,
  auditMathDerivation,
  createMathjsNumericEvaluator,
  parseMathDerivationContract,
  pythonMathNumericEvaluator,
  pythonSympyVerifier,
  withNumericFallback,
} from "../harness";
import type { BuiltinToolHandler } from "./types";
import { recordWorkflowToolArtifact } from "./workflow-artifact-ledger";

function requestedMode(value: unknown): ReasoningHarnessMode {
  return value === "required" || value === "off" || value === "advisory" ? value : "advisory";
}

/**
 * Verifies a model-proposed derivation with a fixed evaluator. The caller must
 * provide a MathDerivationContract; this handler intentionally never accepts
 * free-form reasoning or provider thinking fields.
 */
export const MATH_REASONING_HANDLER: BuiltinToolHandler = async (ctx, params) => {
  const rawContract = params.contract ?? params.derivation;
  const parsed = parseMathDerivationContract(rawContract);
  if (!parsed.ok) {
    throw new Error(
      `math.derivation.verify: 推导契约无效：${parsed.issues.slice(0, 6).join("；")}`
    );
  }
  const symbolic = params.symbolic === true ? pythonSympyVerifier : undefined;
  const numericEvaluator =
    params.numeric_engine === "mathjs"
      ? withNumericFallback(
          createMathjsNumericEvaluator({
            ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
            definitionId: ctx.definition.id,
          }),
          pythonMathNumericEvaluator
        )
      : pythonMathNumericEvaluator;
  const audit = await auditMathDerivation({
    contract: parsed.contract,
    mode: requestedMode(params.math_mode),
    numericEvaluator,
    ...(symbolic ? { symbolicVerifier: symbolic } : {}),
  });
  const artifact = await recordWorkflowToolArtifact({
    workflowRunId: ctx.workflowId,
    fingerprint: `math-derivation:${audit.inputHash}`,
    toolName: "math.derivation.verify",
    result: audit as unknown as Record<string, unknown>,
  });
  return {
    ...audit,
    auditArtifact: artifact
      ? { id: artifact.id, kind: artifact.kind, fingerprint: artifact.fingerprint }
      : null,
  };
};
