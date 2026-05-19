import { getBackendBaseUrl, setBackendBaseUrl } from "./client";

function isTauriEnv(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 与 `scripts/build-app.sh`、Tauri sidecar 一致，避免占用 3000 */
export const PACKAGED_BACKEND_PORT = 38_473;
export const PACKAGED_BACKEND_URL = `http://127.0.0.1:${PACKAGED_BACKEND_PORT}`;

function builtInBackendUrl(): string {
  const fromEnv = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : PACKAGED_BACKEND_URL;
}

/** 桌面模式下将 API 根地址固定到打包端口（覆盖曾保存的 3000 开发地址）。 */
export function syncBackendUrlForDesktop(): void {
  if (!isTauriEnv()) return;
  const target = builtInBackendUrl();
  const current = getBackendBaseUrl();
  if (!current || /:(3000)(\/|$)/.test(current)) {
    setBackendBaseUrl(target);
  }
}
