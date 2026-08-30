import { describe, expect, test } from "bun:test";
import {
  type MathDerivationContract,
  type MathNumericEvaluator,
  auditMathDerivation,
  parseMathDerivationContract,
} from "./math-reasoning";

const contract: MathDerivationContract = {
  schemaVersion: "1.0",
  problem: "验证一个线性定价示例",
  variables: [
    { symbol: "x", definition: "输入数量", unit: "1", domain: "x >= 0" },
    { symbol: "y", definition: "附加数量", unit: "1", domain: "y >= 0" },
  ],
  assumptions: [{ id: "a1", statement: "线性关系在给定区间有效", testable: true }],
  constraints: [{ id: "c1", statement: "输入非负" }],
  formulas: [{ id: "f1", expression: "x + y", purpose: "总量", outputVariable: "total" }],
  derivation: [{ id: "d1", claim: "总量为输入之和", method: "algebra", formulaIds: ["f1"] }],
  applicableDomain: "x,y >= 0 的线性示例",
  conclusion: "线性求和满足给定条件。",
  checks: {
    numerical: [
      { id: "n1", label: "基本数值", expression: "sum", variables: { x: 1, y: 2 }, expected: 3 },
    ],
    boundaries: [
      { id: "b1", label: "零边界", expression: "nonnegative", variables: { x: 0 }, expected: true },
    ],
    counterexamples: [
      {
        id: "ce1",
        label: "反例拒绝",
        expression: "too_large",
        variables: { x: 1 },
        expected: false,
      },
    ],
    constraints: [
      {
        id: "co1",
        label: "约束满足",
        expression: "nonnegative",
        variables: { x: 1 },
        expected: true,
      },
    ],
    dimensions: [{ id: "u1", label: "无量纲求和", leftUnit: "1", rightUnit: "1" }],
    sensitivity: [
      {
        id: "s1",
        label: "x 增大使总量增大",
        expression: "double_x",
        variables: { x: 1 },
        variable: "x",
        delta: 0.1,
        direction: "increase",
      },
    ],
    symbolic: [],
  },
  sourceSnapshotRefs: ["snapshot:test"],
};

const evaluator: MathNumericEvaluator = {
  id: "test",
  async evaluate({ expression, variables }) {
    if (expression === "sum")
      return { ok: true, value: variable(variables, "x") + variable(variables, "y") };
    if (expression === "nonnegative") return { ok: true, value: variable(variables, "x") >= 0 };
    if (expression === "too_large") return { ok: true, value: variable(variables, "x") > 4 };
    if (expression === "double_x") return { ok: true, value: 2 * variable(variables, "x") };
    return { ok: false, error: "unknown" };
  },
};

function variable(variables: Record<string, number>, key: string): number {
  const value = variables[key];
  if (value === undefined) throw new Error(`missing test variable: ${key}`);
  return value;
}

function requiredItem<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("missing test fixture item");
  return item;
}

describe("MathDerivationContract", () => {
  test("accepts a complete, audit-friendly contract and independently verifies it", async () => {
    const parsed = parseMathDerivationContract(contract);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const audit = await auditMathDerivation({
      contract: parsed.contract,
      mode: "required",
      numericEvaluator: evaluator,
      now: new Date("2026-08-25T00:00:00.000Z"),
    });
    expect(audit.verdict).toBe("verified");
    expect(audit.artifactType).toBe("MathDerivationRecord");
    expect(audit.inputHash).toStartWith("sha256:");
    expect(audit.checks.every((check) => check.status === "pass")).toBe(true);
  });

  test("rejects hidden-thought fields and unresolved formula references", () => {
    const withThought = { ...contract, hiddenThought: "do not store this" };
    expect(parseMathDerivationContract(withThought).ok).toBe(false);
    const badReference: MathDerivationContract = {
      ...contract,
      derivation: [{ ...requiredItem(contract.derivation), formulaIds: ["missing"] }],
    };
    const parsed = parseMathDerivationContract(badReference);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(" ")).toContain("不存在的公式");

    const undefinedVariable: MathDerivationContract = {
      ...contract,
      checks: {
        ...contract.checks,
        numerical: [{ ...requiredItem(contract.checks.numerical), variables: { z: 1 } }],
      },
    };
    const invalidVariables = parseMathDerivationContract(undefinedVariable);
    expect(invalidVariables.ok).toBe(false);
    if (!invalidVariables.ok) expect(invalidVariables.issues.join(" ")).toContain("未定义变量: z");
  });

  test("rejects a claim when an independent counterexample check fails", async () => {
    const failing: MathDerivationContract = {
      ...contract,
      checks: {
        ...contract.checks,
        counterexamples: [{ ...requiredItem(contract.checks.counterexamples), expected: true }],
      },
    };
    const audit = await auditMathDerivation({
      contract: failing,
      mode: "required",
      numericEvaluator: evaluator,
    });
    expect(audit.verdict).toBe("rejected");
    expect(audit.checks.find((check) => check.id === "ce1")?.status).toBe("fail");
  });
});
