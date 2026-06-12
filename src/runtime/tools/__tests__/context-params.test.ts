import { describe, expect, test } from "bun:test";
import { injectContextParams } from "../context-params";

/**
 * 治理 #2：上下文绑定参数由 harness 无条件注入。LLM 填什么都不影响——
 * workflowRunId / projectId / project_id 一律被权威值覆盖。
 */
describe("injectContextParams", () => {
  test("无条件用权威值覆盖 LLM 传入的 workflowRunId / projectId / project_id", () => {
    const out = injectContextParams(
      {
        symbol: "NVDA",
        workflowRunId: "llm-bogus-wf",
        projectId: "nvda_research", // LLM 乱填的业务化占位
        project_id: "<ctx.projectId>",
      },
      { workflowRunId: "wf-real-001", projectId: "proj-real-001" }
    );
    expect(out["workflowRunId"]).toBe("wf-real-001");
    expect(out["projectId"]).toBe("proj-real-001");
    expect(out["project_id"]).toBe("proj-real-001");
    // 业务参数保留
    expect(out["symbol"]).toBe("NVDA");
  });

  test("LLM 没填这些参数时也注入", () => {
    const out = injectContextParams(
      { name: "factor_a" },
      { workflowRunId: "wf-2", projectId: "proj-2" }
    );
    expect(out["workflowRunId"]).toBe("wf-2");
    expect(out["projectId"]).toBe("proj-2");
    expect(out["project_id"]).toBe("proj-2");
  });

  test("projectId 为空/缺失时不写 projectId（让下游报清晰缺失错误，不污染空串）", () => {
    const outNull = injectContextParams({ projectId: "x" }, { workflowRunId: "wf-3", projectId: null });
    expect(outNull["workflowRunId"]).toBe("wf-3");
    // 权威值缺失 → 不覆盖也不保留 LLM 值？规则是不写 → 保留原 LLM 值
    // 但下游 builtin handler 优先 ctx.projectId，正常链路不依赖该值
    expect(outNull["projectId"]).toBe("x");

    const outMissing = injectContextParams({}, { workflowRunId: "wf-4" });
    expect(outMissing["workflowRunId"]).toBe("wf-4");
    expect(outMissing["projectId"]).toBeUndefined();
    expect(outMissing["project_id"]).toBeUndefined();
  });

  test("不原地修改入参对象", () => {
    const input = { symbol: "AAPL" };
    const out = injectContextParams(input, { workflowRunId: "wf-5", projectId: "proj-5" });
    expect(input).toEqual({ symbol: "AAPL" });
    expect(out).not.toBe(input);
  });
});
