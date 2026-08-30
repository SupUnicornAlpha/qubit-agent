import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReasoningHarnessMode } from "./reasoning-harness";

export const MATH_REASONING_CAPABILITY_ID = "math.reasoning";
export const MATH_DERIVATION_SCHEMA_VERSION = "1.0";

const scalarSchema = z.union([z.number().finite(), z.boolean()]);
const variablesSchema = z.record(z.number().finite());
const expressionCheckSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(300),
  expression: z.string().min(1).max(4_000),
  variables: variablesSchema.default({}),
  expected: scalarSchema.optional(),
  tolerance: z.number().positive().finite().optional(),
});

const formulaSchema = z.object({
  id: z.string().min(1).max(120),
  expression: z.string().min(1).max(4_000),
  purpose: z.string().min(1).max(500),
  outputVariable: z.string().min(1).max(80).optional(),
});

const derivationStepSchema = z.object({
  id: z.string().min(1).max(120),
  claim: z.string().min(1).max(1_000),
  method: z.enum(["algebra", "substitution", "approximation", "theorem", "modeling"]),
  formulaIds: z.array(z.string().min(1)).min(1).max(16),
});

const sensitivitySchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(300),
  expression: z.string().min(1).max(4_000),
  variables: variablesSchema,
  variable: z.string().min(1).max(80),
  delta: z.number().positive().finite(),
  direction: z.enum(["increase", "decrease", "non_decreasing", "non_increasing"]),
  tolerance: z.number().nonnegative().finite().optional(),
});

export const mathDerivationContractSchema = z
  .object({
    schemaVersion: z.literal(MATH_DERIVATION_SCHEMA_VERSION),
    problem: z.string().min(1).max(2_000),
    variables: z
      .array(
        z.object({
          symbol: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
          definition: z.string().min(1).max(500),
          unit: z.string().min(1).max(80),
          domain: z.string().min(1).max(500),
          sourceRef: z.string().min(1).max(300).optional(),
        })
      )
      .min(1)
      .max(80),
    assumptions: z
      .array(
        z.object({
          id: z.string().min(1).max(120),
          statement: z.string().min(1).max(1_000),
          testable: z.boolean(),
        })
      )
      .min(1)
      .max(40),
    constraints: z
      .array(
        z.object({
          id: z.string().min(1).max(120),
          statement: z.string().min(1).max(1_000),
        })
      )
      .min(1)
      .max(40),
    formulas: z.array(formulaSchema).min(1).max(40),
    derivation: z.array(derivationStepSchema).min(1).max(80),
    applicableDomain: z.string().min(1).max(1_000),
    conclusion: z.string().min(1).max(2_000),
    checks: z.object({
      numerical: z.array(expressionCheckSchema).min(1).max(32),
      boundaries: z.array(expressionCheckSchema).min(1).max(32),
      counterexamples: z.array(expressionCheckSchema).min(1).max(32),
      constraints: z.array(expressionCheckSchema).min(1).max(32),
      dimensions: z
        .array(
          z.object({
            id: z.string().min(1).max(120),
            label: z.string().min(1).max(300),
            leftUnit: z.string().min(1).max(80),
            rightUnit: z.string().min(1).max(80),
          })
        )
        .min(1)
        .max(32),
      sensitivity: z.array(sensitivitySchema).min(1).max(24),
      symbolic: z
        .array(
          z.object({
            id: z.string().min(1).max(120),
            label: z.string().min(1).max(300),
            leftExpression: z.string().min(1).max(4_000),
            rightExpression: z.string().min(1).max(4_000),
            variables: z
              .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/))
              .max(80)
              .default([]),
          })
        )
        .max(24)
        .default([]),
    }),
    sourceSnapshotRefs: z.array(z.string().min(1).max(300)).max(40).default([]),
  })
  .strict();

export type MathDerivationContract = z.infer<typeof mathDerivationContractSchema>;

export type MathVerificationStatus = "pass" | "fail" | "skipped";
export type MathAuditVerdict = "verified" | "partially_verified" | "inconclusive" | "rejected";

export type MathVerificationCheck = {
  id: string;
  category:
    | "numerical"
    | "boundary"
    | "counterexample"
    | "constraint"
    | "dimension"
    | "sensitivity"
    | "symbolic"
    | "structure";
  status: MathVerificationStatus;
  detail: string;
  evidence?: Record<string, unknown>;
};

export type MathNumericEvaluator = {
  id: string;
  evaluate(input: { expression: string; variables: Record<string, number> }): Promise<
    { ok: true; value: number | boolean; engineVersion?: string } | { ok: false; error: string }
  >;
};

export type MathSymbolicVerifier = {
  id: string;
  equivalent(input: {
    leftExpression: string;
    rightExpression: string;
    variables: string[];
  }): Promise<
    | { ok: true; equivalent: boolean; engineVersion?: string }
    | { ok: false; error: string; unavailable?: boolean }
  >;
};

export type MathDerivationAudit = {
  artifactType: "MathDerivationRecord";
  schemaVersion: typeof MATH_DERIVATION_SCHEMA_VERSION;
  harnessId: typeof MATH_REASONING_CAPABILITY_ID;
  mode: ReasoningHarnessMode;
  inputHash: string;
  verifierVersion: string;
  createdAt: string;
  contract: MathDerivationContract;
  checks: MathVerificationCheck[];
  verdict: MathAuditVerdict;
  summary: string;
  sourceSnapshotRefs: string[];
};

function uniqueIssues(items: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) duplicates.add(item);
    seen.add(item);
  }
  return [...duplicates].map((item) => `重复${label}: ${item}`);
}

/** Parses externally supplied model JSON, then verifies cross-field invariants. */
export function parseMathDerivationContract(
  input: unknown
): { ok: true; contract: MathDerivationContract } | { ok: false; issues: string[] } {
  const parsed = mathDerivationContractSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues
        .slice(0, 30)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const contract = parsed.data;
  const issues = [
    ...uniqueIssues(
      contract.variables.map((item) => item.symbol),
      "变量"
    ),
    ...uniqueIssues(
      contract.formulas.map((item) => item.id),
      "公式 ID"
    ),
    ...uniqueIssues(
      contract.derivation.map((item) => item.id),
      "推导步骤 ID"
    ),
  ];
  const formulaIds = new Set(contract.formulas.map((item) => item.id));
  const definedVariables = new Set(contract.variables.map((item) => item.symbol));
  for (const step of contract.derivation) {
    for (const formulaId of step.formulaIds) {
      if (!formulaIds.has(formulaId))
        issues.push(`推导步骤 ${step.id} 引用了不存在的公式: ${formulaId}`);
    }
  }
  const expressionChecks = [
    ...contract.checks.numerical,
    ...contract.checks.boundaries,
    ...contract.checks.counterexamples,
    ...contract.checks.constraints,
  ];
  for (const check of expressionChecks) {
    for (const variable of Object.keys(check.variables)) {
      if (!definedVariables.has(variable))
        issues.push(`检查 ${check.id} 使用了未定义变量: ${variable}`);
    }
  }
  for (const check of contract.checks.sensitivity) {
    if (!(check.variable in check.variables)) {
      issues.push(`敏感性检查 ${check.id} 未提供受扰动变量 ${check.variable} 的基准值`);
    }
    for (const variable of Object.keys(check.variables)) {
      if (!definedVariables.has(variable))
        issues.push(`敏感性检查 ${check.id} 使用了未定义变量: ${variable}`);
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, contract };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function mathDerivationInputHash(contract: MathDerivationContract): string {
  return `sha256:${createHash("sha256").update(stableJson(contract)).digest("hex")}`;
}

function unitSignature(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/百分比|percent|%/g, "1")
    .replace(/美元|usd|\$/g, "usd")
    .replace(/年|years?|yr/g, "year");
}

function compareExpected(
  actual: number | boolean,
  expected: number | boolean,
  tolerance?: number
): boolean {
  if (typeof actual !== typeof expected) return false;
  if (typeof actual === "boolean" || typeof expected === "boolean") return actual === expected;
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= (tolerance ?? 1e-8) * scale;
}

async function runExpressionChecks(input: {
  category: MathVerificationCheck["category"];
  checks: MathDerivationContract["checks"]["numerical"];
  evaluator: MathNumericEvaluator;
}): Promise<MathVerificationCheck[]> {
  const results: MathVerificationCheck[] = [];
  for (const check of input.checks) {
    const result = await input.evaluator.evaluate({
      expression: check.expression,
      variables: check.variables,
    });
    if (!result.ok) {
      results.push({
        id: check.id,
        category: input.category,
        status: "skipped",
        detail: `${check.label}: 计算器不可用（${result.error}）`,
      });
      continue;
    }
    const passed =
      check.expected === undefined ||
      compareExpected(result.value, check.expected, check.tolerance);
    results.push({
      id: check.id,
      category: input.category,
      status: passed ? "pass" : "fail",
      detail: passed ? `${check.label}: 通过` : `${check.label}: 与预期不一致`,
      evidence: {
        expression: check.expression,
        actual: result.value,
        ...(check.expected === undefined ? {} : { expected: check.expected }),
        ...(result.engineVersion === undefined ? {} : { engineVersion: result.engineVersion }),
      },
    });
  }
  return results;
}

async function runSensitivityChecks(input: {
  checks: MathDerivationContract["checks"]["sensitivity"];
  evaluator: MathNumericEvaluator;
}): Promise<MathVerificationCheck[]> {
  const results: MathVerificationCheck[] = [];
  for (const check of input.checks) {
    const variableValue = check.variables[check.variable];
    if (variableValue === undefined) {
      results.push({
        id: check.id,
        category: "sensitivity",
        status: "fail",
        detail: `${check.label}: 未提供受扰动变量 ${check.variable} 的基准值`,
      });
      continue;
    }
    const baseline = await input.evaluator.evaluate({
      expression: check.expression,
      variables: check.variables,
    });
    const shiftedVariables = {
      ...check.variables,
      [check.variable]: variableValue + check.delta,
    };
    const shifted = await input.evaluator.evaluate({
      expression: check.expression,
      variables: shiftedVariables,
    });
    if (
      !baseline.ok ||
      !shifted.ok ||
      typeof baseline.value !== "number" ||
      typeof shifted.value !== "number"
    ) {
      results.push({
        id: check.id,
        category: "sensitivity",
        status: "skipped",
        detail: `${check.label}: 无法完成有限差分复算`,
      });
      continue;
    }
    const deltaOutput = shifted.value - baseline.value;
    const tolerance = check.tolerance ?? 1e-10;
    const passed =
      check.direction === "increase"
        ? deltaOutput > tolerance
        : check.direction === "decrease"
          ? deltaOutput < -tolerance
          : check.direction === "non_decreasing"
            ? deltaOutput >= -tolerance
            : deltaOutput <= tolerance;
    results.push({
      id: check.id,
      category: "sensitivity",
      status: passed ? "pass" : "fail",
      detail: passed ? `${check.label}: 方向符合预期` : `${check.label}: 方向与预期冲突`,
      evidence: {
        baseline: baseline.value,
        shifted: shifted.value,
        deltaOutput,
        variable: check.variable,
      },
    });
  }
  return results;
}

function verdictFor(checks: readonly MathVerificationCheck[]): MathAuditVerdict {
  if (
    checks.some(
      (check) =>
        check.status === "fail" || (check.category === "structure" && check.status !== "pass")
    )
  ) {
    return "rejected";
  }
  const passed = checks.filter((check) => check.status === "pass").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  if (passed === 0) return "inconclusive";
  return skipped > 0 ? "partially_verified" : "verified";
}

/**
 * Produces auditable verification evidence from a model proposal. It records
 * claims and results, never provider reasoning tokens or hidden chain-of-thought.
 */
export async function auditMathDerivation(input: {
  contract: MathDerivationContract;
  mode: ReasoningHarnessMode;
  numericEvaluator: MathNumericEvaluator;
  symbolicVerifier?: MathSymbolicVerifier;
  now?: Date;
}): Promise<MathDerivationAudit> {
  const parsed = parseMathDerivationContract(input.contract);
  const checks: MathVerificationCheck[] = [];
  if (!parsed.ok) {
    for (const [index, issue] of parsed.issues.entries()) {
      checks.push({
        id: `structure-${index + 1}`,
        category: "structure",
        status: "fail",
        detail: issue,
      });
    }
    return {
      artifactType: "MathDerivationRecord",
      schemaVersion: MATH_DERIVATION_SCHEMA_VERSION,
      harnessId: MATH_REASONING_CAPABILITY_ID,
      mode: input.mode,
      inputHash: "sha256:invalid-contract",
      verifierVersion: "math-audit-mvp/1",
      createdAt: (input.now ?? new Date()).toISOString(),
      contract: input.contract,
      checks,
      verdict: "rejected",
      summary: "推导契约不完整或交叉引用无效，未接受数学结论。",
      sourceSnapshotRefs: input.contract.sourceSnapshotRefs,
    };
  }
  const contract = parsed.contract;
  checks.push({
    id: "structure",
    category: "structure",
    status: "pass",
    detail: "结构化推导契约完整。",
  });
  checks.push(
    ...(await runExpressionChecks({
      category: "numerical",
      checks: contract.checks.numerical,
      evaluator: input.numericEvaluator,
    })),
    ...(await runExpressionChecks({
      category: "boundary",
      checks: contract.checks.boundaries,
      evaluator: input.numericEvaluator,
    })),
    ...(await runExpressionChecks({
      category: "counterexample",
      checks: contract.checks.counterexamples,
      evaluator: input.numericEvaluator,
    })),
    ...(await runExpressionChecks({
      category: "constraint",
      checks: contract.checks.constraints,
      evaluator: input.numericEvaluator,
    })),
    ...(await runSensitivityChecks({
      checks: contract.checks.sensitivity,
      evaluator: input.numericEvaluator,
    }))
  );
  for (const dimension of contract.checks.dimensions) {
    const compatible = unitSignature(dimension.leftUnit) === unitSignature(dimension.rightUnit);
    checks.push({
      id: dimension.id,
      category: "dimension",
      status: compatible ? "pass" : "fail",
      detail: compatible ? `${dimension.label}: 量纲相容` : `${dimension.label}: 量纲不相容`,
      evidence: { leftUnit: dimension.leftUnit, rightUnit: dimension.rightUnit },
    });
  }
  for (const symbolic of contract.checks.symbolic) {
    if (!input.symbolicVerifier) {
      checks.push({
        id: symbolic.id,
        category: "symbolic",
        status: "skipped",
        detail: `${symbolic.label}: 未加载符号验证器`,
      });
      continue;
    }
    const result = await input.symbolicVerifier.equivalent(symbolic);
    checks.push({
      id: symbolic.id,
      category: "symbolic",
      status:
        !result.ok && result.unavailable
          ? "skipped"
          : result.ok && result.equivalent
            ? "pass"
            : "fail",
      detail: result.ok
        ? result.equivalent
          ? `${symbolic.label}: 符号等价`
          : `${symbolic.label}: 符号不等价`
        : `${symbolic.label}: ${result.error}`,
      ...(result.ok && result.engineVersion
        ? { evidence: { engineVersion: result.engineVersion } }
        : {}),
    });
  }
  const verdict = verdictFor(checks);
  const count = (status: MathVerificationStatus) =>
    checks.filter((check) => check.status === status).length;
  return {
    artifactType: "MathDerivationRecord",
    schemaVersion: MATH_DERIVATION_SCHEMA_VERSION,
    harnessId: MATH_REASONING_CAPABILITY_ID,
    mode: input.mode,
    inputHash: mathDerivationInputHash(contract),
    verifierVersion: "math-audit-mvp/1",
    createdAt: (input.now ?? new Date()).toISOString(),
    contract,
    checks,
    verdict,
    summary: `数学审计 ${verdict}：${count("pass")} 项通过，${count("fail")} 项失败，${count("skipped")} 项跳过。`,
    sourceSnapshotRefs: contract.sourceSnapshotRefs,
  };
}

/** Prompt fragment for a task already admitted into the math-audit scope. */
export function renderMathDerivationContractInstruction(): string {
  return [
    "数学 Harness 已启用。提交可审计推导 JSON，而不是隐藏思维链。",
    "必须包含：schemaVersion=1.0、problem、variables(symbol/definition/unit/domain)、assumptions、constraints、formulas(expression)、derivation(简洁主张+公式 ID)、applicableDomain、conclusion。",
    "checks 必须含 numerical、boundaries、counterexamples、constraints、dimensions、sensitivity；symbolic 可为空。每个表达式必须可由独立计算器复算。",
  ].join("\n");
}
