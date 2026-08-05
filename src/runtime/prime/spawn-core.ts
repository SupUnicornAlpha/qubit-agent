/**
 * Ensure qubit-app-server is running as a child of the Bun backend.
 * Client / Tauri only starts Bun; Bun owns Core lifecycle.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAppRoot } from "../app-paths";
import { loadModelConfigSync } from "../config/model-config";
import { rustCoreBaseUrl } from "./core-runtime";

export type EnsureCoreResult = {
  url: string;
  spawned: boolean;
  pid?: number;
  bin?: string;
  reason: string;
};

let ownedChild: ReturnType<typeof Bun.spawn> | null = null;
let ownedPid: number | null = null;

function parseBind(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
    return `${host}:${u.port || "8787"}`;
  } catch {
    return "127.0.0.1:8787";
  }
}

export async function probeCoreHealth(
  baseUrl: string,
  timeoutMs = 1500
): Promise<boolean> {
  const detail = await probeCoreHealthDetail(baseUrl, timeoutMs);
  return detail.ok;
}

export type CoreHealthDetail = {
  ok: boolean;
  degradedReasons: string[];
  fakeModel: boolean;
  llmModel: string | null;
  llmBaseUrl: string | null;
  hasLlmKey: boolean;
};

/** Fetch Core /health JSON (degraded_reasons includes `fake_model` when stub LLM). */
export async function probeCoreHealthDetail(
  baseUrl: string,
  timeoutMs = 1500
): Promise<CoreHealthDetail> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        degradedReasons: [],
        fakeModel: false,
        llmModel: null,
        llmBaseUrl: null,
        hasLlmKey: false,
      };
    }
    let degradedReasons: string[] = [];
    let llmModel: string | null = null;
    let llmBaseUrl: string | null = null;
    let hasLlmKey = false;
    try {
      const body = (await res.json()) as {
        degraded_reasons?: unknown;
        llm_model?: unknown;
        llm_base_url?: unknown;
        has_llm_key?: unknown;
      };
      if (Array.isArray(body.degraded_reasons)) {
        degradedReasons = body.degraded_reasons.filter(
          (x): x is string => typeof x === "string"
        );
      }
      if (typeof body.llm_model === "string" && body.llm_model.trim()) {
        llmModel = body.llm_model.trim();
      }
      if (typeof body.llm_base_url === "string" && body.llm_base_url.trim()) {
        llmBaseUrl = body.llm_base_url.trim();
      }
      hasLlmKey = body.has_llm_key === true;
    } catch {
      /* health may be plain ok without JSON body in older builds */
    }
    return {
      ok: true,
      degradedReasons,
      fakeModel: degradedReasons.includes("fake_model"),
      llmModel,
      llmBaseUrl,
      hasLlmKey,
    };
  } catch {
    return {
      ok: false,
      degradedReasons: [],
      fakeModel: false,
      llmModel: null,
      llmBaseUrl: null,
      hasLlmKey: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve qubit-app-server binary for dev / packaged layouts. */
export function resolveAppServerBin(): string | null {
  const fromEnv = process.env.QUBIT_APP_SERVER_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const appRoot = getAppRoot();
  const cargoTarget = process.env.CARGO_TARGET_DIR?.trim();
  const candidates = [
    join(appRoot, "bin", "qubit-app-server"),
    join(appRoot, "bundle", "bin", "qubit-app-server"),
    join(appRoot, "..", "bin", "qubit-app-server"),
    join(process.cwd(), "target", "debug", "qubit-app-server"),
    join(process.cwd(), "target", "release", "qubit-app-server"),
    ...(cargoTarget
      ? [
          join(cargoTarget, "debug", "qubit-app-server"),
          join(cargoTarget, "release", "qubit-app-server"),
        ]
      : []),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function shouldSkipSpawn(): boolean {
  if (process.env.QUBIT_SKIP_CORE_SPAWN === "1") return true;
  if (process.env.NODE_ENV === "test") return true;
  // bun test preload often leaves NODE_ENV unset; detect via BUN_TEST
  if (process.env.BUN_TEST === "1" || typeof (Bun as { jest?: unknown }).jest !== "undefined") {
    /* bun test sets no standard flag; callers in tests should set SKIP */
  }
  return false;
}

/**
 * Map Bun `.qubit/model.json` (+ env) into QUBIT_LLM_* for qubit-app-server.
 * Without this, Core falls back to FakeModelClient and historically echoed prompts into chat.
 *
 * Priority (api key):
 *   1. `QUBIT_LLM_API_KEY` — explicit Core override
 *   2. `.qubit/model.json` — app default (DeepSeek/Qwen/… credentials live here)
 *   3. `OPENAI_API_KEY` — last resort
 *
 * Why model.json beats OPENAI_API_KEY: `hydrateLlmProviderEnv()` often writes a
 * stale OpenAI secret into OPENAI_API_KEY from DB. Preferring that over model.json
 * caused Core to call DeepSeek with the wrong key → HTTP 401.
 */
export function resolveCoreLlmEnv(
  env: NodeJS.ProcessEnv = process.env,
  roots?: string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  const searchRoots = (
    roots ?? [
      process.cwd(),
      getAppRoot(),
      env.QUBIT_DATA_DIR?.trim() || "",
    ]
  ).filter(Boolean);
  let cfg = null as ReturnType<typeof loadModelConfigSync>;
  for (const root of searchRoots) {
    cfg = loadModelConfigSync(root);
    if (cfg?.apiKey?.trim() || cfg?.baseUrl?.trim() || cfg?.model?.trim()) break;
  }

  const apiKey =
    env.QUBIT_LLM_API_KEY?.trim() ||
    cfg?.apiKey?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    "";
  const model =
    env.QUBIT_LLM_MODEL?.trim() ||
    cfg?.model?.trim() ||
    "";
  let baseUrl =
    env.QUBIT_LLM_BASE_URL?.trim() ||
    cfg?.baseUrl?.trim() ||
    "";

  // Ollama defaults to local OpenAI-compatible endpoint when no baseUrl set.
  if (!baseUrl && cfg?.provider === "ollama") {
    baseUrl = "http://127.0.0.1:11434/v1";
  }
  // Bun model.json sometimes stores full .../chat/completions; Core appends that path.
  baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  // DeepSeek OpenAI-compatible surface expects /v1.
  if (
    (cfg?.provider === "deepseek" || /api\.deepseek\.com$/i.test(baseUrl)) &&
    baseUrl &&
    !/\/v\d+$/i.test(baseUrl)
  ) {
    baseUrl = `${baseUrl}/v1`;
  }

  let provider =
    env.QUBIT_LLM_PROVIDER?.trim() ||
    cfg?.provider?.trim() ||
    "";
  if (!provider) {
    if (/api\.deepseek\.com/i.test(baseUrl) || /deepseek/i.test(model)) {
      provider = "deepseek";
    } else if (/11434/.test(baseUrl) || cfg?.provider === "ollama") {
      provider = "ollama";
    } else if (/anthropic/i.test(baseUrl)) {
      provider = "anthropic";
    } else if (baseUrl || model) {
      provider = "openai";
    }
  }

  if (apiKey) out.QUBIT_LLM_API_KEY = apiKey;
  if (model) out.QUBIT_LLM_MODEL = model;
  if (baseUrl) out.QUBIT_LLM_BASE_URL = baseUrl;
  if (provider) out.QUBIT_LLM_PROVIDER = provider;
  return out;
}

function normalizeBaseUrlForCompare(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  if (/api\.deepseek\.com$/i.test(s) && !/\/v\d+$/i.test(s)) s = `${s}/v1`;
  return s;
}

/** Whether a healthy Core should be restarted so it picks up Bun/model.json LLM env. */
export function shouldRespawnCoreForLlm(input: {
  health: CoreHealthDetail;
  llmEnv: Record<string, string>;
  ownedPid: number | null;
  reuseExternalCore?: boolean;
}): { respawn: boolean; reason: string } {
  const wantLlm = Boolean(
    input.llmEnv.QUBIT_LLM_API_KEY || input.llmEnv.QUBIT_LLM_BASE_URL
  );
  if (!input.health.ok || !wantLlm) {
    return { respawn: false, reason: "no_llm_refresh_needed" };
  }
  if (input.health.fakeModel) {
    return { respawn: true, reason: "fake_model_with_llm_env" };
  }
  if (!input.health.hasLlmKey && input.llmEnv.QUBIT_LLM_API_KEY) {
    return { respawn: true, reason: "core_missing_llm_key" };
  }
  const wantModel = input.llmEnv.QUBIT_LLM_MODEL?.trim() || "";
  if (wantModel && input.health.llmModel && input.health.llmModel !== wantModel) {
    return {
      respawn: true,
      reason: `llm_model_mismatch have=${input.health.llmModel} want=${wantModel}`,
    };
  }
  const wantBase = normalizeBaseUrlForCompare(input.llmEnv.QUBIT_LLM_BASE_URL);
  const haveBase = normalizeBaseUrlForCompare(input.health.llmBaseUrl);
  if (wantBase && haveBase && wantBase !== haveBase) {
    return {
      respawn: true,
      reason: `llm_base_mismatch have=${haveBase} want=${wantBase}`,
    };
  }
  // External / manually started Core may still hold a stale key even when model matches.
  // Bun owns lifecycle by default: refresh once so model.json credentials win.
  if (
    input.ownedPid === null &&
    !input.reuseExternalCore &&
    process.env.QUBIT_REUSE_EXTERNAL_CORE !== "1"
  ) {
    return { respawn: true, reason: "external_core_refresh_llm" };
  }
  return { respawn: false, reason: "llm_ok" };
}

async function tryBuildAppServer(): Promise<string | null> {
  if (process.env.QUBIT_SKIP_CORE_BUILD === "1") return null;
  if (process.env.NODE_ENV === "production") return null;
  const appRoot = getAppRoot();
  console.log("[QUBIT] qubit-app-server binary missing; running cargo build -p qubit-app-server…");
  try {
    const proc = Bun.spawn(["cargo", "build", "-p", "qubit-app-server"], {
      cwd: appRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.warn(`[QUBIT] cargo build -p qubit-app-server failed (exit=${code})`);
      return null;
    }
  } catch (e) {
    console.warn(
      `[QUBIT] cargo build -p qubit-app-server failed: ${e instanceof Error ? e.message : e}`
    );
    return null;
  }
  return resolveAppServerBin();
}

/**
 * Start Core if missing. Idempotent when already healthy (external or owned).
 */
export async function ensureRustCoreRunning(opts?: {
  rustCoreUrl?: string;
  bridgeUrl?: string;
  waitMs?: number;
}): Promise<EnsureCoreResult> {
  const url = (opts?.rustCoreUrl ?? rustCoreBaseUrl()).replace(/\/$/, "");
  const bridgeUrl =
    opts?.bridgeUrl ??
    process.env.QUBIT_LEGACY_BRIDGE_URL?.trim() ??
    "";

  const llmEnv = resolveCoreLlmEnv();
  const health = await probeCoreHealthDetail(url);
  if (health.ok) {
    const refresh = shouldRespawnCoreForLlm({
      health,
      llmEnv,
      ownedPid,
      reuseExternalCore: process.env.QUBIT_REUSE_EXTERNAL_CORE === "1",
    });
    if (!refresh.respawn) {
      return {
        url,
        spawned: false,
        reason: health.fakeModel ? "already_healthy_fake_model" : "already_healthy",
        ...(ownedPid ? { pid: ownedPid } : {}),
      };
    }
    console.warn(
      `[QUBIT] Core healthy but LLM env needs refresh (${refresh.reason}) — restarting Core with model.json credentials`
    );
    stopOwnedRustCore();
    // Also try to free the bind port if an external Core holds it.
    await tryKillListenerOnUrl(url);
  }

  if (shouldSkipSpawn()) {
    return { url, spawned: false, reason: "spawn_skipped" };
  }

  let bin = resolveAppServerBin();
  if (!bin) {
    // Dev convenience: once try cargo build so rust-strict boot does not
    // silently degrade after a clean checkout.
    const built = await tryBuildAppServer();
    bin = built ?? resolveAppServerBin();
  }
  if (!bin) {
    return {
      url,
      spawned: false,
      reason: "binary_missing (cargo build -p qubit-app-server)",
    };
  }

  // Kill previous owned child if we are re-entering after crash.
  if (ownedChild) {
    try {
      ownedChild.kill();
    } catch {
      /* ignore */
    }
    ownedChild = null;
    ownedPid = null;
  }

  const bind = parseBind(url);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string"
      )
    ),
    ...llmEnv,
    QUBIT_BIND: bind,
    RUST_LOG:
      process.env.RUST_LOG?.trim() ||
      "qubit_app_server=info,qubit_runtime=warn",
  };
  // When injecting Core LLM credentials, drop inherited OPENAI_API_KEY so a
  // hydrated stale OpenAI secret cannot override QUBIT_LLM_* inside Rust.
  if (llmEnv.QUBIT_LLM_API_KEY) {
    delete env.OPENAI_API_KEY;
  }
  if (bridgeUrl) {
    env.QUBIT_LEGACY_BRIDGE_URL = bridgeUrl;
  }
  if (llmEnv.QUBIT_LLM_API_KEY || llmEnv.QUBIT_LLM_BASE_URL) {
    console.log(
      `[QUBIT] spawning Core with LLM model=${llmEnv.QUBIT_LLM_MODEL || "(default)"} base=${llmEnv.QUBIT_LLM_BASE_URL || "(openai default)"}`
    );
  } else {
    console.warn(
      "[QUBIT] spawning Core without LLM credentials — FakeModel stub (will not echo prompts)"
    );
  }

  try {
    ownedChild = Bun.spawn([bin, "--bind", bind], {
      cwd: getAppRoot(),
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    ownedPid = ownedChild.pid;
  } catch (e) {
    return {
      url,
      spawned: false,
      bin,
      reason: `spawn_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const waitMs = opts?.waitMs ?? 20_000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await probeCoreHealth(url, 400)) {
      return {
        url,
        spawned: true,
        pid: ownedPid ?? undefined,
        bin,
        reason: "spawned",
      };
    }
    // Child died?
    const exit = ownedChild.exitCode;
    if (exit !== null) {
      ownedChild = null;
      ownedPid = null;
      return {
        url,
        spawned: false,
        bin,
        reason: `core_exited_early code=${exit}`,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url,
    spawned: true,
    pid: ownedPid ?? undefined,
    bin,
    reason: "spawned_but_health_timeout",
  };
}

/** Kill Core child owned by this Bun process (no-op if external). */
export function stopOwnedRustCore(): void {
  if (!ownedChild) return;
  try {
    ownedChild.kill();
  } catch {
    /* ignore */
  }
  ownedChild = null;
  ownedPid = null;
}

/** Best-effort: free Core bind port (dev only; macOS/Linux lsof). */
async function tryKillListenerOnUrl(url: string): Promise<void> {
  if (process.env.QUBIT_SKIP_CORE_PORT_KILL === "1") return;
  let port = "8787";
  try {
    port = new URL(url).port || "8787";
  } catch {
    /* keep default */
  }
  try {
    const proc = Bun.spawn(
      ["bash", "-lc", `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | head -5`],
      { stdout: "pipe", stderr: "ignore" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const pids = text
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
    for (const pid of pids) {
      if (ownedPid && Number(pid) === ownedPid) continue;
      try {
        process.kill(Number(pid), "SIGTERM");
        console.warn(`[QUBIT] sent SIGTERM to Core listener pid=${pid} on :${port}`);
      } catch {
        /* ignore */
      }
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 400));
  } catch {
    /* ignore */
  }
}

export function getOwnedRustCorePid(): number | null {
  return ownedPid;
}
