/**
 * 验证 SSE 心跳：保证连接在长时间无业务事件时也会持续吐 `: hb` 注释，
 * 进而不会触达 Bun.serve idleTimeout 而被切断。
 *
 * 用 fake timer 跳过真实 25s 等待。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stepStreamBus } from "./event-stream";

const decoder = new TextDecoder();

async function readOne(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done || value === undefined) return "";
  return decoder.decode(value);
}

describe("StepStreamBus heartbeat", () => {
  let originalSetInterval: typeof setInterval;
  let originalClearInterval: typeof clearInterval;
  let pendingIntervals: Array<{ id: number; cb: () => void; ms: number }>;
  let nextIntervalId: number;

  beforeEach(() => {
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    pendingIntervals = [];
    nextIntervalId = 1;

    (globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((
      cb: () => void,
      ms: number,
    ) => {
      const id = nextIntervalId++;
      pendingIntervals.push({ id, cb, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    (globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = ((
      handle: ReturnType<typeof setInterval>,
    ) => {
      const id = handle as unknown as number;
      pendingIntervals = pendingIntervals.filter((entry) => entry.id !== id);
    }) as typeof clearInterval;
  });

  afterEach(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  function tickAllOnce(): void {
    for (const entry of [...pendingIntervals]) {
      entry.cb();
    }
  }

  test("注册 SSE 流后会启动 heartbeat 定时器", async () => {
    const runId = `hb-test-${Date.now()}`;
    const stream = stepStreamBus.createSseStream(runId);
    const reader = stream.getReader();

    /** 第一次 read：拿到 ": stream-open\n\n" */
    const open = await readOne(reader);
    expect(open).toContain("stream-open");

    /** start() 内调用了 startHeartbeat → 应该有 1 个 pending interval */
    expect(pendingIntervals.length).toBe(1);
    expect(pendingIntervals[0]?.ms).toBe(25_000);

    /** 触发 1 次心跳 → 下一次 read 拿到 ": hb <ts>" 注释 */
    tickAllOnce();
    const hb = await readOne(reader);
    expect(hb.startsWith(": hb ")).toBe(true);

    /** 取消订阅后 timer 必须被清掉，避免泄漏 */
    await reader.cancel();
    expect(pendingIntervals.length).toBe(0);
  });

  test("close(runId) 会清掉对应的 heartbeat 定时器", async () => {
    const runId = `hb-close-${Date.now()}`;
    const stream = stepStreamBus.createSseStream(runId);
    const reader = stream.getReader();
    await readOne(reader); // consume stream-open

    expect(pendingIntervals.length).toBe(1);

    stepStreamBus.close(runId);

    /** safeClose 会 clearInterval → pendingIntervals 必须清空 */
    expect(pendingIntervals.length).toBe(0);

    /** reader 也应该读到 done */
    const tail = await reader.read();
    expect(tail.done).toBe(true);
  });
});
