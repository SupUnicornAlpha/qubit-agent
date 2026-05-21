import { getBackendBaseUrl, setBackendBaseUrl } from "./client";

function isTauriEnv(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * 与 `scripts/build-app.sh`、Tauri sidecar、`src/runtime/app-paths.ts` 一致。
 * 必须 <49152，避免落入 macOS 临时端口区间被其它进程随机抢占。
 */
export const PACKAGED_BACKEND_PORT = 17_385;
export const PACKAGED_BACKEND_URL = `http://127.0.0.1:${PACKAGED_BACKEND_PORT}`;

function builtInBackendUrl(): string {
  const fromEnv = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : PACKAGED_BACKEND_URL;
}

/**
 * 桌面模式下将 API 根地址固定到打包端口。
 *
 * 覆盖策略：当本地缓存指向 localhost/127.0.0.1 但端口与当前 `PACKAGED_BACKEND_PORT` 不一致时
 * 强制刷新到内置 URL（覆盖历史遗留的 :3000、:38473 等旧端口）；非 localhost 的远程地址保留，
 * 允许用户在配置中心显式指向自部署后端。
 */
export function syncBackendUrlForDesktop(): void {
  if (!isTauriEnv()) return;
  const target = builtInBackendUrl();
  const current = getBackendBaseUrl();
  if (!current) {
    setBackendBaseUrl(target);
    return;
  }
  if (isStaleLocalBackendUrl(current, target)) {
    setBackendBaseUrl(target);
  }
}

function isStaleLocalBackendUrl(current: string, target: string): boolean {
  try {
    const cur = new URL(current);
    const tgt = new URL(target);
    const isLocal = cur.hostname === "localhost" || cur.hostname === "127.0.0.1";
    if (!isLocal) return false;
    return cur.port !== tgt.port;
  } catch {
    return true;
  }
}
