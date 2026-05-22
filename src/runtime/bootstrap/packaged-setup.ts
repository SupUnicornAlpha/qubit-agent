import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../../config";
import { runMigrations } from "../../db/sqlite/migrate";
import { getPythonConnectorsDir, getPythonWheelsDir, resolvePythonBin } from "../app-paths";
import { seedAgentDefinitions } from "../seed-agent-definitions";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import {
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
} from "../config/workspace-config";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";

export type BootstrapResult = {
  migrations: boolean;
  seed: boolean;
  pythonVenv: "skipped" | "existing" | "created" | "failed";
  pythonMessage?: string;
  dataDir: string;
  appRoot: string;
};

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function ensurePythonVenv(dataDir: string): Promise<{
  status: BootstrapResult["pythonVenv"];
  message?: string;
}> {
  const python = resolvePythonBin(dataDir);
  if (python.includes("python-venv")) {
    return { status: "existing" };
  }

  const reqPath = join(getPythonConnectorsDir(), "requirements.txt");
  if (!existsSync(reqPath)) {
    return { status: "skipped", message: "requirements.txt not found in bundle" };
  }

  const venvDir = join(dataDir, "python-venv");
  const venvPython =
    process.platform === "win32"
      ? join(venvDir, "Scripts", "python.exe")
      : join(venvDir, "bin", "python3");

  if (existsSync(venvPython)) {
    process.env["QUBIT_PYTHON"] = venvPython;
    return { status: "existing" };
  }

  const systemPy = process.platform === "win32" ? "python" : "python3";
  const create = await runProcess(systemPy, ["-m", "venv", venvDir], { cwd: dataDir });
  if (create.code !== 0) {
    return {
      status: "failed",
      message: `venv create failed: ${create.stderr.slice(0, 500)}`,
    };
  }

  /*
   * 优先离线装：如果 python_connectors/wheels/ 里有 .whl 文件（通常由
   * scripts/build-python-wheels.sh 在 CI / 发版前预下载），就用
   * `pip install --no-index --find-links wheels/`，避免触网；
   * 失败或没 wheel 时回退到联网安装（保持向后兼容）。
   */
  const wheelsDir = getPythonWheelsDir();
  const hasWheels =
    existsSync(wheelsDir) && readdirSync(wheelsDir).some((f) => f.endsWith(".whl"));
  let pipMessage = "";
  if (hasWheels) {
    const offline = await runProcess(
      venvPython,
      ["-m", "pip", "install", "--no-index", "--find-links", wheelsDir, "-r", reqPath],
      { cwd: getPythonConnectorsDir() }
    );
    if (offline.code === 0) {
      process.env["QUBIT_PYTHON"] = venvPython;
      return { status: "created", message: "installed from offline wheels" };
    }
    pipMessage = `offline pip install failed (${offline.stderr.slice(0, 200)}), falling back to network`;
    console.warn(`[bootstrap] ${pipMessage}`);
  }

  const pip = await runProcess(venvPython, ["-m", "pip", "install", "-r", reqPath], {
    cwd: getPythonConnectorsDir(),
  });
  if (pip.code !== 0) {
    return {
      status: "failed",
      message: `pip install failed: ${pip.stderr.slice(0, 800)}`,
    };
  }

  process.env["QUBIT_PYTHON"] = venvPython;
  return { status: "created", ...(pipMessage ? { message: pipMessage } : {}) };
}

/**
 * 安装包首次启动或用户触发「系统初始化」：迁移 DB、种子 Agent/MCP/Tool、可选 Python venv。
 */
export async function runPlatformBootstrap(options?: {
  skipPython?: boolean;
}): Promise<BootstrapResult> {
  const dataDir = config.dataDir;
  await mkdir(join(dataDir, "db"), { recursive: true });

  let pythonVenv: BootstrapResult["pythonVenv"] = "skipped";
  let pythonMessage: string | undefined;

  if (!options?.skipPython) {
    const py = await ensurePythonVenv(dataDir);
    pythonVenv = py.status;
    pythonMessage = py.message;
  }

  await runMigrations();
  await seedAgentDefinitions();
  await ensureWorkspaceRuntimeConfigFiles({
    definitions: SEED_AGENT_DEFINITIONS,
    policies: buildDefaultSandboxPoliciesFromDefinitions(SEED_AGENT_DEFINITIONS),
    refresh: true,
  });
  await registerBuiltinConnectors();

  return {
    migrations: true,
    seed: true,
    pythonVenv,
    ...(pythonMessage !== undefined ? { pythonMessage } : {}),
    dataDir,
    appRoot: process.env["QUBIT_APP_ROOT"]?.trim() || process.cwd(),
  };
}
