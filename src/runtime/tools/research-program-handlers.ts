import { factorService } from "../factor/factor-service";
import { researchProgramService } from "../research-program/service";
import { researchProtocolSpecSchema } from "../research-program/types";
import type { BuiltinToolContext, BuiltinToolHandler } from "./types";

function projectId(ctx: BuiltinToolContext): string {
  if (!ctx.projectId) throw new Error("research_project_context_required");
  return ctx.projectId;
}

function requiredText(params: Record<string, unknown>, key: string, alias?: string): string {
  const value = params[key] ?? (alias ? params[alias] : undefined);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key}_required`);
  return value.trim();
}

export const RESEARCH_PROGRAM_HANDLERS: Record<string, BuiltinToolHandler> = {
  "research.protocol.get": async (ctx) => researchProgramService.get(projectId(ctx)),
  "research.protocol.create": async (ctx, params) => {
    const { researchRunner } = await import("../research-program/runner");
    return researchRunner.createProtocol({
      projectId: projectId(ctx),
      spec: researchProtocolSpecSchema.parse(params.spec),
    });
  },
  "research.factor.run": async (ctx, params) => {
    const kind = params.kind;
    if (kind !== "factor_compute" && kind !== "factor_evaluate" && kind !== "sealed_factor") {
      throw new Error("research_factor_kind_invalid");
    }
    const { researchRunner } = await import("../research-program/runner");
    return researchRunner.submitFactor({
      projectId: projectId(ctx),
      factorId: requiredText(params, "factor_id", "factorId"),
      kind,
      idempotencyKey: requiredText(params, "idempotency_key", "idempotencyKey"),
    });
  },
  "research.attempt.list": async (ctx) =>
    (await researchProgramService.get(projectId(ctx))).attempts,
  "research.attempt.cancel": async (ctx, params) => {
    const attempt = await researchProgramService.getAttempt(
      requiredText(params, "attempt_id", "attemptId")
    );
    if (attempt.projectId !== projectId(ctx)) throw new Error("research_attempt_project_mismatch");
    return researchProgramService.cancel(attempt.id);
  },
  "factor.get": async (ctx, params) => {
    const factor = await factorService.get(requiredText(params, "factor_id", "factorId"));
    if (factor.projectId !== projectId(ctx)) throw new Error("research_factor_project_mismatch");
    return factor;
  },
};
