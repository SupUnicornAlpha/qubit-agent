import { describe, expect, test } from "bun:test";
import {
  assessWorkflowProcessGate,
  buildWorkflowProcessPrompt,
  resolveEffectiveWorkflowProcessConfig,
} from "./process-config";

const config = {
  templateId: "deep-research",
  sopPreset: "evidence-first",
  sopSteps: [
    { id: "scope", title: "确认研究范围", required: true },
    { id: "verify", title: "验证关键证据", required: true },
  ],
  gates: {
    requirePlanCompleted: true,
    requireEvidence: true,
    minSuccessfulToolCalls: 2,
  },
};

describe("workflow process config", () => {
  test("renders SOP and hard gates into the runtime prompt", () => {
    const prompt = buildWorkflowProcessPrompt(config);
    expect(prompt).toContain("确认研究范围");
    expect(prompt).toContain("至少 2 次");
    expect(prompt).toContain("统一会话");
  });

  test("blocks completion until plan and evidence both close", () => {
    const blocked = assessWorkflowProcessGate({
      config,
      plan: {
        steps: [{ id: "s1", title: "查数据", status: "in_progress" }],
      },
      successfulBusinessToolCalls: 1,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons).toHaveLength(2);

    const passed = assessWorkflowProcessGate({
      config,
      plan: {
        steps: [{ id: "s1", title: "查数据", status: "done" }],
      },
      successfulBusinessToolCalls: 2,
    });
    expect(passed.ok).toBe(true);
  });

  test("keeps evidence policy persisted but disables it for a non-executing Plan turn", () => {
    const effective = resolveEffectiveWorkflowProcessConfig(config, "plan");
    expect(effective?.gates.requireEvidence).toBe(false);
    expect(config.gates.requireEvidence).toBe(true);
    expect(buildWorkflowProcessPrompt(effective)).not.toContain("真实业务工具");
  });
});
