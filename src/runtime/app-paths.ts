import { spawnSync } from "node:child_process";
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

/**
 * 预下载的 Python wheel 仓库；与 `requirements.txt` 同目录的 `wheels/`。
 * bootstrap 时若该目录存在且包含 .whl，会优先走 `pip install --no-index --find-links`，
 * 实现离线 / 弱网首次装机。脚本 `scripts/build-python-wheels.sh` 负责生成。
 */
export function getPythonWheelsDir(): string {
  return join(getPythonConnectorsDir(), "wheels");
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

/**
 * 进程级缓存："这个候选路径试过没有"。
 *   - undefined: 没试过
 *   - true: 跑得通（exit 0）
 *   - false: 跑挂（dyld error / 非零退出 / spawn 失败）
 *
 * 为什么需要：candidates 里第一项 `${appRoot}/python-venv/bin/python3` 在打包构建后
 * 会落一个**坏 venv 软链**（`dyld: Library not loaded: @executable_path/../Python3`），
 * `existsSync` 看到文件就直接返回 → `code.run_python` 跑起来必报 `python_exit_nonzero`。
 * 增加一次性 `--version` 探针，spawn 失败的候选自动跳过，进程内缓存避免每次都试。
 */
const pythonBinValidityCache = new Map<string, boolean>();

function pythonBinUsable(bin: string): boolean {
  const cached = pythonBinValidityCache.get(bin);
  if (cached !== undefined) return cached;
  let usable = false;
  try {
    const r = spawnSync(bin, ["--version"], {
      timeout: 5_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    usable = r.status === 0;
  } catch {
    usable = false;
  }
  pythonBinValidityCache.set(bin, usable);
  return usable;
}

/** 测试钩子 */
export function _resetPythonBinCacheForTest(): void {
  pythonBinValidityCache.clear();
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
  /**
   * 2026-05-27 P2 修复：之前只判 existsSync，遇到坏 venv 软链（如 src-tauri/target/
   * debug/bundle 下的 python3 软链，dyld 找不到 Python3 framework）会被选中，
   * 结果 `code.run_python` 永远报 python_exit_nonzero。改为 existsSync + 一次性
   * `--version` 探针，spawn 失败的候选自动跳过，让 fallback 链路真正发挥作用。
   */
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    if (pythonBinUsable(p)) return p;
  }
  return process.platform === "win32" ? "python" : "python3";
}

export function defaultDataDir(): string {
  return process.env["QUBIT_DATA_DIR"]?.trim() || join(homedir(), ".quant-agent");
}

export function isPackagedRuntime(): boolean {
  return Boolean(process.env["QUBIT_APP_ROOT"]?.trim());
}
