/**
 * mcp-bin 下 npm 包管理 —— 扫描已装、与 env_registry 期望清单 diff、异步
 * install / uninstall（写 env_install_log）。
 *
 * 设计要点（DESIGN §6.2 / 决议 §10.6）：
 *   - 仅管理 stdio 类 MCP 的 npm 包；HTTP/WS 类（mathjs / tradingcalc）不
 *     入此视图，避免混淆"包"与"远程服务"两种生命周期。
 *   - 共用 `<dataDir>/mcp-bin/` 目录与 mcp/package-manager.ts —— 那边走的
 *     是"懒装：第一次 spawn 时 install"，我们的 install API 是显式预装；
 *     两条路径写到同一个 node_modules，互不冲突（bun add 是幂等的）。
 *   - install/uninstall 同样用 env_install_log 记录异步状态。
 *   - 仅识别"name + version"形式的 npm 包；带 `git+...` / `file:` 协议的
 *     包名一律拒绝（与 python-deps 的安全策略对齐）。
 *
 * 已知限制：
 *   - 不解析 npm 的 semver 约束语义（^ ~ x.x.x）；diff 时 spec='==a.b.c'
 *     就直接比 string equal，其他算子退化为 PEP 440 子集（够用就行）。
 *     真正的依赖求解仍交给 bun add / npm install。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { envInstallLog } from "../../db/sqlite/schema";
import { getMcpBinDir } from "../mcp/package-manager";
import { envRegistryService } from "./registry-service";
import type { ExpectedPackage, InstalledPackage, PackageDiff } from "./types";
import { satisfies } from "./version-spec";

const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
const NPM_UNINSTALL_TIMEOUT_MS = 60_000;

/** 允许 scoped 包：`@scope/name` 或 `name`；禁止 `@github:user/repo` 等协议形式。 */
const SAFE_NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SAFE_NPM_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

export class NpmDepsError extends Error {
  constructor(public readonly code: NpmDepsErrorCode, message?: string) {
    super(message ?? code);
    this.name = "NpmDepsError";
  }
}
export type NpmDepsErrorCode = "invalid_package_name" | "invalid_version" | "timeout" | "install_failed";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProcess(cmd: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
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

function assertSafeNpmName(name: string): void {
  if (!SAFE_NPM_NAME.test(name)) {
    throw new NpmDepsError("invalid_package_name", `unsafe npm package name: ${name}`);
  }
}
function assertSafeNpmVersion(v: string | null | undefined): void {
  if (v == null || v === "") return;
  if (!SAFE_NPM_VERSION.test(v)) {
    throw new NpmDepsError("invalid_version", `unsafe npm version: ${v}`);
  }
}

/**
 * 扫描 `<mcp-bin>/node_modules/`：每个一级子目录视作一个已装包；scoped
 * 包按 `@scope/name` 形式枚举。读取各自 package.json 提取 (name, version)。
 *
 * 不依赖 `bun list` / `npm ls`，因为它们对子目录中遗留的 .lock 异常更挑剔，
 * 我们只关心"这个 name 在硬盘上存在哪个 version"。
 */
export function listInstalledNpm(): InstalledPackage[] {
  const root = join(getMcpBinDir(), "node_modules");
  if (!existsSync(root)) return [];
  const out: InstalledPackage[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (ent.startsWith(".")) continue; // 跳过 .bin / .cache
    if (ent.startsWith("@")) {
      // scoped：再下一层
      let inner: string[] = [];
      try {
        inner = readdirSync(join(root, ent));
      } catch {
        continue;
      }
      for (const sub of inner) {
        const pj = readPackageJson(join(root, ent, sub));
        if (pj) out.push({ name: pj.name, version: pj.version, installPath: join(root, ent, sub) });
      }
    } else {
      const pj = readPackageJson(join(root, ent));
      if (pj) out.push({ name: pj.name, version: pj.version, installPath: join(root, ent) });
    }
  }
  return out;
}

function readPackageJson(dir: string): { name: string; version: string } | null {
  const pjPath = join(dir, "package.json");
  if (!existsSync(pjPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(pjPath, "utf-8")) as { name?: string; version?: string };
    if (!raw.name || !raw.version) return null;
    return { name: raw.name, version: raw.version };
  } catch {
    return null;
  }
}

export function diffNpm(expected: ExpectedPackage[], installed: InstalledPackage[]): PackageDiff {
  const installedByName = new Map<string, InstalledPackage>();
  for (const it of installed) installedByName.set(it.name, it);

  const seen = new Set<string>();
  const satisfied: ExpectedPackage[] = [];
  const missing: ExpectedPackage[] = [];
  const versionMismatch: PackageDiff["versionMismatch"] = [];

  for (const exp of expected) {
    if (exp.status === "disabled") continue;
    seen.add(exp.name);
    const got = installedByName.get(exp.name);
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

  const orphan = installed.filter((it) => !seen.has(it.name));
  return { expected, installed, satisfied, missing, versionMismatch, orphan };
}

export interface NpmInstallTaskRequest {
  packageName: string;
  version?: string | null;
  triggeredBy?: string;
}

export interface NpmInstallTaskResult {
  logId: string;
  done: Promise<void>;
}

/** `bun add <pkg>@<ver>`，cwd=mcp-bin；失败回退 npm install。env_install_log 全程记录。 */
export async function installNpm(req: NpmInstallTaskRequest): Promise<NpmInstallTaskResult> {
  assertSafeNpmName(req.packageName);
  assertSafeNpmVersion(req.version ?? null);

  const db = await getDb();
  const logId = randomUUID();
  await db.insert(envInstallLog).values({
    id: logId,
    kind: "npm",
    operation: "install",
    packageName: req.packageName,
    requestedVersion: req.version ?? null,
    installedVersion: null,
    status: "running",
    triggeredBy: req.triggeredBy ?? "user",
  });

  const cwd = await ensureMcpBinDirReady();
  const spec = req.version ? `${req.packageName}@${req.version}` : req.packageName;

  const done = (async () => {
    let lastErr: string | null = null;
    let exitOk = false;
    for (const cmd of [
      ["bun", "add", spec],
      ["npm", "install", spec, "--no-audit", "--no-fund", "--loglevel=error"],
    ]) {
      let r: RunResult;
      try {
        r = await runProcess(cmd, cwd, NPM_INSTALL_TIMEOUT_MS);
      } catch (e) {
        lastErr = (e as Error).message;
        continue;
      }
      if (r.timedOut) {
        lastErr = `${cmd[0]} install timed out after ${NPM_INSTALL_TIMEOUT_MS}ms`;
        continue;
      }
      if (r.exitCode === 0) {
        exitOk = true;
        break;
      }
      lastErr = (r.stderr || r.stdout || "(no output)").slice(0, 800);
    }

    let installedVersion: string | null = null;
    if (exitOk) {
      const got = listInstalledNpm().find((it) => it.name === req.packageName);
      installedVersion = got?.version ?? null;
    }

    await db
      .update(envInstallLog)
      .set({
        status: exitOk ? "success" : "failed",
        installedVersion,
        errorMessage: exitOk ? null : lastErr,
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

export async function uninstallNpm(req: {
  packageName: string;
  triggeredBy?: string;
}): Promise<NpmInstallTaskResult> {
  assertSafeNpmName(req.packageName);
  const db = await getDb();
  const logId = randomUUID();
  await db.insert(envInstallLog).values({
    id: logId,
    kind: "npm",
    operation: "uninstall",
    packageName: req.packageName,
    requestedVersion: null,
    installedVersion: null,
    status: "running",
    triggeredBy: req.triggeredBy ?? "user",
  });

  const cwd = await ensureMcpBinDirReady();
  const done = (async () => {
    let exitOk = false;
    let lastErr: string | null = null;
    for (const cmd of [
      ["bun", "remove", req.packageName],
      ["npm", "uninstall", req.packageName, "--no-audit", "--no-fund", "--loglevel=error"],
    ]) {
      let r: RunResult;
      try {
        r = await runProcess(cmd, cwd, NPM_UNINSTALL_TIMEOUT_MS);
      } catch (e) {
        lastErr = (e as Error).message;
        continue;
      }
      if (r.timedOut) {
        lastErr = `${cmd[0]} uninstall timed out`;
        continue;
      }
      if (r.exitCode === 0) {
        exitOk = true;
        break;
      }
      lastErr = (r.stderr || r.stdout || "").slice(0, 800);
    }
    await db
      .update(envInstallLog)
      .set({
        status: exitOk ? "success" : "failed",
        errorMessage: exitOk ? null : lastErr,
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

async function ensureMcpBinDirReady(): Promise<string> {
  const dir = getMcpBinDir();
  await Bun.write(join(dir, ".keep"), "");
  // 最小 package.json 防止 bun/npm 把当前 cwd 当 monorepo workspace
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) {
    await Bun.write(
      pj,
      JSON.stringify(
        { name: "qubit-mcp-bin", private: true, version: "0.0.0" },
        null,
        2
      )
    );
  }
  return dir;
}

/** expected = env_registry kind='npm'；不传 installed 则现扫。 */
export async function buildNpmDiff(expectedOverride?: ExpectedPackage[]): Promise<PackageDiff> {
  const expected = expectedOverride ?? (await envRegistryService.list({ kind: "npm" }));
  const installed = listInstalledNpm();
  return diffNpm(expected, installed);
}
