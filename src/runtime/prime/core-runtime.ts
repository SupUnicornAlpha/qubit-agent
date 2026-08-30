/**
 * Process-level Core backend valve (01 §11.4 / O13 / Phase A).
 * QUBIT_CORE_BACKEND=ts|rust|auto (default rust at attach; config default rust).
 * After attach, env is rewritten to ts|rust only.
 * `ts` is emergency-only — TsCoreStub is not a working Core.
 */

import { RustCoreClient } from "./rust-core-client";
import type { CoreRuntime } from "./types";

export type CoreBackend = "ts" | "rust";

let cached: CoreRuntime | null = null;
let cachedBackend: CoreBackend | null = null;

export function resolveCoreBackend(): CoreBackend {
  const raw = (process.env.QUBIT_CORE_BACKEND ?? "auto").trim().toLowerCase();
  if (raw === "rust") return "rust";
  // "auto" / "ts" / unknown → ts until attachPrimeCore rewrites env to rust
  return "ts";
}

export function rustCoreBaseUrl(): string {
  return process.env.QUBIT_RUST_CORE_URL?.trim() || "http://127.0.0.1:8787";
}

/**
 * TS Core stub — valve placeholder when `QUBIT_CORE_BACKEND=ts` (emergency only).
 * Not a working Core: no sessions/turns. Production must use rust.
 */
class TsCoreStub implements CoreRuntime {
  async health() {
    return {
      status: "degraded",
      uptime_ms: 0,
      active_turns: 0,
      registered_turns: 0,
      hitl_waiting: 0,
      core_backend: "ts",
      degraded_reasons: [
        "ts_core_stub_not_a_core",
        "emergency_backend_only",
        "use_QUBIT_CORE_BACKEND=rust",
      ],
    };
  }
  async listAgents() {
    return { agents: [] };
  }
  async upsertAgent() {
    /* no-op stub */
  }
  async createSession(): Promise<never> {
    throw new Error(
      "TsCoreRuntime stub is not a Core (Phase A). Set QUBIT_CORE_BACKEND=rust and start qubit-app-server."
    );
  }
  async getSession(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async sessionSnapshot(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async startTurn(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async cancelTurn(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async invokeAgent(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async ingestTrigger(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async hitlRespond(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
  async hitlInboxList(): Promise<never> {
    throw new Error("TsCoreRuntime stub");
  }
}

export function getCoreRuntime(): CoreRuntime {
  const backend = resolveCoreBackend();
  if (cached && cachedBackend === backend) return cached;
  cachedBackend = backend;
  cached = backend === "rust" ? new RustCoreClient(rustCoreBaseUrl()) : new TsCoreStub();
  return cached;
}

/** Test helper — reset singleton. */
export function resetCoreRuntimeCache(): void {
  cached = null;
  cachedBackend = null;
}
