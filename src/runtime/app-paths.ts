import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 桌面安装包内后端固定端口（与 `scripts/build-app.sh`、Tauri sidecar、`frontend/src/api/packaged-backend.ts` 一致）。
 * 必须 <49152，避免落入 macOS 临时端口区间被其它进程随机抢占。
 */
export const PACKAGED_BACKEND_PORT = 17_385;

/**
 * 应用资源根目录：含 `python_connectors`、`content-packs`、`db/migrations` 等。
 * 开发时为仓库根；安装包内由 Tauri 设置 `QUBIT_APP_ROOT`。
 */
export function getAppRoot(): string {
  const root = process.env["QUBIT_APP_ROOT"]?.trim();
  if (root) return root;
  return process.cwd();
}

export function getPythonConnectorsDir(): string {
  return join(getAppRoot(), "python_connectors");
}

export function getContentPacksDir(): string {
  return join(getAppRoot(), "content-packs");
}

export function getBundledMigrationsDir(): string {
  return join(getAppRoot(), "db", "migrations");
}

export function migrationsDirAvailable(): boolean {
  return existsSync(getBundledMigrationsDir());
}

/** 解析 Python 解释器：显式 env → 资源内 venv → 数据目录 venv → 系统 python3 */
export function resolvePythonBin(dataDir: string): string {
  const explicit = process.env["QUBIT_PYTHON"]?.trim();
  if (explicit) return explicit;

  const candidates = [
    join(getAppRoot(), "python-venv", "bin", "python3"),
    join(getAppRoot(), "python-venv", "Scripts", "python.exe"),
    join(dataDir, "python-venv", "bin", "python3"),
    join(dataDir, "python-venv", "Scripts", "python.exe"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export function defaultDataDir(): string {
  return process.env["QUBIT_DATA_DIR"]?.trim() || join(homedir(), ".quant-agent");
}

export function isPackagedRuntime(): boolean {
  return Boolean(process.env["QUBIT_APP_ROOT"]?.trim());
}
