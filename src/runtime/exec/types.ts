/**
 * Exec 能力源 — 类型定义
 *
 * 背景：2026 年 X 上"CLI vs MCP"争论后，社区共识是 hybrid——本地工具用 CLI（token 高效、
 * 模型先验强），远程 SaaS / 多租户走 MCP（类型化、可发现、可鉴权）。qubit 同时需要：
 *
 *   A. `shell.exec`     — 让 agent 直接调用本地 CLI（git/jq/duckdb/rg/...），享受 CLI 派的
 *                          低 token 优势 + 模型对 shell 的训练先验
 *   B. `cli_agent.run`  — 把 agentic CLI（claude-code / aider / codex）作为外部子智能体外挂，
 *                          补齐 builtin/connector/mcp 都无法覆盖的"长 horizon 任务外包"能力位
 *
 * 两者底层都是子进程 spawn + sandbox + 输出收敛，所以统一成一个 `ExecProvider` 抽象。
 *
 * 安全模型（与 qubit 现有 mcp_server_config 白名单同构）：
 *   - 必须先在 `EXEC_PROVIDERS` 里注册才允许调用，没注册的 binary 直接 reject
 *   - cwd 必须落在 workflow 目录或 project 目录内（绝对路径校验，禁止 `..` 逃逸）
 *   - argv 强制数组形式传参，**永不走 shell**（Bun.spawn 默认行为，不会被注入 `;|>$()` 等）
 *   - env 只透传 `envAllowlist` 内的变量
 *   - 超时强制 wall-clock，沿用 python-sandbox 的 +5s 缓冲范式
 *   - stdout/stderr 截断（默认 64KB），过大返回 `output_truncated` 错误
 */

export type ExecKind = "shell" | "cli_agent";

export interface ExecProvider {
  /** 注册 id；shell 类一般是 binary 名（"git"），cli_agent 类一般是 agent 名（"claude-code"） */
  id: string;
  kind: ExecKind;
  /** 描述（落 tool catalog） */
  description: string;
  /** binary 名（让 OS PATH 解析）或绝对路径。spawn 时作为 argv[0]，永不经 shell */
  command: string;
  /**
   * argv 模板（仅 cli_agent 用）。占位符：
   *   - `{prompt}`     — agent 任务自然语言描述
   *   - `{cwd}`        — sandbox 工作目录绝对路径
   *   - `{files...}`   — 可选文件列表（按 fileScopes 展开）
   * shell 类不用模板（agent 直接传 args 数组）
   */
  argTemplate?: string[];
  /** stdin 传文本（cli_agent 常用：把任务作为 stdin 喂给 agent） */
  stdinTemplate?: string;
  /** 输出协议 */
  outputProtocol: "text" | "json" | "ndjson-events";
  /** 默认超时（毫秒），shell 30s 起，cli_agent 5min 起 */
  defaultTimeoutMs: number;
  /** 单次调用 stdout/stderr 截断上限（字节），默认 64KB，cli_agent 可放宽到 256KB */
  maxOutputBytes: number;
  /** 允许透传给子进程的 env 变量名（其他 env 一律不透传，避免 leak api key） */
  envAllowlist: ReadonlyArray<string>;
  /**
   * 工作目录策略：
   *   - "workflow-scoped"  → 必须在 `$dataDir/projects/<projectId>/workflows/<workflowRunId>/`
   *   - "project-scoped"   → 必须在 `$dataDir/projects/<projectId>/`
   *   - "data-dir-scoped"  → 必须在 `$dataDir/`（如 git 全局 / duckdb 跨工作流）
   */
  workdirStrategy: "workflow-scoped" | "project-scoped" | "data-dir-scoped";
  /**
   * 是否允许 LLM 自由传 args（仅 shell 类）。
   *   - true（默认）：agent 完全控制 args（最灵活，但需信任 binary 本身没有破坏性子命令）
   *   - false：必须从 `allowedArgPatterns` 中匹配（例如 `git` 仅允许 `["status","diff","log","show"]`）
   */
  allowFreeformArgs?: boolean;
  /** 当 allowFreeformArgs=false 时，args[0] 必须是这些子命令之一 */
  allowedSubcommands?: ReadonlyArray<string>;
  /**
   * lifecycle 标签（与 ToolLifecycle 同源）：
   *   - "stable"     — 默认
   *   - "experimental" — 接口/行为可能变化
   *   - "unsafe"     — 可能产生副作用（如 `curl` / `claude-code`），UI 应高亮警示
   */
  lifecycle?: "stable" | "experimental" | "unsafe";
}

/** shell.exec 调用入参（来自 LLM） */
export interface ShellExecParams {
  /** binary 名（必须在 EXEC_PROVIDERS 中且 kind=shell） */
  binary: string;
  /** argv（不含 binary 本身），强制数组，永不走 shell */
  args: string[];
  /** 工作目录绝对路径，必须满足 provider.workdirStrategy */
  cwd: string;
  /** 可选 stdin 文本 */
  stdinText?: string;
  /** 超时覆盖（毫秒，受 provider.defaultTimeoutMs 上限） */
  timeoutMs?: number;
}

/** cli_agent.run 调用入参（来自 LLM） */
export interface CliAgentRunParams {
  /** agent id（必须在 EXEC_PROVIDERS 中且 kind=cli_agent） */
  agentId: string;
  /** 任务的自然语言描述（替换 argTemplate / stdinTemplate 中的 {prompt}） */
  task: string;
  /** 工作目录绝对路径 */
  cwd: string;
  /** 可选文件列表（替换 {files...}） */
  files?: string[];
  /** 超时覆盖（毫秒） */
  timeoutMs?: number;
}

/** Exec 执行结果（shell / cli_agent 同构） */
export interface ExecResult {
  ok: boolean;
  /** 0 = 正常退出；非 0 = 子进程退出码；null = 被 kill / timeout */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 是否触发 stdout/stderr 截断 */
  truncated: boolean;
  /** 总耗时（毫秒），由 TS 端 wall-clock 测量 */
  elapsedMs: number;
  /**
   * 结构化错误码（仅 ok=false 时填）：
   *   - "binary_not_registered"     — binary/agentId 不在 EXEC_PROVIDERS
   *   - "binary_not_found"          — spawn 失败（命令不存在或 PATH 找不到）
   *   - "cwd_escape"                — cwd 不在 provider.workdirStrategy 限定的根目录下
   *   - "shell_metachar"            — args 包含 shell 元字符（防御性，spawn 不走 shell 也额外拦）
   *   - "disallowed_subcommand"     — allowFreeformArgs=false 且 args[0] 不在 allowedSubcommands
   *   - "wall_timeout"              — wall-clock 超时
   *   - "output_truncated"          — stdout+stderr 超过 maxOutputBytes（非 fatal，会同时返回截断内容）
   *   - "exec_failed"               — 兜底
   */
  error?: string;
  errorDetail?: string;
}
