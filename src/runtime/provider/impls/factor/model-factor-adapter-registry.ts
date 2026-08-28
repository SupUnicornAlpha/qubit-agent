/**
 * ModelFactorAdapter 进程内注册表。
 *
 * 外部训练平台可在进程启动后调用 `registerModelFactorAdapter` 挂载自定义实现；
 * 也可使用内置 `http` adapter，通过 binding.adapterConfig.endpoint 对接。
 */

import {
  type ModelFactorAdapter,
  ModelFactorContractError,
} from "../../model-factor-contract";
import { createHttpModelFactorAdapter } from "./http-model-factor-adapter";

const adapters = new Map<string, ModelFactorAdapter>();

let builtinsReady = false;

function ensureBuiltins(): void {
  if (builtinsReady) return;
  builtinsReady = true;
  adapters.set("http", createHttpModelFactorAdapter());
}

export function registerModelFactorAdapter(adapter: ModelFactorAdapter): void {
  ensureBuiltins();
  const key = adapter.key?.trim();
  if (!key) {
    throw new ModelFactorContractError("invalid_binding", "adapter.key is required");
  }
  if (key === "http") {
    throw new ModelFactorContractError(
      "invalid_binding",
      "adapter key 'http' is reserved for the builtin HTTP bridge"
    );
  }
  adapters.set(key, adapter);
}

export function unregisterModelFactorAdapter(key: string): void {
  ensureBuiltins();
  if (key === "http") return;
  adapters.delete(key);
}

export function getModelFactorAdapter(key: string): ModelFactorAdapter {
  ensureBuiltins();
  const adapter = adapters.get(key.trim());
  if (!adapter) {
    throw new ModelFactorContractError(
      "adapter_missing",
      `model_factor_adapter_not_registered: ${key}`,
      { adapterKey: key, registered: listModelFactorAdapterKeys() }
    );
  }
  return adapter;
}

export function listModelFactorAdapterKeys(): string[] {
  ensureBuiltins();
  return [...adapters.keys()].sort();
}

export function listModelFactorAdapters(): ModelFactorAdapter[] {
  ensureBuiltins();
  return [...adapters.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 测试用：清空自定义 adapter，保留 builtin http。 */
export function _resetModelFactorAdaptersForTests(): void {
  adapters.clear();
  builtinsReady = false;
  ensureBuiltins();
}
