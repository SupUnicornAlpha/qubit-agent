/**
 * ResearchScenarioService：场景的「输入校验 + Provider 能力校验 + 启动 workflow」入口
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6.5
 */

import { providerResolver } from "../provider/resolver";
import { researchScenarioRegistry } from "./registry";
import {
  ScenarioError,
  type FieldSchema,
  type ScenarioLaunchInput,
  type ScenarioValidateResult,
} from "./types";

function validateInput(
  schema: Record<string, FieldSchema>,
  input: Record<string, unknown>
): Array<{ field: string; error: string }> {
  const errs: Array<{ field: string; error: string }> = [];
  for (const [field, def] of Object.entries(schema)) {
    const v = input[field];
    if (def.required && (v === undefined || v === null || v === "")) {
      errs.push({ field, error: "required" });
      continue;
    }
    if (v === undefined || v === null) continue;

    switch (def.type) {
      case "string":
      case "enum":
        if (typeof v !== "string") {
          errs.push({ field, error: "must_be_string" });
          break;
        }
        if (def.type === "enum") {
          const ok = def.values.some((c) => c.value === v);
          if (!ok) errs.push({ field, error: `not_in_enum` });
        }
        if (def.type === "string" && def.maxLength && v.length > def.maxLength) {
          errs.push({ field, error: "exceeds_max_length" });
        }
        break;
      case "string[]":
      case "multi_enum":
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          errs.push({ field, error: "must_be_string_array" });
          break;
        }
        if (def.type === "multi_enum") {
          const allowed = new Set(def.values.map((c) => c.value));
          for (const x of v) {
            if (!allowed.has(x as string)) {
              errs.push({ field, error: `not_in_enum: ${x}` });
              break;
            }
          }
        }
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errs.push({ field, error: "must_be_finite_number" });
          break;
        }
        if (def.min !== undefined && v < def.min) errs.push({ field, error: "below_min" });
        if (def.max !== undefined && v > def.max) errs.push({ field, error: "above_max" });
        break;
      case "boolean":
        if (typeof v !== "boolean") errs.push({ field, error: "must_be_boolean" });
        break;
    }
  }
  return errs;
}

export class ResearchScenarioService {
  async validate(
    scenarioKey: string,
    input: Record<string, unknown>,
    scope: { projectId?: string; workflowRunId?: string; strategyVersionId?: string } = {}
  ): Promise<ScenarioValidateResult> {
    const spec = researchScenarioRegistry.get(scenarioKey);
    if (!spec) {
      throw new ScenarioError("scenario_not_found", `scenario_not_found: ${scenarioKey}`);
    }
    if (spec.status === "disabled") {
      throw new ScenarioError("scenario_disabled", `scenario_disabled: ${scenarioKey}`);
    }

    const invalidInputs = validateInput(spec.inputSchema, input);
    const { ok, missing } = await providerResolver.checkCapabilities(
      spec.requiredCapabilities,
      scope
    );
    return {
      ok: invalidInputs.length === 0 && ok,
      ...(invalidInputs.length > 0 ? { invalidInputs } : {}),
      ...(missing.length > 0 ? { missingCapabilities: missing } : {}),
    };
  }

  /**
   * 启动场景对应的 workflow。
   *
   * P0 阶段实现到「校验通过」即返回，不直接调 workflow-service.createAndDispatchWorkflow，
   * 因为后者还有 sessionId/loopKind 等耦合，留到 P1 整合（详见 §6.6.8 兼容性矩阵）。
   *
   * 这里返回校验后的"启动计划"，调用方（HTTP route / Agent tool）拿到后再走 createAndDispatchWorkflow。
   */
  async planLaunch(input: ScenarioLaunchInput): Promise<{
    scenarioKey: string;
    scenarioId: string;
    agentGroupId: string;
    inputParams: Record<string, unknown>;
    loopOptions: Record<string, unknown>;
    validation: ScenarioValidateResult;
  }> {
    const spec = researchScenarioRegistry.get(input.scenarioKey);
    if (!spec) {
      throw new ScenarioError("scenario_not_found", `scenario_not_found: ${input.scenarioKey}`);
    }
    if (spec.status === "disabled") {
      throw new ScenarioError("scenario_disabled", `scenario_disabled: ${input.scenarioKey}`);
    }

    const validation = await this.validate(input.scenarioKey, input.inputParams, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });

    const groupId = input.agentGroupId ?? spec.defaultAgentGroupId;
    if (!groupId) {
      throw new ScenarioError("group_resolve_failed", "no_default_group_for_scenario");
    }

    const loop = { ...spec.loopDefaults, ...(input.loopOverrides ?? {}) };

    return {
      scenarioKey: spec.key,
      scenarioId: spec.id,
      agentGroupId: groupId,
      inputParams: input.inputParams,
      loopOptions: loop as Record<string, unknown>,
      validation,
    };
  }
}

export const researchScenarioService = new ResearchScenarioService();
