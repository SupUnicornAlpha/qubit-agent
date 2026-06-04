/**
 * MCP npm 包一次性安装到 `<dataDir>/mcp-bin`，spawn 走绝对路径。
 *
 * 为什么需要：
 *   现状下绝大多数 stdio MCP（mcp-financex / fmp-mcp / 第三方 npm 包）都用
 *   `npx -y <pkg>@<ver>` 启动。`npx -y` 每次都要查 npm registry，首次往往要
 *   10-30 秒，弱网/受限网络下直接失败；并且没有"一次安装、永久离线可用"的语义。
 *
 *   本模块把 `npx -y pkg@ver args...` 一次性变换成 `node_modules/.bin/<bin> args...`：
 *     1) 首次启动时检测到尚未安装 → 调用 `bun install --cwd <mcp-bin>` 装包
 *     2) 解析包的 `package.json#bin` 取得入口可执行文件
 *     3) 转换 argv，后续启动直接 spawn 绝对路径，秒级
 *
 *   失败时（npm 不可用、包不存在等）回退到原 npx argv，保留旧行为，不阻断启动。
 *
 * 范围限定：
 *   - 只处理 `npx -y / --yes` 这一种语法，其它命令一概透传
 *   - 不处理 Windows .cmd / .ps1（用户群以 macOS/Linux 为主）；遇到时透传
 *   - 不解析 package.json#bin 的对象形式时，回退到包名最后一段（约定大于配置）
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config";

interface NpxSpec {
  pkg: string;
  version?: string;
  binArgs: string[];
}

interface PackageJsonShape {
  name?: string;
  bin?: string | Record<string, string>;
}

/**
 * 解析 `npx -y <pkg>[@<ver>] [args...]` / `npx --yes <pkg> [args...]`。
 * 返回 null 表示这不是 npx 启动模式（也就不需要本模块管）。
 */
export function parseNpxArgv(argv: readonly string[]): NpxSpec | null {
  if (argv.length < 2) return null;
  const [head, ...rest] = argv;
  if (!head) return null;
  const isNpx = head === "npx" || head.endsWith("/npx") || head.endsWith("\\npx");
  if (!isNpx) return null;
  let i = 0;
  /*
   * 跳过 npx 自己的 flag：-y / --yes / --package=... / --quiet 等。
   * 第一个不以 - 开头的 token 视为包说明（pkg 或 pkg@ver）。
   */
  while (i < rest.length) {
    const tok = rest[i];
    if (tok === undefined) break;
    if (tok === "-y" || tok === "--yes" || tok === "--quiet" || tok === "--silent") {
      i += 1;
      continue;
    }
    if (tok.startsWith("--")) {
      i += 1;
      continue;
    }
    break;
  }
  const pkgToken = rest[i];
  if (!pkgToken) return null;
  const binArgs = rest.slice(i + 1);

  /*
   * scoped 包名形如 @scope/name 或 @scope/name@x.y.z。
   * 非 scoped 包形如 name 或 name@x.y.z。
   * 我们只在最后一个 '@' 后切分版本号，避免误把 scope 的 '@' 当成分隔。
   */
  let pkg: string;
  let version: string | undefined;
  const isScoped = pkgToken.startsWith("@");
  const lastAt = pkgToken.lastIndexOf("@");
  if (isScoped && lastAt > 0) {
    pkg = pkgToken.slice(0, lastAt);
    version = pkgToken.slice(lastAt + 1) || undefined;
  } else if (!isScoped && lastAt > 0) {
    pkg = pkgToken.slice(0, lastAt);
    version = pkgToken.slice(lastAt + 1) || undefined;
  } else {
    pkg = pkgToken;
  }
  return version === undefined ? { pkg, binArgs } : { pkg, version, binArgs };
}

/** 用于把 pkg 名映射到 mcp-bin 下的安装位置；EnvironmentManager 同样复用此目录。 */
export function getMcpBinDir(): string {
  return join(config.dataDir, "mcp-bin");
}

function pkgInstallDir(pkg: string): string {
  return join(getMcpBinDir(), "node_modules", pkg);
}

function resolveBinPath(pkg: string, pkgJson: PackageJsonShape): string | null {
  const binDir = join(getMcpBinDir(), "node_modules", ".bin");
  const tryBins: string[] = [];
  if (typeof pkgJson.bin === "string") {
    /*
     * `bin: "./dist/cli.js"` 这种形式：bin 名约定为 package.json#name 最后一段。
     * 例如 `@houtini/fmp-mcp` → `.bin/fmp-mcp`
     */
    const last = pkg.split("/").pop();
    if (last) tryBins.push(last);
  } else if (pkgJson.bin && typeof pkgJson.bin === "object") {
    for (const k of Object.keys(pkgJson.bin)) tryBins.push(k);
  } else {
    const last = pkg.split("/").pop();
    if (last) tryBins.push(last);
  }
  for (const name of tryBins) {
    const full = join(binDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

async function ensureMcpBinDir(): Promise<void> {
  const dir = getMcpBinDir();
  await mkdir(dir, { recursive: true });
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) {
    /*
     * 在 mcp-bin 下写一个最小 package.json，避免 npm 把它当成 monorepo 的子目录、
     * 或把 node_modules 装到上游父目录里。
     */
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      pj,
      JSON.stringify(
        {
          name: "qubit-mcp-bin",
          private: true,
          version: "0.0.0",
          description: "Qubit MCP package store",
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

/**
 * 在 `<dataDir>/mcp-bin` 中安装一个 npm 包。优先用 bun（速度快、不需要 npm CLI）；
 * 找不到 bun 时回退到 npm。安装失败抛错。
 */
async function installNpmPackage(pkg: string, version: string | undefined): Promise<void> {
  await ensureMcpBinDir();
  const spec = version ? `${pkg}@${version}` : pkg;
  const cwd = getMcpBinDir();
  /*
   * 走 bun add 而不是 bun install <pkg>：后者只会装项目自己的 deps，不会新增依赖项。
   * 失败后再尝试 npm install，作为最后兜底。
   */
  const candidates: string[][] = [
    ["bun", "add", spec],
    ["npm", "install", spec, "--no-audit", "--no-fund", "--loglevel=error"],
  ];
  let lastErr: Error | null = null;
  for (const argv of candidates) {
    try {
      const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
      const [, stderr, exit] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      if (exit === 0) return;
      lastErr = new Error(`${argv.join(" ")} exited ${exit}: ${stderr.slice(0, 400)}`);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error("install failed");
}

interface ResolveResult {
  argv: string[];
  /** 是否做了 npx→绝对路径 的转换；false 表示原样透传 */
  rewritten: boolean;
  /** 调试用信息：本次实际定位到的 bin 路径（如有） */
  binPath?: string;
}

/**
 * 进程内缓存：(pkg, version) → bin 绝对路径。
 * - 命中：直接返回，零开销
 * - 未命中：检查磁盘 → 若已装好，缓存；否则触发一次性 install
 * - install 失败：缓存失败状态（在 inflight 结束后清理，避免阻塞重试）
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKey(pkg: string, version?: string): string {
  return version ? `${pkg}@${version}` : pkg;
}

async function ensureInstalledAndResolveBin(
  pkg: string,
  version: string | undefined
): Promise<string | null> {
  const key = cacheKey(pkg, version);
  const hit = cache.get(key);
  if (hit && existsSync(hit)) return hit;
  const existingFlight = inflight.get(key);
  if (existingFlight) return existingFlight;

  const flight = (async () => {
    const installDir = pkgInstallDir(pkg);
    const pjPath = join(installDir, "package.json");
    if (!existsSync(pjPath)) {
      try {
        await installNpmPackage(pkg, version);
      } catch (e) {
        console.warn(`[mcp-pm] install ${key} failed:`, (e as Error).message);
        return null;
      }
    }
    if (!existsSync(pjPath)) return null;
    let pkgJson: PackageJsonShape;
    try {
      pkgJson = JSON.parse(readFileSync(pjPath, "utf8")) as PackageJsonShape;
    } catch {
      return null;
    }
    const bin = resolveBinPath(pkg, pkgJson);
    if (bin) cache.set(key, bin);
    return bin;
  })();
  inflight.set(key, flight);
  try {
    return await flight;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 尝试把 `npx -y pkg@ver args...` 转换成 `<mcp-bin>/.bin/<bin> args...`。
 * - 非 npx argv → 原样返回（rewritten=false）
 * - 转换失败 → 原样返回 + console.warn，不阻断启动
 */
export async function resolveMcpStdioArgv(argv: readonly string[]): Promise<ResolveResult> {
  const spec = parseNpxArgv(argv);
  if (!spec) return { argv: [...argv], rewritten: false };
  const binPath = await ensureInstalledAndResolveBin(spec.pkg, spec.version);
  if (!binPath) return { argv: [...argv], rewritten: false };
  return { argv: [binPath, ...spec.binArgs], rewritten: true, binPath };
}

/** 测试钩子 */
export function _resetMcpPackageManagerCache(): void {
  cache.clear();
  inflight.clear();
}
