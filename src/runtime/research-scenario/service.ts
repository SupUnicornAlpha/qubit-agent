/**
 * ResearchScenarioService：场景的「输入校验 + Provider 能力校验 + 对话前置计划」入口
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6.5
 */

import { ensureWorkflowConversation } from "../conversation/conversation-projection";
import { createConversationTurn } from "../conversation/conversation-turn-service";
import { providerResolver } from "../provider/resolver";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { researchScenarioRegistry } from "./registry";
import { SCENARIO_KEY_ALIASES } from "./scenario-key-aliases";
import {
  type FieldSchema,
  type ResearchScenarioSpec,
  type ScenarioConversationInput,
  ScenarioError,
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
          if (!ok) errs.push({ field, error: "not_in_enum" });
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
  private resolveSpec(scenarioKey: string): {
    requestedKey: string;
    registryKey: string;
    spec: ResearchScenarioSpec & { id: string };
  } {
    const direct = researchScenarioRegistry.get(scenarioKey);
    const registryKey = direct ? scenarioKey : SCENARIO_KEY_ALIASES[scenarioKey];
    if (!registryKey) {
      throw new ScenarioError("scenario_not_found", `scenario_not_found: ${scenarioKey}`);
    }
    const spec = direct ?? researchScenarioRegistry.get(registryKey);
    if (!spec) {
      throw new ScenarioError("scenario_not_found", `scenario_not_found: ${scenarioKey}`);
    }
    return { requestedKey: scenarioKey, registryKey, spec };
  }

  async validate(
    scenarioKey: string,
    input: Record<string, unknown>,
    scope: { projectId?: string; workflowRunId?: string; strategyVersionId?: string } = {}
  ): Promise<ScenarioValidateResult> {
    const { spec } = this.resolveSpec(scenarioKey);
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

  /** 生成对话所需的校验与配置；不创建 workflow，也不触发 Agent。 */
  async buildConversationPlan(input: ScenarioConversationInput): Promise<{
    scenarioKey: string;
    registryScenarioKey: string;
    scenarioId: string;
    inputParams: Record<string, unknown>;
    loopOptions: Record<string, unknown>;
    validation: ScenarioValidateResult;
    specOutputContract: ResearchScenarioSpec["outputContract"];
    specToolPreset: ResearchScenarioSpec["toolPreset"];
  }> {
    const { requestedKey, registryKey, spec } = this.resolveSpec(input.scenarioKey);
    if (spec.status === "disabled") {
      throw new ScenarioError("scenario_disabled", `scenario_disabled: ${input.scenarioKey}`);
    }

    const validation = await this.validate(input.scenarioKey, input.inputParams, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });

    const loop = { ...spec.loopDefaults, ...(input.loopOverrides ?? {}) };
    const fsWorkspaceId = input.fsWorkspaceId?.trim();
    if (fsWorkspaceId) {
      (loop as Record<string, unknown>).fsWorkspaceId = fsWorkspaceId;
    }

    return {
      scenarioKey: requestedKey,
      registryScenarioKey: registryKey,
      scenarioId: spec.id,
      inputParams: input.inputParams,
      loopOptions: loop as Record<string, unknown>,
      validation,
      specOutputContract: spec.outputContract,
      specToolPreset: spec.toolPreset,
    };
  }

  /**
   * 创建一次研究对话，而不是直接启动一个 research/analyst job。
   *
   * 场景服务只负责校验和准备 workflow；真正的 Agent 执行必须经过
   * `createConversationTurn` → `orchestrator_chat` → Rust Core。
   */
  async startConversation(input: ScenarioConversationInput): Promise<{
    scenarioKey: string;
    registryScenarioKey: string;
    scenarioId: string;
    workflowRunId: string;
    sessionId: string;
    turnId: string;
    validation: ScenarioValidateResult;
  }> {
    const plan = await this.buildConversationPlan(input);
    if (plan.validation.invalidInputs?.length) {
      throw new ScenarioError("invalid_input", "invalid_input", {
        invalidInputs: plan.validation.invalidInputs,
      });
    }
    if (plan.validation.missingCapabilities?.length) {
      throw new ScenarioError("missing_capability", "missing_capability", {
        missingCapabilities: plan.validation.missingCapabilities,
      });
    }

    const goal =
      input.goal?.trim() ||
      `请按研究场景 ${plan.scenarioKey} 完成研究：${JSON.stringify(plan.inputParams)}`;
    const created = await createAndDispatchWorkflow({
      projectId: input.projectId,
      goal,
      mode: "research",
      source: "chat",
      skipDispatch: true,
      loopKind: "native",
      researchScenarioId: plan.scenarioKey,
      taskType: "orchestrator_chat",
      params: {
        scenarioKey: plan.scenarioKey,
        registryScenarioKey: plan.registryScenarioKey,
        inputParams: plan.inputParams,
        outputContract: plan.specOutputContract,
        toolPreset: plan.specToolPreset,
      },
      loopOptionsJson: {
        ...plan.loopOptions,
        scenarioKey: plan.scenarioKey,
        registryScenarioKey: plan.registryScenarioKey,
        ...(input.fsWorkspaceId ? { fsWorkspaceId: input.fsWorkspaceId } : {}),
      } as never,
    });
    const conversation = await ensureWorkflowConversation(created.data.id);
    const turn = await createConversationTurn({
      sessionId: conversation.sessionId,
      projectId: conversation.projectId,
      workflowRunId: created.data.id,
      message: goal,
      workflowMode: "research",
      turnMode: "new_goal",
      agentMode: "agent",
    });
    return {
      scenarioKey: plan.scenarioKey,
      registryScenarioKey: plan.registryScenarioKey,
      scenarioId: plan.scenarioId,
      workflowRunId: created.data.id,
      sessionId: conversation.sessionId,
      turnId: turn.turnId,
      validation: plan.validation,
    };
  }
}

export const researchScenarioService = new ResearchScenarioService();
