import { describe, expect, it } from "bun:test";
import { classifyToolAction, isToolSuccess } from "./classify";
import { isEmptyToolResponse } from "./emptyResponse";
import { mapGraphToOfficeEvents } from "./eventMapper";

describe("pixelOffice classify", () => {
  it("detects skill tools", () => {
    expect(
      classifyToolAction({
        id: "1",
        agentRole: "analyst",
        agentInstanceId: "i",
        toolName: "skill.search",
        toolKind: "skill",
        status: "success",
        latencyMs: 1,
        createdAt: "",
        agentStepId: "s",
      })
    ).toBe("skill");
  });

  it("detects sandbox shell tools", () => {
    expect(
      classifyToolAction({
        id: "1",
        agentRole: "analyst",
        agentInstanceId: "i",
        toolName: "run_terminal_cmd",
        toolKind: "builtin",
        status: "success",
        latencyMs: 1,
        createdAt: "",
        agentStepId: "s",
      })
    ).toBe("sandbox");
  });

  it("isToolSuccess", () => {
    expect(isToolSuccess("success")).toBe(true);
    expect(isToolSuccess("error")).toBe(false);
  });
});

describe("isEmptyToolResponse", () => {
  it("detects empty objects and arrays", () => {
    expect(isEmptyToolResponse(null)).toBe(true);
    expect(isEmptyToolResponse({})).toBe(true);
    expect(isEmptyToolResponse([])).toBe(true);
    expect(isEmptyToolResponse({ content: "" })).toBe(true);
    expect(isEmptyToolResponse({ data: [{ text: "ok" }] })).toBe(false);
  });
});

describe("mapGraphToOfficeEvents", () => {
  it("maps llm_message to chat pair", () => {
    const events = mapGraphToOfficeEvents(
      {
        nodes: [],
        interactions: [
          {
            id: "a1",
            workflowRunId: "w",
            fromRole: "bull",
            toRole: "bear",
            kind: "llm_message",
            toolKind: null,
            toolName: null,
            contentText: "hi",
            payloadJson: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        toolCalls: [],
        mcpCalls: [],
      },
      new Set()
    );
    expect(events.some((e) => e.kind === "chat_send" && e.role === "bull")).toBe(true);
    expect(events.some((e) => e.kind === "chat_recv" && e.role === "bear")).toBe(true);
  });

  it("maps skill tool to go_shelf and empty success", () => {
    const events = mapGraphToOfficeEvents(
      {
        nodes: [],
        interactions: [],
        toolCalls: [
          {
            id: "t1",
            agentRole: "analyst",
            agentInstanceId: "i",
            toolName: "skill.list",
            toolKind: "skill",
            status: "success",
            latencyMs: 1,
            createdAt: "2026-01-01T00:00:00.000Z",
            agentStepId: "s",
            responseJson: {},
          },
        ],
        mcpCalls: [],
      },
      new Set()
    );
    expect(events.some((e) => e.kind === "go_shelf")).toBe(true);
    expect(events.some((e) => e.kind === "success_empty")).toBe(true);
  });
});
