import { createMathjsNumericEvaluator, withNumericFallback } from "../harness/math-mcp-verifier";
import { pythonMathNumericEvaluator, pythonSympyVerifier } from "../harness/math-python-verifier";
import { auditMathDerivation, parseMathDerivationContract } from "../harness/math-reasoning";
import { resolveReasoningHarnessModeFromTaskMetadata } from "../harness/reasoning-harness";
import type { BuiltinToolHandler } from "./types";
import { recordWorkflowToolArtifact } from "./workflow-artifact-ledger";

/**
 * Verifies a model-proposed derivation with a fixed evaluator. The caller must
 * provide a MathDerivationContract; this handler intentionally never accepts
 * free-form reasoning or provider thinking fields.
 */
export const MATH_REASONING_HANDLER: BuiltinToolHandler = async (ctx, params) => {
  const mode = resolveReasoningHarnessModeFromTaskMetadata({
    // Dispatch has already authorized the builtin tool. This flag means the
    // math capability is available, not that every conversation is admitted.
    capabilityEnabled: true,
    metadata: { ...(ctx.inboundPayload ?? {}), ...params },
    requestedMode: params.math_mode ?? params.mathMode,
  });
  if (mode === "off") {
    throw new Error(
      "math.derivation.verify: math_harness_not_admitted（请显式传 math_mode，或由高保证任务提供 has_mathematical_claim + affects_decision）"
    );
  }
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
    mode,
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
