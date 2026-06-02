/**
 * ExperienceBus 行为单测 — Memory V2 P0
 *
 * 覆盖：
 *   - subscribe / emit 强类型路由
 *   - 同 type 多 handler 全部触发
 *   - unsubscribe 后不再触发
 *   - sync handler 抛错不污染后续 handler
 *   - async handler 错误被吞并 warn（不 unhandled rejection）
 *   - awaitIdle 等待全部 async handler 完成
 *   - clearAllForTesting 清空
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ExperienceBus,
  type ExperienceEvent,
  getExperienceBus,
  setExperienceBusForTesting,
} from "../experience-bus";

let bus: ExperienceBus;

beforeEach(() => {
  setExperienceBusForTesting(null); // 强制重建
  bus = getExperienceBus();
});

afterEach(() => {
  bus.clearAllForTesting();
});

const SAMPLE_TERMINAL_EVENT: Extract<ExperienceEvent, { type: "workflow_terminal" }> = {
  type: "workflow_terminal",
  workflowRunId: "wf-1",
  projectId: "proj-1",
  status: "completed",
};

describe("ExperienceBus — subscribe / emit / unsubscribe", () => {
  test("subscribe 后能收到 emit；handler 拿到强类型 event", () => {
    let captured: Extract<ExperienceEvent, { type: "workflow_terminal" }> | null = null;
    bus.subscribe("workflow_terminal", (ev) => {
      captured = ev;
    });
    bus.emit(SAMPLE_TERMINAL_EVENT);
    expect(captured).not.toBeNull();
    const ev = captured as Extract<ExperienceEvent, { type: "workflow_terminal" }>;
    expect(ev.workflowRunId).toBe("wf-1");
    expect(ev.projectId).toBe("proj-1");
    expect(ev.status).toBe("completed");
  });

  test("不同 type 互相隔离", () => {
    let stepHits = 0;
    let terminalHits = 0;
    bus.subscribe("step_emitted", () => {
      stepHits += 1;
    });
    bus.subscribe("workflow_terminal", () => {
      terminalHits += 1;
    });
    bus.emit(SAMPLE_TERMINAL_EVENT);
    expect(stepHits).toBe(0);
    expect(terminalHits).toBe(1);
  });

  test("同 type 多 handler 全部触发；顺序不强约束但 P0 是注册顺序", () => {
    const order: string[] = [];
    bus.subscribe("workflow_terminal", () => order.push("a"));
    bus.subscribe("workflow_terminal", () => order.push("b"));
    bus.emit(SAMPLE_TERMINAL_EVENT);
    expect(order.sort()).toEqual(["a", "b"]);
    expect(bus.handlerCount("workflow_terminal")).toBe(2);
  });

  test("unsubscribe 返回值能正确移除 handler", () => {
    let hits = 0;
    const off = bus.subscribe("workflow_terminal", () => {
      hits += 1;
    });
    bus.emit(SAMPLE_TERMINAL_EVENT);
    off();
    bus.emit(SAMPLE_TERMINAL_EVENT);
    expect(hits).toBe(1);
    expect(bus.handlerCount("workflow_terminal")).toBe(0);
  });

  test("无订阅者时 emit 不抛错", () => {
    expect(() => bus.emit(SAMPLE_TERMINAL_EVENT)).not.toThrow();
  });
});

describe("ExperienceBus — 错误隔离", () => {
  test("同步 handler 抛错不阻塞同 type 的其它 handler", () => {
    let bRan = false;
    bus.subscribe("workflow_terminal", () => {
      throw new Error("a fails");
    });
    bus.subscribe("workflow_terminal", () => {
      bRan = true;
    });
    expect(() => bus.emit(SAMPLE_TERMINAL_EVENT)).not.toThrow();
    expect(bRan).toBe(true);
  });

  test("async handler 失败被吞 + warn；不引发 unhandled rejection", async () => {
    let bRan = false;
    bus.subscribe("workflow_terminal", async () => {
      throw new Error("async a fails");
    });
    bus.subscribe("workflow_terminal", async () => {
      bRan = true;
    });
    bus.emit(SAMPLE_TERMINAL_EVENT);
    await bus.awaitIdle();
    expect(bRan).toBe(true);
  });
});

describe("ExperienceBus — awaitIdle", () => {
  test("等待所有 async handler settle", async () => {
    let done = false;
    bus.subscribe("workflow_terminal", async () => {
      await new Promise((r) => setTimeout(r, 20));
      done = true;
    });
    bus.emit(SAMPLE_TERMINAL_EVENT);
    expect(done).toBe(false);
    await bus.awaitIdle();
    expect(done).toBe(true);
  });

  test("handler 内部再次 emit 引发的链也会被等到", async () => {
    let outerDone = false;
    let innerDone = false;
    bus.subscribe("workflow_terminal", async () => {
      await new Promise((r) => setTimeout(r, 5));
      outerDone = true;
      bus.emit({
        type: "experience_executed",
        experienceId: "exp-1",
        workflowRunId: "wf-1",
        outcome: "success",
      });
    });
    bus.subscribe("experience_executed", async () => {
      await new Promise((r) => setTimeout(r, 5));
      innerDone = true;
    });
    bus.emit(SAMPLE_TERMINAL_EVENT);
    await bus.awaitIdle();
    expect(outerDone).toBe(true);
    expect(innerDone).toBe(true);
  });
});

describe("ExperienceBus — clearAllForTesting", () => {
  test("清空后所有 type 的 handler 均归零", () => {
    bus.subscribe("workflow_terminal", () => {});
    bus.subscribe("step_emitted", () => {});
    bus.clearAllForTesting();
    expect(bus.handlerCount("workflow_terminal")).toBe(0);
    expect(bus.handlerCount("step_emitted")).toBe(0);
  });
});
