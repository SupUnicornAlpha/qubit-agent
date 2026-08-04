import { describe, expect, test } from "bun:test";
import {
  buildHitlResumePromptBlock,
  matchesHitlToolPayload,
  normalizeHitlInput,
  validateHitlResponse,
} from "../hitl-service";

describe("HITL choice and resume capability", () => {
  test("single choice only accepts a declared option", () => {
    const schema = {
      options: [
        { label: "保守", value: "conservative" },
        { label: "激进", value: "aggressive" },
      ],
    };
    expect(
      validateHitlResponse({
        decision: "approved",
        inputKind: "single_choice",
        inputSchema: schema,
        response: { value: "conservative" },
      })
    ).toEqual({ value: "conservative" });
    expect(() =>
      validateHitlResponse({
        decision: "approved",
        inputKind: "single_choice",
        inputSchema: schema,
        response: { value: "hidden-option" },
      })
    ).toThrow("allowed options");
  });

  test("multi choice enforces allowed values and selection bounds", () => {
    const schema = {
      options: [
        { label: "技术面", value: "technical" },
        { label: "基本面", value: "fundamental" },
        { label: "情绪面", value: "sentiment" },
      ],
      minSelect: 1,
      maxSelect: 2,
    };
    expect(
      validateHitlResponse({
        decision: "approved",
        inputKind: "multi_choice",
        inputSchema: schema,
        response: { values: ["technical", "fundamental", "technical"] },
      })
    ).toEqual({ values: ["technical", "fundamental"] });
    expect(() =>
      validateHitlResponse({
        decision: "approved",
        inputKind: "multi_choice",
        inputSchema: schema,
        response: { values: ["technical", "fundamental", "sentiment"] },
      })
    ).toThrow("at most 2");
  });

  test("choice without usable options degrades to free form instead of deadlocking UI", () => {
    expect(normalizeHitlInput("single_choice", { options: [] })).toEqual({
      inputKind: "free_form",
      inputSchema: {
        placeholder: "候选选项生成失败，请直接输入希望 Agent 采用的路径",
        maxLength: 500,
      },
    });
  });

  test("resume prompt includes the human-readable selected option", () => {
    const prompt = buildHitlResumePromptBlock({
      approval: {
        requestId: "req-1",
        decision: "approved",
        response: { value: "conservative" },
      },
      payload: {
        toolName: "strategy.backtest",
        toolParams: { symbol: "AAPL", costBps: 10 },
      },
      inputSchema: {
        options: [{ label: "保守参数", value: "conservative" }],
      },
    });
    expect(prompt).toContain("用户选择：保守参数");
    expect(prompt).toContain("原待确认工具：strategy.backtest");
    expect(prompt).toContain("不能复用旧审批");
  });

  test("approval matches only the original tool and canonicalized params", () => {
    const payload = {
      toolName: "broker.place_order",
      toolParams: { symbol: "AAPL", order: { qty: 10, side: "buy" } },
    };
    expect(
      matchesHitlToolPayload(payload, "broker.place_order", {
        order: { side: "buy", qty: 10 },
        symbol: "AAPL",
      })
    ).toBe(true);
    expect(
      matchesHitlToolPayload(payload, "broker.place_order", {
        order: { side: "buy", qty: 20 },
        symbol: "AAPL",
      })
    ).toBe(false);
    expect(matchesHitlToolPayload(payload, "broker.cancel_order", payload.toolParams)).toBe(false);
  });

  test("form validates required fields and optional free text", () => {
    const schema = {
      fields: [
        { key: "cost", label: "成本", required: true },
        { key: "shares", label: "股数", type: "number" as const, required: true },
      ],
      allowFreeText: true,
    };
    expect(
      validateHitlResponse({
        decision: "approved",
        inputKind: "form",
        inputSchema: schema,
        response: { fields: { cost: "12.5", shares: "1000" }, text: "偏防守" },
      })
    ).toEqual({ fields: { cost: "12.5", shares: "1000" }, text: "偏防守" });
    expect(() =>
      validateHitlResponse({
        decision: "approved",
        inputKind: "form",
        inputSchema: schema,
        response: { fields: { cost: "12.5" } },
      })
    ).toThrow('HITL form requires field "shares"');
  });

  test("single choice can include free text and fields when allowed", () => {
    const schema = {
      options: [
        { label: "摊低成本", value: "avg_down" },
        { label: "控制回撤", value: "defend" },
      ],
      allowFreeText: true,
      fields: [{ key: "budget", label: "预算" }],
    };
    expect(
      validateHitlResponse({
        decision: "approved",
        inputKind: "single_choice",
        inputSchema: schema,
        response: { value: "avg_down", text: "分两批", fields: { budget: "5万" } },
      })
    ).toEqual({ value: "avg_down", text: "分两批", fields: { budget: "5万" } });
  });

  test("resume prompt includes form fields and user question payload", () => {
    const prompt = buildHitlResumePromptBlock({
      approval: {
        requestId: "req-q",
        decision: "approved",
        response: { fields: { cost: "18.2", shares: "2000" }, value: "avg_down" },
      },
      payload: {
        question: "摊成本还是防守？",
      },
      inputSchema: {
        options: [{ label: "摊低成本", value: "avg_down" }],
        fields: [
          { key: "cost", label: "成本" },
          { key: "shares", label: "股数" },
        ],
      },
    });
    expect(prompt).toContain("用户选择：摊低成本");
    expect(prompt).toContain("用户填写：cost=18.2；shares=2000");
    expect(prompt).toContain("原提问：摊成本还是防守？");
  });

  test("normalize promotes fields-only schema to form", () => {
    expect(
      normalizeHitlInput("approve_only", {
        fields: [{ key: "cost", label: "成本" }],
      })
    ).toMatchObject({
      inputKind: "form",
      inputSchema: {
        fields: [{ key: "cost", label: "成本", type: "text", required: true }],
      },
    });
  });
});
