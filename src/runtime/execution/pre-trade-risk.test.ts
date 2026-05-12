import { describe, expect, test } from "bun:test";
import {
  computeNotionalUsd,
  parseRuleExpr,
  readContractMultiplier,
  ruleDecisionForViolation,
  signRiskDecision,
} from "./pre-trade-risk";

describe("parseRuleExpr", () => {
  test("parses JSON rule", () => {
    expect(parseRuleExpr('{"kind":"max_notional","max":100}')).toEqual({ kind: "max_notional", max: 100 });
  });

  test("returns null for invalid JSON", () => {
    expect(parseRuleExpr("not json")).toBeNull();
  });
});

describe("computeNotionalUsd", () => {
  test("computes qty * price * mult", () => {
    expect(computeNotionalUsd(10, 5, 2)).toBe(100);
  });

  test("returns null without price", () => {
    expect(computeNotionalUsd(10, null, 1)).toBeNull();
  });
});

describe("readContractMultiplier", () => {
  test("defaults to 1", () => {
    expect(readContractMultiplier({})).toBe(1);
  });

  test("reads contract_multiplier", () => {
    expect(readContractMultiplier({ contract_multiplier: 100 })).toBe(100);
  });
});

describe("ruleDecisionForViolation", () => {
  test("block severity + violated => block", () => {
    expect(ruleDecisionForViolation("block", true)).toBe("block");
  });

  test("warn severity + violated => review", () => {
    expect(ruleDecisionForViolation("warn", true)).toBe("review");
  });
});

describe("signRiskDecision", () => {
  test("is deterministic for same inputs", () => {
    const a = signRiskDecision("oi1", "rr1", "allow");
    const b = signRiskDecision("oi1", "rr1", "allow");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(16);
  });
});
