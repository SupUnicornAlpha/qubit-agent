/**
 * CliRoleReasoner —— 用 Claude Code / Codex CLI 跑「单个角色的一轮推理」。
 *
 * 模型 B（docs/CLI_AGENT_PROJECTION_DESIGN.md）：QUBIT 仍是控制面（MSA/A2A/HITL/风控），
 * 这里只把某角色的 reason 换成子进程 CLI。CLI 通过 MCP 反向桥（mcp-bridge-server.ts）
 * 回调我们的工具，最终产出的文本（含分析师 JSON 信号块）与自研引擎同构，交回
 * `runResearchTeamSlotReact` 的既有解析逻辑。
 *
 * 失败兜底：artifacts/spawn/解析任一步出错都 fail-soft 回退 NativeRoleReasoner，
 * 保证团队不因 CLI 不可用而中断。
 *
 * 本文件被 role-reasoner.ts 在「请求 CLI 引擎」时动态 import，加载即自注册
 * （避免 msa ←→ 自身的静态循环依赖）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { type LoopOptionsJson, parseLoopOptionsJson } from "../../types/loop";
import { sniffNativeSessionId } from "../loop/loop-protocol";
import { loopRunDir, mcpBridgeEntryFile } from "../loop/run-artifacts";
import { renderSkillsBlockForPrompt, skillService } from "../skills/skill-service";
import {
  NativeRoleReasoner,
  type RoleReasonOutcome,
  type RoleReasonRequest,
  type RoleReasoner,
  type RoleReasonerKind,
  registerRoleReasoner,
} from "./role-reasoner";

const DEFAULT_ROLE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 桥暴露的 MCP 工具全名（server=qubit, tool=call_qubit_mcp）。 */
export const QUBIT_BRIDGE_TOOL = "mcp__qubit__call_qubit_mcp" as const;

/**
 * 构造单角色 CLI 子进程的 command + args（纯函数，便于单测）。
 * prompt 文本通过 stdin 传入（不放 argv，避免长 prompt 触顶 argv 限制）。
 */
export function buildRoleCliInvocation(input: {
  kind: "claude_cli" | "codex_cli";
  command?: string;
  systemPrompt: string;
  bridgeManifestPath: string;
  bridgeEntryFile: string;
  projectId: string;
  /** Codex 用：最终消息落盘路径。 */
  lastMessagePath: string;
  model?: string;
  resumeSessionId?: string;
}): { command: string; args: string[] } {
  if (input.kind === "claude_cli") {
    const args: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      input.bridgeManifestPath,
      "--strict-mcp-config",
      "--allowedTools",
      QUBIT_BRIDGE_TOOL,
      "--append-system-prompt",
      input.systemPrompt,
    ];
    if (input.model) args.push("--model", input.model);
    if (input.resumeSessionId) args.unshift("--resume", input.resumeSessionId);
    return { command: input.command ?? "claude", args };
  }
  // codex_cli —— systemPrompt 由调用方前置进 prompt 文本（Codex 无 append-system-prompt）。
  const argsArr = JSON.stringify(["run", input.bridgeEntryFile]);
  const args: string[] = [
    "exec",
    "--json",
    "-o",
    input.lastMessagePath,
    "-s",
    "read-only",
    "-c",
    "mcp_servers.qubit.command=bun",
    "-c",
    `mcp_servers.qubit.args=${argsArr}`,
    "-c",
    `mcp_servers.qubit.env.QUBIT_MCP_BRIDGE_PROJECT_ID=${input.projectId}`,
  ];
  if (input.model) args.push("-m", input.model);
  if (input.resumeSessionId) {
    // codex exec resume <id> ...
    args.splice(1, 0, "resume", input.resumeSessionId);
  }
  return { command: input.command ?? "codex", args };
}

/**
 * 角色 prompt（user 轮）文本。systemPrompt 走 CLI 的 system 通道，不在这里。
 * `skillsBlock` 为该角色 declared skills 的渲染文本（复用 native 的
 * `renderSkillsBlockForPrompt`，保证 CLI 与自研路径技能同源）；空串则不注入。
 */
export function buildRolePromptText(
  req: RoleReasonRequest,
  includeSystemPrompt: boolean,
  skillsBlock = ""
): string {
  const blocks: string[] = [];
  if (includeSystemPrompt && req.def.systemPrompt.trim()) {
    // Codex 无 append-system-prompt，把角色人设前置进 prompt。
    blocks.push(`# 你的角色设定\n\n${req.def.systemPrompt.trim()}`);
  }
  blocks.push(`# 任务\n\n${req.userGoal}`);
  if (req.context.trim()) {
    blocks.push(`# 上下文\n\n${req.context.trim()}`);
  }
  if (skillsBlock.trim()) {
    blocks.push(skillsBlock.trim());
  }
  blocks.push(
    [
      "# 可用工具",
      "",
      "通过 MCP server `qubit` 调用 QUBIT 内部工具（`call_qubit_mcp(serverName, toolName, arguments)`）。",
      "这些工具与桌面端一致：行情、新闻、因子、回测等。请基于真实工具结果作答，不要臆造数据。",
    ].join("\n")
  );
  if (req.expectJsonSignal) {
    blocks.push(
      [
        "# 输出要求",
        "",
        "完成多轮交叉验证后，**最后输出一段 JSON 信号**（可放在 ```json 围栏内）：",
        '`{"signal":"buy|sell|hold","confidence":0.0-1.0,"reasoning":"...","key_drivers":[],"key_risks":[]}`',
        "其余按你角色的 schema 补全结构化字段。",
      ].join("\n")
    );
  } else {
    blocks.push("# 输出要求\n\n完成子任务后用 Markdown 小结（不要 JSON）。");
  }
  return blocks.join("\n\n");
}

/**
 * 从 Claude `--output-format stream-json` 的 stdout 抽取最终文本 + session_id（纯函数）。
 * - 最终文本：取 `{"type":"result",...,"result":"<text>"}` 事件的 result 字段；
 *   无 result 事件时回退拼接所有 assistant text 块。
 * - sessionId：任意事件里的 session_id。
 */
export function parseClaudeStreamJsonFinal(stdout: string): { text: string; sessionId?: string } {
  let resultText: string | null = null;
  const assistantChunks: string[] = [];
  let sessionId: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    if (!sessionId) {
      const sid = sniffNativeSessionId(t);
      if (sid) sessionId = sid;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      resultText = obj.result;
    } else if (obj.type === "assistant") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      for (const c of msg?.content ?? []) {
        if (c.type === "text" && typeof c.text === "string") assistantChunks.push(c.text);
      }
    }
  }
  const text = resultText ?? assistantChunks.join("\n").trim();
  return sessionId ? { text, sessionId } : { text };
}

/** Codex：session_id 从 --json stdout 嗅探；最终文本由 -o 落盘文件给出（这里只取 sessionId）。 */
export function parseCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const sid = sniffNativeSessionId(line.trim());
    if (sid) return sid;
  }
  return undefined;
}

/**
 * 渲染角色 declared skills 的 prompt 文本块（与 native reason 节点同源：
 * 同一 `skillService` + `renderSkillsBlockForPrompt`）。
 * 按 name 精确加载已声明 skill，缺失/归档的跳过；失败返回空串（fail-soft）。
 */
async function renderDeclaredSkillsBlock(projectId: string, skillIds: string[]): Promise<string> {
  if (!projectId || skillIds.length === 0) return "";
  try {
    const loaded = await Promise.all(
      skillIds.map((name) => skillService.findByName(projectId, name))
    );
    const skills = loaded.filter((s): s is NonNullable<typeof s> => s != null);
    return renderSkillsBlockForPrompt(skills);
  } catch (e) {
    console.warn(
      "[cli-role-reasoner] failed to render declared skills:",
      e instanceof Error ? e.message : e
    );
    return "";
  }
}

async function resolveRunContext(
  workflowRunId: string
): Promise<{ projectId: string; loopOptions: LoopOptionsJson }> {
  const db = await getDb();
  const rows = await db
    .select({ projectId: workflowRun.projectId, loopOptionsJson: workflowRun.loopOptionsJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  return {
    projectId: rows[0]?.projectId ?? "",
    loopOptions: parseLoopOptionsJson(rows[0]?.loopOptionsJson),
  };
}

/**
 * 桥进程的 env：项目 scope + 治理（角色 / allow 白名单 / deny 追加）。
 * 高危工具默认 deny 由桥的 DEFAULT_HIGH_RISK_DENY 始终强制，与此无关。
 */
function buildBridgeEnv(input: {
  projectId: string;
  role: string;
  loopOptions: LoopOptionsJson;
}): Record<string, string> {
  const env: Record<string, string> = {
    QUBIT_MCP_BRIDGE_PROJECT_ID: input.projectId,
    QUBIT_MCP_BRIDGE_ROLE: input.role,
  };
  const allow = input.loopOptions.allowedToolsOverride ?? [];
  if (allow.length > 0) env.QUBIT_MCP_BRIDGE_ALLOW = allow.join(",");
  const deny = input.loopOptions.denyToolsExtra ?? [];
  if (deny.length > 0) env.QUBIT_MCP_BRIDGE_DENY = deny.join(",");
  return env;
}

/** 解析 `provider:model` 里的 model 段；仅当看起来是 CLI 能识别的模型时返回。 */
export function extractModelFromProvider(
  llmProvider: string,
  kind: "claude_cli" | "codex_cli"
): string | undefined {
  const parts = llmProvider.split(":");
  const model = parts.length > 1 ? parts.slice(1).join(":").trim() : "";
  if (!model) return undefined;
  // 只在 provider 与 CLI 匹配时透传 model，否则让 CLI 用自己的默认模型/鉴权。
  const provider = parts[0]?.toLowerCase();
  if (kind === "claude_cli" && provider === "anthropic") return model;
  if (kind === "codex_cli" && provider === "openai") return model;
  return undefined;
}

class CliRoleReasoner implements RoleReasoner {
  readonly kind: RoleReasonerKind;
  private readonly native = new NativeRoleReasoner();

  constructor(kind: "claude_cli" | "codex_cli") {
    this.kind = kind;
  }

  async reason(req: RoleReasonRequest): Promise<RoleReasonOutcome> {
    try {
      return await this.runCli(req);
    } catch (e) {
      console.warn(
        `[cli-role-reasoner:${this.kind}] role=${req.role} failed, fallback to native:`,
        e instanceof Error ? e.message : e
      );
      const fb = await this.native.reason(req);
      return { ...fb }; // source 仍标记 native，便于审计看出发生了回退
    }
  }

  private async runCli(req: RoleReasonRequest): Promise<RoleReasonOutcome> {
    const kind = this.kind as "claude_cli" | "codex_cli";
    const { projectId, loopOptions } = await resolveRunContext(req.workflowRunId);
    if (!projectId) throw new Error("projectId not resolvable");

    const baseDir = loopRunDir(req.workflowRunId);
    const roleDir = join(baseDir, `role-${req.role}-${req.runId}`);
    await mkdir(roleDir, { recursive: true });

    const bridgeEntryFile = mcpBridgeEntryFile();
    const bridgeManifestPath = join(roleDir, "qubit-mcp-bridge.json");
    await writeFile(
      bridgeManifestPath,
      `${JSON.stringify(
        {
          mcpServers: {
            qubit: {
              command: "bun",
              args: ["run", bridgeEntryFile],
              env: buildBridgeEnv({ projectId, role: req.role, loopOptions }),
            },
          },
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const lastMessagePath = join(roleDir, "last-message.txt");
    const includeSystemInPrompt = kind === "codex_cli";
    // Skills 投影：注入角色 declared skills（与 native 同源），CLI 与自研路径技能对齐。
    const skillsBlock = await renderDeclaredSkillsBlock(projectId, req.def.skills ?? []);
    const promptText = buildRolePromptText(req, includeSystemInPrompt, skillsBlock);

    const model = extractModelFromProvider(req.def.llmProvider, kind);
    const { command, args } = buildRoleCliInvocation({
      kind,
      systemPrompt: req.def.systemPrompt,
      bridgeManifestPath,
      bridgeEntryFile,
      projectId,
      lastMessagePath,
      ...(model ? { model } : {}),
    });

    const proc = Bun.spawn([command, ...args], {
      cwd: roleDir,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    // prompt 走 stdin
    proc.stdin?.write(new TextEncoder().encode(promptText));
    await proc.stdin?.end();

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, DEFAULT_ROLE_TIMEOUT_MS);

    let stdout = "";
    let bytes = 0;
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
          break;
        }
        stdout += dec.decode(value, { stream: true });
      }
      if (done) break;
    }
    const exit = await proc.exited;
    clearTimeout(killTimer);
    if (exit !== 0) throw new Error(`${command} exited with code ${exit}`);

    if (kind === "claude_cli") {
      const { text, sessionId } = parseClaudeStreamJsonFinal(stdout);
      if (!text.trim()) throw new Error("empty claude output");
      return { text, source: "claude_cli", ...(sessionId ? { sessionId } : {}) };
    }
    // codex_cli：最终文本来自 -o 落盘文件
    const last = await readFile(lastMessagePath, "utf8").catch(() => "");
    const text = last.trim();
    if (!text) throw new Error("empty codex output");
    const sessionId = parseCodexSessionId(stdout);
    return { text, source: "codex_cli", ...(sessionId ? { sessionId } : {}) };
  }
}

// 加载即自注册（role-reasoner.ts 动态 import 触发）。
registerRoleReasoner(new CliRoleReasoner("claude_cli"));
registerRoleReasoner(new CliRoleReasoner("codex_cli"));
