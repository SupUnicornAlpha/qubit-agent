/**
 * 全局测试 preload：把 `QUBIT_DATA_DIR` 指向一个临时目录，隔离所有测试对真实
 * `~/.quant-agent` 生产库的写入。
 *
 * 背景（2026-06 复盘）：~190 个测试在 `beforeAll` 里 `runMigrations()` + 直接
 * `db.insert(workspace/project/...)`，但因为 `getDb()` 解析的是 `config.dataDir`
 * （默认 `~/.quant-agent`），这些写入全部打到了**真实生产库**，攒出几十个
 * 测试残留 workspace/project，污染监控页与 default project 选择逻辑。
 *
 * 修复范式：bun test 用 `--preload`（bunfig.toml [test].preload）在**任何被测模块
 * import 之前**执行本文件，抢先把 `QUBIT_DATA_DIR` 改写到 tmp。关键时序：
 * `src/config.ts` 的 `config = loadConfig()` 与 `defaultDataDir()` 都在模块加载期
 * **eager** 读 `process.env.QUBIT_DATA_DIR`，所以必须在它被 import 之前设好。
 *
 * 注意：
 *   - 整个 `bun test` 进程共享同一个 tmp dir（一份 DB）。这只解决「不碰生产库」，
 *     不解决测试之间的 UNIQUE 冲突 —— 后者各测试用 randomUUID 自行规避（既有约定）。
 *   - 已经在文件顶部自行 `process.env.QUBIT_DATA_DIR = mkdtempSync(...)` 的少数测试
 *     （native-memory-connector.bugfix / reconciliation.integration 等）会在各自模块
 *     加载时再次覆盖本值，保持其 per-file 隔离，不受影响。
 *   - 不主动删 tmp dir：进程退出后由 OS 回收；保留也便于失败时排查。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 仅当外部没显式指定时才接管（允许 CI / 调试用 QUBIT_DATA_DIR=... 覆盖）。
if (!process.env["QUBIT_DATA_DIR"]?.trim()) {
  const dir = mkdtempSync(join(tmpdir(), "qubit-test-"));
  process.env["QUBIT_DATA_DIR"] = dir;
  // HOME 一并指向 tmp：少数测试用 `~/.quant-agent` 衍生路径或写 HOME 下文件。
  process.env["HOME"] = dir;
  console.log(`[test-setup] QUBIT_DATA_DIR -> ${dir}`);
}
