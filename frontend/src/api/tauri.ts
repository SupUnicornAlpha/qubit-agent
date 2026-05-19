import { invoke } from "@tauri-apps/api/core";
import { PACKAGED_BACKEND_URL, syncBackendUrlForDesktop } from "./packaged-backend";

export function isTauriEnv(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export interface TauriBackendStatus {
  running: boolean;
  pid: number | null;
  port: string;
  url: string;
  error?: string;
}

export async function tauriStartBackend(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return { running: false, pid: null, port: "38473", url: PACKAGED_BACKEND_URL };
  }
  syncBackendUrlForDesktop();
  return invoke<TauriBackendStatus>("start_backend");
}

export async function tauriStopBackend(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return { running: false, pid: null, port: "38473", url: PACKAGED_BACKEND_URL };
  }
  return invoke<TauriBackendStatus>("stop_backend");
}

export async function tauriRestartBackend(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return { running: false, pid: null, port: "38473", url: PACKAGED_BACKEND_URL };
  }
  syncBackendUrlForDesktop();
  return invoke<TauriBackendStatus>("restart_backend");
}

export async function tauriBackendStatus(): Promise<TauriBackendStatus> {
  if (!isTauriEnv()) {
    return { running: false, pid: null, port: "38473", url: PACKAGED_BACKEND_URL };
  }
  return invoke<TauriBackendStatus>("backend_status");
}
