import { describe, expect, it } from "bun:test";
import { executeWithPolicy } from "../policy";

const NO_RETRY = { maxAttempts: 1, backoffMs: 0, backoffMultiplier: 1 };
const RETRY_2 = { maxAttempts: 2, backoffMs: 0, backoffMultiplier: 1 };
const NEVER_OPEN = { failureThreshold: 999, cooldownMs: 60_000 };

function uniqueScope(name: string): string {
  return `${name}:${Math.random().toString(36).slice(2)}`;
}

describe("executeWithPolicy onAttemptFailure", () => {
  it("不调用 onAttemptFailure 当首次即成功", async () => {
    const failures: number[] = [];
    const result = await executeWithPolicy(
      {
        scopeKey: uniqueScope("ok"),
        retry: RETRY_2,
        circuitBreaker: NEVER_OPEN,
      },
      async () => "done",
      { onAttemptFailure: (attempt) => failures.push(attempt) }
    );
    expect(result).toBe("done");
    expect(failures).toEqual([]);
  });

  it("每次中途失败都回调 onAttemptFailure（即便最终成功）", async () => {
    const failures: number[] = [];
    let calls = 0;
    const result = await executeWithPolicy(
      {
        scopeKey: uniqueScope("retry-then-ok"),
        retry: RETRY_2,
        circuitBreaker: NEVER_OPEN,
      },
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient blip");
        return "recovered";
      },
      { onAttemptFailure: (attempt) => failures.push(attempt) }
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
    // attempt 1 失败应被记一次；attempt 2 成功不记
    expect(failures).toEqual([1]);
  });

  it("全部失败时每次 attempt 都回调", async () => {
    const failures: number[] = [];
    await expect(
      executeWithPolicy(
        {
          scopeKey: uniqueScope("all-fail"),
          retry: RETRY_2,
          circuitBreaker: NEVER_OPEN,
        },
        async () => {
          throw new Error("always down");
        },
        { onAttemptFailure: (attempt) => failures.push(attempt) }
      )
    ).rejects.toThrow("always down");
    expect(failures).toEqual([1, 2]);
  });

  it("onAttemptFailure 自身抛错不影响主流程（回调失败被吞）", async () => {
    let calls = 0;
    const result = await executeWithPolicy(
      {
        scopeKey: uniqueScope("cb-throws"),
        retry: RETRY_2,
        circuitBreaker: NEVER_OPEN,
      },
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("blip");
        return "ok";
      },
      {
        onAttemptFailure: () => {
          throw new Error("callback boom");
        },
      }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("不传 options 时行为与原来一致（向后兼容）", async () => {
    const result = await executeWithPolicy(
      { scopeKey: uniqueScope("legacy"), retry: NO_RETRY, circuitBreaker: NEVER_OPEN },
      async () => 42
    );
    expect(result).toBe(42);
  });
});
