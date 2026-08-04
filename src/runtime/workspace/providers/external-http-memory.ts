/**
 * external.http_memory — 外部记忆适配样例（未配置 endpoint 时明确失败）。
 * 真实实现可在进程启动时 `registerMemoryProvider("my.org.memory", factory)` 覆盖。
 */
import type { MemoryProvider } from "./fs-memory";

export const EXTERNAL_HTTP_MEMORY_KIND = "external.http_memory";

export function createExternalHttpMemoryStub(): MemoryProvider {
  const fail = async (): Promise<never> => {
    throw new Error(
      `${EXTERNAL_HTTP_MEMORY_KIND} is a registry stub. Configure endpoint in .qubit/providers/memory.json ` +
        `and register a real factory via registerMemoryProvider(), or switch kind to builtin.fs_memory.`
    );
  };

  return {
    kind: EXTERNAL_HTTP_MEMORY_KIND,
    list: fail,
    get: fail,
    upsert: fail,
    remove: fail,
    search: fail,
    loadBootstrap: fail,
  };
}
