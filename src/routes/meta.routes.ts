/**
 * 后端"自我元信息"路由。开发期排查"代码到底有没有生效"的快速参考点。
 *
 * 典型用法：
 *   curl http://localhost:17385/api/v1/_meta/build-info
 *
 * 返回字段：
 *   pid          - 当前 backend 进程 PID
 *   startedAt    - 进程启动时间（ISO）
 *   uptimeMs     - 进程已运行毫秒
 *   commit       - 当前 git HEAD 短 hash（取自启动期一次性读取）
 *   commitFull   - 完整 hash（便于 grep diff）
 *   branch       - 当前 git 分支
 *   dirty        - 工作区是否有未提交改动（HEAD 之后的本地编辑）
 *   indexMtime   - src/index.ts 的最后修改时间，比 commit 更敏感（无需 commit 也能感知）
 *   serverMtime  - src/server.ts 的最后修改时间
 *   watchMode    - 是否在 bun --watch 下运行（QUBIT_BUN_WATCH=1 由 Tauri 注入）
 *
 * 前端 / 调用方可以拿这个 endpoint 渲染一个角标：commit 不匹配 / mtime 比 ts 早就提示
 * "后端代码可能未生效，请等 bun --watch 重启或手动 kill"。
 */

import { Hono } from "hono";
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const metaRouter = new Hono();

const STARTED_AT_MS = Date.now();
const STARTED_AT_ISO = new Date(STARTED_AT_MS).toISOString();

interface GitSnapshot {
  commit: string;
  commitFull: string;
  branch: string;
  dirty: boolean;
}

function readGitSnapshot(): GitSnapshot {
  const cwd = process.cwd();
  try {
    const commitFull = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
    const statusOut = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    return {
      commit: commitFull.slice(0, 7),
      commitFull,
      branch,
      dirty: statusOut.trim().length > 0,
    };
  } catch {
    return { commit: "unknown", commitFull: "unknown", branch: "unknown", dirty: false };
  }
}

/** 启动期读一次 git，缓存住；运行中 git 状态变化不会反映，便于"这次进程跑的是什么版本"快照。 */
const GIT = readGitSnapshot();

function safeMtime(absPath: string): string | null {
  try {
    return statSync(absPath).mtime.toISOString();
  } catch {
    return null;
  }
}

metaRouter.get("/build-info", (c) => {
  /** 解析关键源文件的当前 mtime —— 比 commit 更灵敏：dev 改了文件没 commit 也能看到。 */
  const here = dirname(fileURLToPath(import.meta.url));
  const srcRoot = dirname(here);
  const indexPath = join(srcRoot, "index.ts");
  const serverPath = join(srcRoot, "server.ts");
  return c.json({
    pid: process.pid,
    startedAt: STARTED_AT_ISO,
    uptimeMs: Date.now() - STARTED_AT_MS,
    commit: GIT.commit,
    commitFull: GIT.commitFull,
    branch: GIT.branch,
    dirty: GIT.dirty,
    indexMtime: safeMtime(indexPath),
    serverMtime: safeMtime(serverPath),
    watchMode: process.env["QUBIT_BUN_WATCH"] === "1",
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    /** mainModule 的 mtime —— bun --watch 重启后整个模块都会被重新 import，可作"代码生效"的间接信号 */
    bootMs: STARTED_AT_MS,
  });
});

/**
 * 给 banner 用：纯文本横线，方便 `tail -f dev-backend.log` 时一眼数重启次数。
 *
 * 不暴露在 router 表里，仅供 `src/index.ts` 启动期直接调用。
 */
export function formatStartupBanner(): string {
  const lines = [
    "============================================================",
    `[QUBIT] backend started`,
    `  pid          = ${process.pid}`,
    `  startedAt    = ${STARTED_AT_ISO}`,
    `  commit       = ${GIT.commit}${GIT.dirty ? " (dirty)" : ""} on ${GIT.branch}`,
    `  watchMode    = ${process.env["QUBIT_BUN_WATCH"] === "1" ? "ON (bun --watch)" : "off"}`,
    `  nodeEnv      = ${process.env["NODE_ENV"] ?? "development"}`,
    "============================================================",
  ];
  return lines.join("\n");
}
