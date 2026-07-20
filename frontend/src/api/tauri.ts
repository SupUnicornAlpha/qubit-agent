import { invoke } from "@tauri-apps/api/core";
import { getHealth } from "./backend";
import { PACKAGED_BACKEND_URL, syncBackendUrlForDesktop } from "./packaged-backend";

export function isTauriEnv(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export interface TauriBackendStatus {
  running: boolean;
  ready: boolean;
  phase: "stopped" | "starting" | "ready";
  pid: number | null;
  port: string;
  url: string;
  error?: string;
}

const stoppedStatus = (): TauriBackendStatus => ({
  running: false,
  ready: false,
  phase: "stopped",
  pid: null,
  port: "17385",
  url: PACKAGED_BACKEND_URL,
});

export async function tauriStartBackend(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return stoppedStatus();
  }
  syncBackendUrlForDesktop();
  return invoke<TauriBackendStatus>("start_backend");
}

export async function tauriStopBackend(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return stoppedStatus();
  }
  return invoke<TauriBackendStatus>("stop_backend");
}

export async function tauriRestartBackend(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return stoppedStatus();
  }
  syncBackendUrlForDesktop();
  return invoke<TauriBackendStatus>("restart_backend");
}

export async function tauriBackendStatus(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return stoppedStatus();
  }
  return invoke<TauriBackendStatus>("backend_status");
}

/** 等待内置后端真正可请求；进程提前退出时不再无意义地等满超时。 */
export async function waitForTauriBackendHealth(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    const status = await tauriBackendStatus().catch((error) => {
      lastError = error;
      return null;
    });
    if (status && !status.running) {
      throw new Error(status.error ?? "内置后端进程已退出");
    }

    try {
      return await getHealth();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error");
  throw new Error(`等待内置后端就绪超时：${detail}`);
}
