/**
 * A2A gather（请求-应答关联层）单测。
 *
 * 锁住三条关键行为：
 *   1. expect 登记的 taskId 收到匹配 TASK_RESULT → 按 taskId 关联 resolve；
 *   2. 不匹配的 taskId 不会误 resolve（直到超时）；
 *   3. 没等到回包 → 超时兜底（timedOut=true, success=false）。
 */
import { describe, expect, test } from "bun:test";
import { a2aRouter } from "../../../messaging/a2a";
import { getA2AGather } from "../a2a-gather";

function sendTaskResult(
  taskId: string,
  success = true,
  result: Record<string, unknown> = {}
): Promise<void> {
  return a2aRouter.send({
    workflowId: "wf-gather",
    traceId: "tr-gather",
    // 非 UUID sender → 持久化跳过，不污染 DB；只验证总线路由 + 关联。
    senderAgent: "test-sender",
    receiverAgent: "orchestrator",
    messageType: "TASK_RESULT",
    payload: { taskId, success, result, durationMs: 0 },
    priority: 50,
  });
}

describe("A2AGather.expect", () => {
  test("匹配 taskId 的 TASK_RESULT 到达 → 按 taskId 关联 resolve", async () => {
    const gather = getA2AGather();
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    const pending = gather.expect([t1, t2], { timeoutMs: 5000 });

    await sendTaskResult(t1, true, { tag: "one" });
    await sendTaskResult(t2, false, { tag: "two" });

    const results = await pending;
    expect(results.get(t1)?.success).toBe(true);
    expect((results.get(t1)?.result as { tag?: string })?.tag).toBe("one");
    expect(results.get(t2)?.success).toBe(false);
    expect(results.get(t2)?.timedOut).toBeUndefined();
  });

  test("无关 taskId 的 TASK_RESULT 不会误 resolve（命中超时兜底）", async () => {
    const gather = getA2AGather();
    const wanted = crypto.randomUUID();
    const unrelated = crypto.randomUUID();
    const pending = gather.expect([wanted], { timeoutMs: 120 });

    // 发一条别的任务回执——不应让 wanted 提前 resolve。
    await sendTaskResult(unrelated, true, {});

    const results = await pending;
    expect(results.get(wanted)?.timedOut).toBe(true);
    expect(results.get(wanted)?.success).toBe(false);
  });

  test("从不回包 → 超时兜底", async () => {
    const gather = getA2AGather();
    const t = crypto.randomUUID();
    const results = await gather.expect([t], { timeoutMs: 80 });
    expect(results.get(t)?.timedOut).toBe(true);
    expect(results.get(t)?.errorMessage).toBe("a2a_gather_timeout");
  });
});
