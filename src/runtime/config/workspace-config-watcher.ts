import { createHash } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { syncWorkspaceConfigToDb } from "./config-sync";
import {
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
  loadWorkspaceRuntimeConfig,
} from "./workspace-config";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";

/**
 * workspace-config-watcher
 *
 * 把原 GraphRunner 内的「.qubit/*.json → DB」配置热加载逻辑抽成独立模块，
 * 供 A2APool（以及未来 CLI 池）复用：
 *   - `syncWorkspaceConfigToDbFromFiles()`：读 .qubit 配置写回 DB（启动 / reload 前调）；
 *   - `startWorkspaceConfigWatcher(onChange)`：监听 .qubit 顶层配置文件，内容真变化才回调；
 *   - `computeConfigHash()`：agents.json + sandbox.json 内容指纹，过滤 mtime 抖动。
 *
 * 不持有任何 runtime 状态（definitions/views/runtimes），纯配置侧；runtime 的优雅
 * stop/start 由调用方（A2APool.reload）负责。
 */

/**
 * 只关心 .qubit/ 顶层的几份配置（agents.json / sandbox.json / model.json 等），
 * 忽略 loop-runs/<workflowId>/*.json 这类执行 artifacts；
 * macOS 的 fsevents 即便 recursive:false 也会把子目录写入冒泡到这里（fileName 形如
 * "loop-runs/<id>/qubit-mcp-bridge.json"），过去会无意义地触发整池 reload。
 */
const WORKSPACE_CONFIG_WATCH_ALLOW = new Set([
  "agents.json",
  "sandbox.json",
  "model.json",
  "debate.json",
  "risk.json",
  "execution-safety.json",
]);

/**
 * 读取 .qubit 配置并同步到 DB（agent_definition / sandbox_policy）。
 * 缺文件时先 bootstrap 写出 SEED 默认配置，再 sync。
 * JSON parse 失败时跳过 sync（保留 DB 现状），仅告警。
 */
export async function syncWorkspaceConfigToDbFromFiles(): Promise<void> {
  const loaded = await loadWorkspaceRuntimeConfig();
  if (loaded.parseError) {
    console.warn(
      "[workspace-config-watcher] workspace .qubit JSON invalid, skipping file→DB sync:",
      loaded.parseError
    );
  }
  if (!loaded.config) {
    await ensureWorkspaceRuntimeConfigFiles({
      definitions: SEED_AGENT_DEFINITIONS,
      policies: buildDefaultSandboxPoliciesFromDefinitions(SEED_AGENT_DEFINITIONS),
    });
    const reloaded = await loadWorkspaceRuntimeConfig();
    if (reloaded.config) {
      await syncWorkspaceConfigToDb(reloaded.config);
    } else if (reloaded.parseError) {
      console.warn(
        "[workspace-config-watcher] workspace still invalid after bootstrap write attempt:",
        reloaded.parseError
      );
    }
    return;
  }
  await syncWorkspaceConfigToDb(loaded.config);
}

/** 计算 agents.json + sandbox.json 的内容指纹；mtime 跳但内容相同的情况就不会触发 reload。 */
export async function computeConfigHash(): Promise<string | null> {
  try {
    const root = process.cwd();
    const agentsPath = join(root, ".qubit", "agents.json");
    const sandboxPath = join(root, ".qubit", "sandbox.json");
    const [a, s] = await Promise.all([
      readFile(agentsPath, "utf-8").catch(() => ""),
      readFile(sandboxPath, "utf-8").catch(() => ""),
    ]);
    const h = createHash("sha1");
    h.update(a);
    h.update("|");
    h.update(s);
    return h.digest("hex");
  } catch {
    return null;
  }
}

export interface WorkspaceConfigWatcherHandle {
  stop(): void;
  /** 上一次成功 reload 时记下的内容指纹；watcher 用它过滤无意义抖动。 */
  setLastHash(hash: string | null): void;
}

/**
 * 启动 .qubit 配置文件 watcher。
 *
 * - 250ms debounce（与原 GraphRunner 一致）；
 * - 仅对 WORKSPACE_CONFIG_WATCH_ALLOW 内的顶层文件响应，子目录冒泡（含 "/"）直接忽略；
 * - 触发时先比内容指纹，与 lastHash 相同则跳过（macOS APFS 常见 mtime 抖动但内容没变）；
 * - 内容确实变了才调 `onChange()`（由调用方做真正的 DB sync + runtime reload），
 *   reload 成功后调用方应调 `handle.setLastHash(await computeConfigHash())`。
 */
export function startWorkspaceConfigWatcher(
  onChange: () => Promise<void>
): WorkspaceConfigWatcherHandle {
  let lastHash: string | null = null;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const watcher: FSWatcher = watch(".qubit", { recursive: false }, (_, fileName) => {
    if (!fileName || !fileName.endsWith(".json")) return;
    if (fileName.includes("/") || fileName.includes("\\")) return; // 拒绝子目录冒泡
    if (!WORKSPACE_CONFIG_WATCH_ALLOW.has(fileName)) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      void (async () => {
        if (running) return;
        running = true;
        try {
          const hash = await computeConfigHash();
          if (hash && lastHash === hash) {
            // mtime 抖动但内容没变，不必整池 reload。
            return;
          }
          await onChange();
          console.log("[workspace-config-watcher] workspace config changed, reloaded.");
        } catch (error) {
          console.error("[workspace-config-watcher] workspace config reload failed:", error);
        } finally {
          running = false;
        }
      })();
    }, 250);
  });

  return {
    stop() {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      watcher.close();
    },
    setLastHash(hash: string | null) {
      lastHash = hash;
    },
  };
}
