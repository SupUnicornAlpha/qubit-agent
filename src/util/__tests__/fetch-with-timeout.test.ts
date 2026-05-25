/**
 * P0-4：fetchWithTimeout 防止裸 fetch 挂起导致整次 ReAct 卡住的回归测试。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  FetchTimeoutError,
  fetchWithTimeout,
} from "../fetch-with-timeout";

describe("fetchWithTimeout", () => {
  test("正常请求成功返回", async () => {
    /**
     * 直接 mock 全局 fetch；不依赖网络，避免在 sandbox / CI 中拨号外网。
     */
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (_input: unknown, _init?: RequestInit) => {
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      const res = await fetchWithTimeout("https://example.test/x");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("内部 timer 到时抛 FetchTimeoutError", async () => {
    const original = globalThis.fetch;
    try {
      /** mock fetch 永远不返回 —— 模拟 TCP 挂起；靠 signal abort 触发 reject */
      globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as typeof fetch;

      await expect(fetchWithTimeout("https://example.test/hang", undefined, 50)).rejects.toThrow(
        FetchTimeoutError
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test("外部 AbortSignal 也能触发 abort（保留原 reason）", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted by external");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as typeof fetch;

      const ctrl = new AbortController();
      const p = fetchWithTimeout("https://example.test/external", { signal: ctrl.signal }, 5_000);
      setTimeout(() => ctrl.abort(), 30);
      await expect(p).rejects.toThrow();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("默认 timeout 是 15s", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(15_000);
  });
});
