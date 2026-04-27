import { invoke } from "@tauri-apps/api/core";

function isTauriEnv(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function tauriStartBackend(): Promise<void> {
  if (!isTauriEnv()) return;
  await invoke("start_backend");
}

export async function tauriStopBackend(): Promise<void> {
  if (!isTauriEnv()) return;
  await invoke("stop_backend");
}

export async function tauriBackendStatus(): Promise<{ running: boolean; pid: number | null }> {
  if (!isTauriEnv()) return { running: false, pid: null };
  return invoke<{ running: boolean; pid: number | null }>("backend_status");
}

