/**
 * Boot-time Prime Core attach: probe → activate rust.
 *
 * mode=rust never falls back to TS (production default). Only mode=auto may use ts
 * when Core is unreachable. Explicit mode=ts is emergency-only (legacy Bun ReAct).
 * QUBIT_CORE_STRICT=0 does not revive TS ReAct under rust — use mode=ts explicitly.
 */

import { syncPrimeSpecsToRustCore } from "./bootstrap";
import {
  type CoreBackend,
  getCoreRuntime,
  resetCoreRuntimeCache,
  resolveCoreBackend,
  rustCoreBaseUrl,
} from "./core-runtime";

export type PrimeAttachMode = "ts" | "rust" | "auto";

export type PrimeAttachStatus = {
  mode: PrimeAttachMode;
  activeBackend: CoreBackend;
  rustCoreUrl: string;
  healthy: boolean;
  syncedSpecs: number | null;
  reason: string;
  attachedAtMs: number;
};

let status: PrimeAttachStatus | null = null;

export function getPrimeAttachStatus(): PrimeAttachStatus | null {
  return status;
}

export function resolveAttachMode(
  raw: string | undefined = process.env.QUBIT_CORE_BACKEND
): PrimeAttachMode {
  const v = (raw ?? "rust").trim().toLowerCase();
  if (v === "rust" || v === "ts" || v === "auto") return v;
  return "rust";
}

/** mode=rust defaults strict; auto/ts do not. Explicit QUBIT_CORE_STRICT=0 opts out. */
export function resolveCoreStrict(mode: PrimeAttachMode, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const raw = process.env.QUBIT_CORE_STRICT?.trim();
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return mode === "rust";
}

async function probeRustHealth(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { core_backend?: string } | null;
    return body?.core_backend === "rust" || res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function activateBackend(backend: CoreBackend): void {
  process.env.QUBIT_CORE_BACKEND = backend;
  resetCoreRuntimeCache();
}

/**
 * Probe / sync Rust Core and set process-level QUBIT_CORE_BACKEND.
 * Safe to call once at boot; subsequent calls refresh status.
 */
export async function attachPrimeCore(opts?: {
  mode?: PrimeAttachMode;
  rustCoreUrl?: string;
  strict?: boolean;
}): Promise<PrimeAttachStatus> {
  const mode = opts?.mode ?? resolveAttachMode();
  const rustCoreUrl = (opts?.rustCoreUrl ?? rustCoreBaseUrl()).replace(/\/$/, "");
  process.env.QUBIT_RUST_CORE_URL = rustCoreUrl;
  const strict = resolveCoreStrict(mode, opts?.strict);

  const finish = (partial: Omit<PrimeAttachStatus, "mode" | "rustCoreUrl" | "attachedAtMs">) => {
    status = {
      mode,
      rustCoreUrl,
      attachedAtMs: Date.now(),
      ...partial,
    };
    return status;
  };

  if (mode === "ts") {
    activateBackend("ts");
    return finish({
      activeBackend: "ts",
      healthy: true,
      syncedSpecs: null,
      reason: "mode=ts",
    });
  }

  const healthy = await probeRustHealth(rustCoreUrl);
  if (!healthy) {
    if (strict || mode === "rust") {
      // Never rewrite env to ts when debugging / defaulting to rust.
      activateBackend("rust");
      return finish({
        activeBackend: "rust",
        healthy: false,
        syncedSpecs: null,
        reason: `strict: rust core unreachable at ${rustCoreUrl}`,
      });
    }
    activateBackend("ts");
    return finish({
      activeBackend: "ts",
      healthy: false,
      syncedSpecs: null,
      reason: `auto: rust unreachable at ${rustCoreUrl}; using ts`,
    });
  }

  activateBackend("rust");
  try {
    getCoreRuntime();
    const synced = await syncPrimeSpecsToRustCore();
    return finish({
      activeBackend: "rust",
      healthy: true,
      syncedSpecs: synced.upserted,
      reason: `attached rust primary=${synced.summary.primaryId}`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (strict || mode === "rust") {
      return finish({
        activeBackend: "rust",
        healthy: false,
        syncedSpecs: null,
        reason: `sync failed (strict): ${msg}`,
      });
    }
    activateBackend("ts");
    return finish({
      activeBackend: "ts",
      healthy: false,
      syncedSpecs: null,
      reason: `sync failed; fallback ts: ${msg}`,
    });
  }
}

/** Test helper */
export function resetPrimeAttachStatus(): void {
  status = null;
}

export function activeCoreBackend(): CoreBackend {
  return status?.activeBackend ?? resolveCoreBackend();
}
