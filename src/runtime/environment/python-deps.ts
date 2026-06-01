/**
 * Python pip 依赖管理 —— `pip list` 扫描、与 env_registry 期望清单 diff、
 * 异步 install / uninstall（写 env_install_log）。
 *
 * 设计要点（DESIGN §6.1 / 决议 §10.1）：
 *   - **不**用 `pip install -r requirements.txt` 一锅端：粒度太粗、失败定位
 *     差；UI 上"装一个"也得有按包按钮，因此 install API 单包粒度。
 *   - 安装是异步任务：路由层立刻插入 env_install_log(status='running')
 *     并返回 logId；后台 promise 跑完后 update 同行 → success / failed /
 *     timeout（决议 §10.2，前端短轮询）。
 *   - **不**走 sandbox 黑白名单：env-mgr 路由只允许已登录的 user 请求，
 *     `pip install <name>` 中的 name 必须能匹配 PEP 503 normalize 规则
 *     （`^[A-Za-z0-9._-]+$`），版本约束限定 6 种算子，避免任意 shell 注入。
 *   - 已装包扫描结果按 PEP 503 lower-case 化，diff 时也走相同规范化，避免
 *     `Pandas` vs `pandas` 误判 mismatch。
 *
 * 复用：
 *   - 不复用 src/util/python-oneshot.ts —— 那是 `bin scriptPath args` 形态，
 *     pip 是 `bin -m pip ...` 不带脚本路径，直接 Bun.spawn 更直白。
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../../config";
import { getDb } from "../../db/sqlite/client";
import { envInstallLog } from "../../db/sqlite/schema";
import { resolvePythonBin } from "../app-paths";
import { envRegistryService } from "./registry-service";
import type { ExpectedPackage, InstalledPackage, PackageDiff } from "./types";
import { satisfies } from "./version-spec";

/** install / uninstall / list 子进程超时；pip 装大包（如 pandas / scipy）可能 60s+ */
const PIP_INSTALL_TIMEOUT_MS = 5 * 60_000;
const PIP_UNINSTALL_TIMEOUT_MS = 60_000;
const PIP_LIST_TIMEOUT_MS = 30_000;

/** 包名注入防御：与 PEP 503 兼容的标识子集，加 `[extras]` 不允许（env-mgr 内部禁用）。 */
const SAFE_PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 版本约束总长度上限，超过则拒绝（防止 100KB shell payload）。 */
const SAFE_SPEC_MAX = 256;

export class PythonDepsError extends Error {
  constructor(public readonly code: PythonDepsErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PythonDepsError";
  }
}

export type PythonDepsErrorCode =
  | "invalid_package_name"
  | "invalid_version_spec"
  | "pip_failed"
  | "timeout";

export interface PipListItem {
  name: string;
  version: string;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProcess(
  cmd: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(extraEnv ?? {}) } as Record<string, string>,
  });
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    clearTimeout(t);
  }
}

function pythonBin(): string {
  return resolvePythonBin(config.dataDir);
}

/** 规范化 PEP 503：lowercase + `_` / `.` → `-`。 */
export function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[._]+/g, "-");
}

function assertSafeName(name: string): void {
  if (!SAFE_PACKAGE_NAME.test(name)) {
    throw new PythonDepsError("invalid_package_name", `unsafe package name: ${name}`);
  }
}
function assertSafeSpec(spec: string | null | undefined): void {
  if (!spec) return;
  if (spec.length > SAFE_SPEC_MAX) {
    throw new PythonDepsError("invalid_version_spec", "spec too long");
  }
  // 允许：== >= <= > < != ~=、数字、点、逗号、加号、星号、字母（dev/rc/post）、空格、+local、@URL 一律不允许
  if (!/^[<>=!~,.\s0-9A-Za-z*+-]+$/.test(spec) || /[@;|`$]/.test(spec)) {
    throw new PythonDepsError("invalid_version_spec", `unsafe version spec: ${spec}`);
  }
}

/** `python -m pip list --format=json` → InstalledPackage[]，name 已 PEP 503 规范化。 */
export async function listInstalledPython(): Promise<InstalledPackage[]> {
  const r = await runProcess(
    [pythonBin(), "-m", "pip", "list", "--format=json", "--disable-pip-version-check"],
    PIP_LIST_TIMEOUT_MS
  );
  if (r.timedOut)
    throw new PythonDepsError("timeout", `pip list timed out after ${PIP_LIST_TIMEOUT_MS}ms`);
  if (r.exitCode !== 0) {
    throw new PythonDepsError(
      "pip_failed",
      `pip list exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 400)}`
    );
  }
  let parsed: PipListItem[] = [];
  try {
    parsed = JSON.parse(r.stdout) as PipListItem[];
  } catch (e) {
    throw new PythonDepsError(
      "pip_failed",
      `pip list stdout not JSON: ${(e as Error).message} | head=${r.stdout.slice(0, 200)}`
    );
  }
  return parsed.map((it) => ({
    name: normalizePackageName(it.name),
    version: it.version,
  }));
}

/** 用 satisfies() 把 expected ✕ installed 拆成 satisfied / missing / mismatch / orphan */
export function diffPackages(
  expected: ExpectedPackage[],
  installed: InstalledPackage[]
): PackageDiff {
  const installedByName = new Map<string, InstalledPackage>();
  for (const it of installed) installedByName.set(normalizePackageName(it.name), it);

  const seenExpected = new Set<string>();
  const satisfied: ExpectedPackage[] = [];
  const missing: ExpectedPackage[] = [];
  const versionMismatch: PackageDiff["versionMismatch"] = [];

  for (const exp of expected) {
    if (exp.status === "disabled") continue;
    const key = normalizePackageName(exp.name);
    seenExpected.add(key);
    const got = installedByName.get(key);
    if (!got) {
      missing.push(exp);
      continue;
    }
    if (satisfies(got.version, exp.effectiveVersionSpec)) {
      satisfied.push(exp);
    } else {
      versionMismatch.push({ expected: exp, installed: got });
    }
  }

  const orphan = installed.filter((it) => !seenExpected.has(normalizePackageName(it.name)));
  return { expected, installed, satisfied, missing, versionMismatch, orphan };
}

export interface InstallTaskRequest {
  packageName: string;
  versionSpec?: string | null;
  triggeredBy?: string;
}
export interface InstallTaskResult {
  logId: string;
  /** 仅暴露给测试 / 路由内部对账；前端走轮询，不应 await 该 promise。 */
  done: Promise<void>;
}

/** 跑 `pip install <pkg><spec>`。spec 形如 `>=0.2.40` 或 `==1.0.11`。 */
export async function installPython(req: InstallTaskRequest): Promise<InstallTaskResult> {
  const name = req.packageName.trim();
  assertSafeName(name);
  assertSafeSpec(req.versionSpec ?? null);

  const db = await getDb();
  const logId = randomUUID();
  await db.insert(envInstallLog).values({
    id: logId,
    kind: "python",
    operation: "install",
    packageName: name,
    requestedVersion: req.versionSpec ?? null,
    installedVersion: null,
    status: "running",
    triggeredBy: req.triggeredBy ?? "user",
  });

  const target = req.versionSpec ? `${name}${req.versionSpec}` : name;
  const done = (async () => {
    const r = await runProcess(
      [pythonBin(), "-m", "pip", "install", "--disable-pip-version-check", target],
      PIP_INSTALL_TIMEOUT_MS
    );
    let status: "success" | "failed" | "timeout";
    let installedVersion: string | null = null;
    let errorMessage: string | null = null;
    if (r.timedOut) {
      status = "timeout";
      errorMessage = `pip install timed out after ${PIP_INSTALL_TIMEOUT_MS}ms`;
    } else if (r.exitCode !== 0) {
      status = "failed";
      errorMessage = (r.stderr || r.stdout || "(no output)").slice(0, 800);
    } else {
      status = "success";
      installedVersion = await detectInstalledVersion(name);
    }
    await db
      .update(envInstallLog)
      .set({
        status,
        installedVersion,
        errorMessage,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(envInstallLog.id, logId));
  })().catch(async (err) => {
    await db
      .update(envInstallLog)
      .set({
        status: "failed",
        errorMessage: (err as Error).message.slice(0, 800),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(envInstallLog.id, logId));
  });
  return { logId, done };
}

export async function uninstallPython(req: {
  packageName: string;
  triggeredBy?: string;
}): Promise<InstallTaskResult> {
  assertSafeName(req.packageName.trim());

  const db = await getDb();
  const logId = randomUUID();
  await db.insert(envInstallLog).values({
    id: logId,
    kind: "python",
    operation: "uninstall",
    packageName: req.packageName,
    requestedVersion: null,
    installedVersion: null,
    status: "running",
    triggeredBy: req.triggeredBy ?? "user",
  });

  const done = (async () => {
    const r = await runProcess(
      [pythonBin(), "-m", "pip", "uninstall", "-y", req.packageName],
      PIP_UNINSTALL_TIMEOUT_MS
    );
    let status: "success" | "failed" | "timeout";
    let errorMessage: string | null = null;
    if (r.timedOut) {
      status = "timeout";
      errorMessage = `pip uninstall timed out after ${PIP_UNINSTALL_TIMEOUT_MS}ms`;
    } else if (r.exitCode !== 0) {
      status = "failed";
      errorMessage = (r.stderr || r.stdout || "(no output)").slice(0, 800);
    } else {
      status = "success";
    }
    await db
      .update(envInstallLog)
      .set({
        status,
        errorMessage,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(envInstallLog.id, logId));
  })().catch(async (err) => {
    await db
      .update(envInstallLog)
      .set({
        status: "failed",
        errorMessage: (err as Error).message.slice(0, 800),
        finishedAt: new Date().toISOString(),
      })
      .where(eq(envInstallLog.id, logId));
  });
  return { logId, done };
}

/** install 成功后从 pip list 找一下落定版本（best-effort）。 */
async function detectInstalledVersion(name: string): Promise<string | null> {
  try {
    const all = await listInstalledPython();
    const got = all.find((it) => normalizePackageName(it.name) === normalizePackageName(name));
    return got?.version ?? null;
  } catch {
    return null;
  }
}

/** 给定 expected 列表 + (可选) 已装快照，构造 diff；不传 installed 则现采。 */
export async function buildPythonDiff(
  expectedOverride?: ExpectedPackage[]
): Promise<PackageDiff> {
  const expected =
    expectedOverride ?? (await envRegistryService.list({ kind: "python" }));
  const installed = await listInstalledPython();
  return diffPackages(expected, installed);
}
