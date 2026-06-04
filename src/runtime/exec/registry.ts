/**
 * Exec 能力源注册表
 *
 * PoC 阶段不入库，先用静态 TS 表 + 可选用户配置文件覆盖（`$dataDir/exec-providers.json`）。
 * 跑通后再决定要不要拆到 DB 表。
 *
 * 设计哲学（参考 mcp_server_config 治理模型）：
 *   - 默认**只允许白名单内的 binary**；agent 无论传什么都先过这张表
 *   - 内置一组对量化研究有明确价值且模型先验强的命令（git/jq/duckdb/rg）+ 主流 agentic CLI
 *     （claude-code / aider），其他 binary 由用户在 `exec-providers.json` 显式注册
 *   - curl 这种"有用但风险高"的命令 PoC 阶段先不放，等加完 host allowlist 治理再开
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDataDir } from "../agent/agent-pack-service";
import type { ExecProvider } from "./types";

/**
 * 内置 Exec Provider 白名单。
 *
 * 选择标准：
 *   1. **模型先验强**：LLM 训练数据里有大量 man page / SO / GitHub 用例，不需 schema 说明
 *   2. **量化研究有用**：git（策略版本化）/ jq（处理 yfinance/akshare json）/
 *      duckdb（直接查 parquet/sqlite 数据集）/ rg（搜工作流目录）
 *   3. **副作用可控**：默认 workflow-scoped cwd，不能越界
 */
const BUILTIN_PROVIDERS: ReadonlyArray<ExecProvider> = [
  // ─── shell 类（本地 CLI 工具） ─────────────────────────────────────────────
  {
    id: "git",
    kind: "shell",
    description:
      "在工作流目录内执行 git 命令（status/diff/log/show/add/commit/...）。Agent 可用于版本化策略脚本、查看历史改动。",
    command: "git",
    outputProtocol: "text",
    defaultTimeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    envAllowlist: ["HOME", "USER", "LANG", "LC_ALL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"],
    workdirStrategy: "workflow-scoped",
    allowFreeformArgs: true,
    lifecycle: "stable",
  },
  {
    id: "jq",
    kind: "shell",
    description:
      "JSON 处理。Agent 拿到 yfinance / akshare / connector 的 JSON 返回值后，用 jq 提取/转换字段，比让 LLM 在 reason 里手写解析省 token。",
    command: "jq",
    outputProtocol: "text",
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 256 * 1024,
    envAllowlist: ["HOME", "LANG", "LC_ALL"],
    workdirStrategy: "workflow-scoped",
    allowFreeformArgs: true,
    lifecycle: "stable",
  },
  {
    id: "rg",
    kind: "shell",
    description:
      "ripgrep 全文搜索。Agent 在工作流目录或项目目录内搜策略脚本、报告、历史信号文件时用。",
    command: "rg",
    outputProtocol: "text",
    defaultTimeoutMs: 15_000,
    maxOutputBytes: 128 * 1024,
    envAllowlist: ["HOME", "LANG", "LC_ALL"],
    workdirStrategy: "data-dir-scoped",
    allowFreeformArgs: true,
    lifecycle: "stable",
  },
  {
    id: "duckdb",
    kind: "shell",
    description:
      "直接查 DuckDB / parquet / sqlite 数据集，省去包一层 MCP 的 schema 开销。典型用法：`duckdb -c \"SELECT * FROM 'data.parquet' LIMIT 10\"`。",
    command: "duckdb",
    outputProtocol: "text",
    defaultTimeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
    envAllowlist: ["HOME", "LANG", "LC_ALL"],
    workdirStrategy: "data-dir-scoped",
    allowFreeformArgs: true,
    lifecycle: "stable",
  },

  // ─── cli_agent 类（外挂 agentic CLI） ─────────────────────────────────────
  {
    id: "claude-code",
    kind: "cli_agent",
    description:
      'Anthropic Claude Code CLI 子智能体。把长 horizon 编码任务（写因子文件、改 strategy-composer、读多个文件后产 PR diff）整包外包给它。oneshot 模式：`claude -p "..."`。',
    command: "claude",
    argTemplate: ["-p", "{prompt}", "--dangerously-skip-permissions"],
    stdinTemplate: undefined,
    outputProtocol: "text",
    defaultTimeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 256 * 1024,
    envAllowlist: ["HOME", "USER", "PATH", "ANTHROPIC_API_KEY", "LANG", "LC_ALL"],
    workdirStrategy: "workflow-scoped",
    lifecycle: "unsafe",
  },
  {
    id: "aider",
    kind: "cli_agent",
    description:
      "Aider 开源 coding agent。git-aware，会自己 commit。适合派「在 src/runtime/factor/ 下新增 X 因子 + 改对应 tests」这种任务。",
    command: "aider",
    argTemplate: ["--yes", "--no-stream", "--message", "{prompt}"],
    stdinTemplate: undefined,
    outputProtocol: "text",
    defaultTimeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 256 * 1024,
    envAllowlist: ["HOME", "USER", "PATH", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LANG", "LC_ALL"],
    workdirStrategy: "workflow-scoped",
    lifecycle: "unsafe",
  },
];

/** 用户覆盖文件路径：`$dataDir/exec-providers.json` */
function userOverridePath(): string {
  return join(getDataDir(), "exec-providers.json");
}

/** 解析单个用户配置条目，缺字段用默认值兜底，类型不对的直接 throw（让用户在启动时就发现） */
function parseUserProvider(raw: unknown): ExecProvider {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("exec-providers.json: each entry must be an object");
  }
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const kind = String(r.kind ?? "shell") as ExecProvider["kind"];
  const command = String(r.command ?? "").trim();
  if (!id) throw new Error("exec-providers.json: id is required");
  if (!command) throw new Error(`exec-providers.json[${id}]: command is required`);
  if (kind !== "shell" && kind !== "cli_agent") {
    throw new Error(`exec-providers.json[${id}]: kind must be "shell" or "cli_agent"`);
  }
  return {
    id,
    kind,
    description: String(r.description ?? `user-defined ${kind}: ${id}`),
    command,
    argTemplate: Array.isArray(r.argTemplate)
      ? (r.argTemplate as unknown[]).map(String)
      : undefined,
    stdinTemplate: typeof r.stdinTemplate === "string" ? r.stdinTemplate : undefined,
    outputProtocol: (r.outputProtocol as ExecProvider["outputProtocol"]) ?? "text",
    defaultTimeoutMs: Number(
      r.defaultTimeoutMs ?? (kind === "cli_agent" ? 10 * 60 * 1000 : 30_000)
    ),
    maxOutputBytes: Number(r.maxOutputBytes ?? 64 * 1024),
    envAllowlist: Array.isArray(r.envAllowlist)
      ? (r.envAllowlist as unknown[]).map(String)
      : ["HOME", "LANG", "LC_ALL"],
    workdirStrategy: (r.workdirStrategy as ExecProvider["workdirStrategy"]) ?? "workflow-scoped",
    allowFreeformArgs: r.allowFreeformArgs !== false,
    allowedSubcommands: Array.isArray(r.allowedSubcommands)
      ? (r.allowedSubcommands as unknown[]).map(String)
      : undefined,
    lifecycle: (r.lifecycle as ExecProvider["lifecycle"]) ?? "experimental",
  };
}

let cached: Map<string, ExecProvider> | null = null;

/**
 * 加载 Exec Provider 注册表（内置 + 用户覆盖）。
 *
 * 用户覆盖规则：同 id 时**整条替换**（不是合并）；这样既能改超时/cwd 策略，也能加新 binary。
 * 缓存按进程生命周期；测试需要时调 `resetExecProviderRegistry()` 强制重新加载。
 */
export async function loadExecProviders(): Promise<Map<string, ExecProvider>> {
  if (cached) return cached;
  const map = new Map<string, ExecProvider>();
  for (const p of BUILTIN_PROVIDERS) map.set(p.id, p);
  const overridePath = userOverridePath();
  if (existsSync(overridePath)) {
    try {
      const raw = await readFile(overridePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const provider = parseUserProvider(item);
          map.set(provider.id, provider);
        }
      }
    } catch (e) {
      // 用户配置文件解析失败：日志告警但不阻断进程（保持内置默认可用）
      // 注意：这里不抛错，因为 builtin-tools 在 import 时调，抛错会让整个 runtime 起不来
      console.warn(
        `[exec/registry] failed to load ${overridePath}: ${(e as Error).message}; using built-in providers only`
      );
    }
  }
  cached = map;
  return map;
}

/** 测试用：强制重新加载注册表 */
export function resetExecProviderRegistry(): void {
  cached = null;
}

/** 列出所有注册的 provider（按 id 排序），供 tool-catalog 输出元信息 */
export async function listExecProviders(): Promise<ExecProvider[]> {
  const map = await loadExecProviders();
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/** 按 id + kind 双重过滤拿 provider；找不到或 kind 不匹配都返回 null */
export async function getExecProvider(
  id: string,
  expectedKind: ExecProvider["kind"]
): Promise<ExecProvider | null> {
  const map = await loadExecProviders();
  const p = map.get(id);
  if (!p) return null;
  if (p.kind !== expectedKind) return null;
  return p;
}
