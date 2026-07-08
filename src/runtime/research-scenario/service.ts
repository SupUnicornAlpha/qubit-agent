/**
 * ResearchScenarioService：场景的「输入校验 + Provider 能力校验 + 启动 workflow」入口
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6.5
 */

import { providerResolver } from "../provider/resolver";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { launchAnalystTeam } from "../msa/launch-analyst-team";
import type { ResearchScopeInput } from "../../types/research-scope";
import { researchScenarioRegistry } from "./registry";
import {
  ScenarioError,
  type FieldSchema,
  type ScenarioLaunchInput,
  type ResearchScenarioSpec,
  type ScenarioValidateResult,
} from "./types";

const SCENARIO_KEY_ALIASES: Record<string, string> = {
  research: "analyst_debate",
  research_multi: "analyst_debate",
  research_theme: "stock_screening",
  stock_pick: "stock_screening",
  stock_pick_short: "stock_screening",
  factor: "factor_research",
  strategy: "strategy_authoring",
  strategy_long_short: "strategy_authoring",
  live_trading_short: "live_trading",
};

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
  private resolveSpec(
    scenarioKey: string
  ): { requestedKey: string; registryKey: string; spec: ResearchScenarioSpec & { id: string } } {
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
    registryScenarioKey: string;
    scenarioId: string;
    agentGroupId: string;
    inputParams: Record<string, unknown>;
    loopOptions: Record<string, unknown>;
    validation: ScenarioValidateResult;
  }> {
    const { requestedKey, registryKey, spec } = this.resolveSpec(input.scenarioKey);
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
      scenarioKey: requestedKey,
      registryScenarioKey: registryKey,
      scenarioId: spec.id,
      agentGroupId: groupId,
      inputParams: input.inputParams,
      loopOptions: loop as Record<string, unknown>,
      validation,
    };
  }

  async launch(input: ScenarioLaunchInput): Promise<{
    scenarioKey: string;
    registryScenarioKey: string;
    scenarioId: string;
    workflowRunId: string;
    jobId: string;
    agentGroupId: string;
    validation: ScenarioValidateResult;
  }> {
    const plan = await this.planLaunch(input);
    if (plan.validation.invalidInputs?.length) {
      throw new ScenarioError("invalid_input", "invalid_input", {
        invalidInputs: plan.validation.invalidInputs,
      });
    }
    const requiredMissing = plan.validation.missingCapabilities ?? [];
    if (requiredMissing.length > 0) {
      throw new ScenarioError("missing_capability", "missing_capability", {
        missingCapabilities: requiredMissing,
      });
    }

    const goal = input.goal?.trim() || buildScenarioGoal(plan.scenarioKey, plan.inputParams);
    const created = await createAndDispatchWorkflow({
      projectId: input.projectId,
      goal,
      mode: "research",
      source: "api",
      skipDispatch: true,
      loopKind: "native",
      loopOptionsJson: {
        ...plan.loopOptions,
        scenarioKey: plan.scenarioKey,
        registryScenarioKey: plan.registryScenarioKey,
      } as never,
    });

    const launchInput = buildAnalystLaunchInput({
      scenarioKey: plan.scenarioKey,
      inputParams: plan.inputParams,
      goal,
    });
    const launched = await launchAnalystTeam({
      workflowRunId: created.data.id,
      ...(launchInput.ticker !== undefined ? { ticker: launchInput.ticker } : {}),
      ...(launchInput.scope !== undefined ? { scope: launchInput.scope } : {}),
      context: launchInput.context,
      agentGroupId: plan.agentGroupId,
      researchScenarioKey: plan.scenarioKey,
      hitlMode: "off",
    });

    return {
      scenarioKey: plan.scenarioKey,
      registryScenarioKey: plan.registryScenarioKey,
      scenarioId: plan.scenarioId,
      workflowRunId: created.data.id,
      jobId: launched.jobId,
      agentGroupId: plan.agentGroupId,
      validation: plan.validation,
    };
  }
}

export const researchScenarioService = new ResearchScenarioService();

function buildScenarioGoal(scenarioKey: string, params: Record<string, unknown>): string {
  const parts = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 8)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`);
  return `运行研究场景 ${scenarioKey}${parts.length ? `：${parts.join("；")}` : ""}`;
}

function buildAnalystLaunchInput(input: {
  scenarioKey: string;
  inputParams: Record<string, unknown>;
  goal: string;
}): { ticker?: string; scope?: ResearchScopeInput; context: string } {
  const params = input.inputParams;
  const explicitContext = firstString(params, ["context"]);
  const explicitScope =
    params.scope && typeof params.scope === "object" && !Array.isArray(params.scope)
      ? (params.scope as ResearchScopeInput)
      : undefined;
  const ticker = firstString(params, ["ticker", "symbol", "primarySymbol"]);
  const symbols = firstStringArray(params, ["symbols", "tickers"]);
  const theme =
    firstString(params, ["theme", "strategyHint", "ruleTheme", "factorCategory", "universe"]) ??
    input.goal;

  if (ticker) {
    return {
      ticker,
      context: explicitContext ?? input.goal,
    };
  }
  if (explicitScope) {
    return {
      scope: explicitScope,
      context: explicitContext ?? input.goal,
    };
  }
  if (symbols.length === 1) {
    return {
      ticker: symbols[0]!,
      context: explicitContext ?? input.goal,
    };
  }
  if (symbols.length > 1) {
    return {
      scope: { kind: "basket", symbols, theme },
      context: explicitContext ?? input.goal,
    };
  }
  return {
    scope: { kind: "explore", theme },
    context: explicitContext ?? input.goal,
  };
}

function firstString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstStringArray(params: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = params[key];
    if (Array.isArray(value)) {
      const strings = value.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0
      );
      if (strings.length > 0) return strings.map((item) => item.trim());
    }
    if (typeof value === "string" && value.includes(",")) {
      const strings = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (strings.length > 0) return strings;
    }
  }
  return [];
}
