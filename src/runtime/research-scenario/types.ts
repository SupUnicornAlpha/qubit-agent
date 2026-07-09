/**
 * 研究场景注册中心 - 类型定义
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6
 *
 * 场景 = "做什么研究" + 输入契约 + 产出契约 + 工具预设 + Provider 能力要求 + Loop 默认值
 */

import type { ProviderKind } from "../provider/types";

// ─── FieldSchema：input_schema_json 的字段定义 ───────────────────────────────

export type FieldSchemaBase = {
  required?: boolean;
  description?: string;
  /** UI 分组（"basic" | "advanced" | "expert"） */
  group?: "basic" | "advanced" | "expert";
};

export type FieldSchema =
  | (FieldSchemaBase & {
      type: "string";
      default?: string;
      placeholder?: string;
      maxLength?: number;
    })
  | (FieldSchemaBase & {
      type: "string[]";
      default?: string[];
      placeholder?: string;
    })
  | (FieldSchemaBase & {
      type: "number";
      default?: number;
      min?: number;
      max?: number;
      step?: number;
    })
  | (FieldSchemaBase & {
      type: "boolean";
      default?: boolean;
    })
  | (FieldSchemaBase & {
      type: "enum";
      values: ReadonlyArray<{ value: string; label: string }>;
      default?: string;
    })
  | (FieldSchemaBase & {
      type: "multi_enum";
      values: ReadonlyArray<{ value: string; label: string }>;
      default?: string[];
    });

// ─── ResearchScenarioSpec ────────────────────────────────────────────────────

export interface OutputContract {
  primary: string;
  secondary?: string[];
}

export interface CapabilityRequirement {
  kind: ProviderKind;
  level: "required" | "optional";
}

export interface ToolPreset {
  builtinTools: string[];
  connectors: string[];
  mcpServers: string[];
  defaultParams: Record<string, unknown>;
}

export interface LoopDefaults {
  maxIterations: number;
  reactLoop: boolean;
  requireDebate?: boolean;
  requireRiskVeto?: boolean;
  requirePmApproval?: boolean;
}

export interface ResearchScenarioSpec {
  key: string;
  displayName: string;
  description: string;
  inputSchema: Record<string, FieldSchema>;
  outputContract: OutputContract;
  requiredCapabilities: CapabilityRequirement[];
  toolPreset: ToolPreset;
  loopDefaults: LoopDefaults;
  status: "enabled" | "disabled";
  sortOrder: number;
  isBuiltin: boolean;
}

// ─── 校验结果 ────────────────────────────────────────────────────────────────

export interface ScenarioValidateResult {
  ok: boolean;
  missingCapabilities?: Array<{ kind: ProviderKind; reason: string }>;
  invalidInputs?: Array<{ field: string; error: string }>;
}

export interface ScenarioLaunchInput {
  scenarioKey: string;
  projectId: string;
  goal?: string;
  scopeInput?: Record<string, unknown>;
  inputParams: Record<string, unknown>;
  providerOverrides?: Array<{ kind: ProviderKind; providerKey?: string; providerId?: string }>;
  loopOverrides?: Partial<LoopDefaults>;
}

export class ScenarioError extends Error {
  constructor(
    public code:
      | "scenario_not_found"
      | "scenario_disabled"
      | "missing_capability"
      | "invalid_input",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ScenarioError";
  }
}
