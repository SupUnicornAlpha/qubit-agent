import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ALL_AGENT_ROLES } from "../../types/entities";
import { AGENT_CONTROL_PLANE_TOOLS } from "../agent-control-mode";
import { topologyTeamToolName } from "../orchestration/topology-dispatch";
import type { RuntimeAgentDefinition } from "../types";

const AgentRoleSchema = z.enum(ALL_AGENT_ROLES as unknown as [string, ...string[]]);

const A2ATypeSchema = z.enum([
  "TASK_ASSIGN",
  "TASK_RESULT",
  "RISK_BLOCK",
  "ORDER_INTENT",
  "MODEL_UPDATE",
  "MEMORY_WRITE",
  "ALERT",
]);

const AgentDefSchema = z.object({
  id: z.string().min(1),
  role: AgentRoleSchema,
  name: z.string().min(1),
  version: z.string().default("1.0.0"),
  systemPrompt: z.string().default(""),
  tools: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  subscriptions: z.array(A2ATypeSchema).default(["TASK_ASSIGN"]),
  llmProvider: z.string().default("openai:gpt-4o-mini"),
  maxIterations: z.number().int().positive().default(20),
  sandboxPolicyId: z.string().default("default-policy"),
  enabled: z.boolean().default(true),
});

const AgentsFileSchema = z.object({
  definitions: z.array(AgentDefSchema).default([]),
});

const SandboxPolicySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  allowedMcpServers: z.array(z.string()).default([]),
  allowedConnectors: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  allowedFsPaths: z.array(z.string()).default([]),
  maxToolCallMs: z.number().int().positive().default(30_000),
  maxIterationsPerRun: z.number().int().positive().default(20),
  maxOutputTokens: z.number().int().positive().default(4096),
  isolationLevel: z.enum(["none", "process", "vm"]).default("none"),
  canWriteMemory: z.boolean().default(true),
  canReadLiveMarket: z.boolean().default(false),
  canSubmitOrder: z.boolean().default(false),
});

const SandboxFileSchema = z.object({
  policies: z.array(SandboxPolicySchema).default([]),
});

export type WorkspaceSandboxPolicy = z.infer<typeof SandboxPolicySchema>;

export interface WorkspaceRuntimeConfig {
  definitions: RuntimeAgentDefinition[];
  policies: WorkspaceSandboxPolicy[];
}

export interface WorkspaceRuntimeFileBundle {
  exists: boolean;
  config: WorkspaceRuntimeConfig | null;
  /** 文件存在但 JSON 损坏或不符合 schema（例如旧版枚举不识别 analyst_*） */
  parseError?: string;
  configDir: string;
  agentsFile: string;
  sandboxFile: string;
}

/** 与 DB seed / sync-workspace-agents 一致：从 definition 汇总 default-policy 白名单 */
export function buildDefaultSandboxPoliciesFromDefinitions(
  definitions: RuntimeAgentDefinition[]
): WorkspaceSandboxPolicy[] {
  // call_team_<role> 是运行时按已启用专家注入的 orchestrator 工具，不在各 definition.tools 里，
  // 但必须进 default-policy 白名单，否则 dispatch 会 sandbox_blocked。
  const topologyTools = definitions.map((d) => topologyTeamToolName(d.role));
  const tools = [
    ...new Set([
      ...definitions.flatMap((d) => d.tools),
      ...topologyTools,
      ...AGENT_CONTROL_PLANE_TOOLS,
    ]),
  ].sort();
  const mcps = [...new Set(definitions.flatMap((d) => d.mcpServers))].sort();
  return [
    {
      id: "default-policy",
      name: "default-policy",
      description: "Generated from agent definitions (allowedTools / allowedMcpServers union).",
      allowedTools: tools,
      allowedMcpServers: mcps,
      allowedConnectors: [],
      allowedHosts: [],
      allowedFsPaths: [],
      maxToolCallMs: 30_000,
      maxIterationsPerRun: 20,
      maxOutputTokens: 4096,
      isolationLevel: "none",
      canWriteMemory: true,
      canReadLiveMarket: false,
      canSubmitOrder: false,
    },
  ];
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export async function loadWorkspaceRuntimeConfig(
  rootDir = process.cwd()
): Promise<WorkspaceRuntimeFileBundle> {
  const configDir = join(rootDir, ".qubit");
  const agentsFile = join(configDir, "agents.json");
  const sandboxFile = join(configDir, "sandbox.json");
  const hasAgents = existsSync(agentsFile);
  const hasSandbox = existsSync(sandboxFile);
  if (!hasAgents || !hasSandbox) {
    return {
      exists: false,
      config: null,
      configDir,
      agentsFile,
      sandboxFile,
    };
  }

  const [agentsRaw, sandboxRaw] = await Promise.all([
    readFile(agentsFile, "utf-8"),
    readFile(sandboxFile, "utf-8"),
  ]);

  let agentsJson: unknown;
  let sandboxJson: unknown;
  try {
    agentsJson = JSON.parse(agentsRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exists: true,
      config: null,
      parseError: `agents.json: invalid JSON (${msg})`,
      configDir,
      agentsFile,
      sandboxFile,
    };
  }
  try {
    sandboxJson = JSON.parse(sandboxRaw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exists: true,
      config: null,
      parseError: `sandbox.json: invalid JSON (${msg})`,
      configDir,
      agentsFile,
      sandboxFile,
    };
  }

  const agentsParsed = AgentsFileSchema.safeParse(agentsJson);
  const sandboxParsed = SandboxFileSchema.safeParse(sandboxJson);
  if (!agentsParsed.success || !sandboxParsed.success) {
    const parts: string[] = [];
    if (!agentsParsed.success) parts.push(`agents.json: ${formatZodIssues(agentsParsed.error)}`);
    if (!sandboxParsed.success) parts.push(`sandbox.json: ${formatZodIssues(sandboxParsed.error)}`);
    return {
      exists: true,
      config: null,
      parseError: parts.join(" | "),
      configDir,
      agentsFile,
      sandboxFile,
    };
  }

  return {
    exists: true,
    config: {
      definitions: agentsParsed.data.definitions as RuntimeAgentDefinition[],
      policies: sandboxParsed.data.policies,
    },
    configDir,
    agentsFile,
    sandboxFile,
  };
}

/**
 * Round 8 复盘（2026-06-08）：`.qubit/sandbox.json` 是 user 工作区的历史快照。
 * SEED_AGENT_DEFINITIONS 新增 builtin tool（如 strategy.create_version /
 * order.create_intent）后，文件里的 default-policy.allowedTools 仍旧没有这些工具；
 * 后续 GraphRunner.syncFromWorkspaceConfig → syncWorkspaceConfigToDb 会用文件覆盖
 * DB → sandbox_policy.allowed_tools_json 退回旧值 → 评测里 strategy.create_version
 * 永远 sandbox_blocked。
 *
 * 这里做"软合并"：按 id 找到文件里 builtin policy（如 default-policy），把 SEED
 * 版本的 allowedTools / allowedMcpServers union 进去，user 自加的额外项保留；
 * 其他 policy（user 自定义、FSI preset）完全不动。其他字段（maxIterationsPerRun、
 * canSubmitOrder 等）尊重 user 文件值，避免覆盖 user 的安全约束。
 */
export function mergeBuiltinSandboxPoliciesIntoUserFile(
  fileSandbox: WorkspaceSandboxPolicy[],
  seedPolicies: WorkspaceSandboxPolicy[]
): { policies: WorkspaceSandboxPolicy[]; mutated: boolean } {
  let mutated = false;
  const fileById = new Map(fileSandbox.map((p) => [p.id, p]));
  const merged: WorkspaceSandboxPolicy[] = [];

  for (const file of fileSandbox) {
    const seed = seedPolicies.find((s) => s.id === file.id);
    if (!seed) {
      // user 自定义 / FSI preset：原样保留
      merged.push(file);
      continue;
    }

    const toolsUnion = unionStrings(file.allowedTools, seed.allowedTools);
    const mcpUnion = unionStrings(file.allowedMcpServers, seed.allowedMcpServers);

    const toolsChanged = !sameSet(file.allowedTools, toolsUnion);
    const mcpChanged = !sameSet(file.allowedMcpServers, mcpUnion);
    if (toolsChanged || mcpChanged) mutated = true;

    merged.push({
      ...file,
      allowedTools: toolsUnion,
      allowedMcpServers: mcpUnion,
    });
  }

  // SEED 里有、文件没有的 builtin policy 直接补一条（首次启动 / 文件被人删了 builtin 项）
  for (const seed of seedPolicies) {
    if (fileById.has(seed.id)) continue;
    mutated = true;
    merged.push(seed);
  }

  return { policies: merged, mutated };
}

function unionStrings(a: string[], b: string[]): string[] {
  const set = new Set<string>();
  for (const x of a) set.add(x);
  for (const x of b) set.add(x);
  return [...set].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

export async function ensureWorkspaceRuntimeConfigFiles(params: {
  rootDir?: string;
  definitions: RuntimeAgentDefinition[];
  policies: WorkspaceSandboxPolicy[];
  /** 为 true 时用种子定义覆盖 workspace 文件（与 DB seed 对齐） */
  refresh?: boolean;
  /**
   * 默认 true：当 sandbox.json 已存在时，把 SEED 的 builtin policy（按 id 匹配）的
   * allowedTools / allowedMcpServers union 进文件并写回，其他 policy 不动。
   * 给 unit test 显式传 false 关掉以便测试初始写入路径。
   */
  mergeBuiltinSandboxPolicies?: boolean;
}): Promise<void> {
  const rootDir = params.rootDir ?? process.cwd();
  const configDir = join(rootDir, ".qubit");
  const agentsFile = join(configDir, "agents.json");
  const sandboxFile = join(configDir, "sandbox.json");
  await mkdir(configDir, { recursive: true });
  if (params.refresh || !existsSync(agentsFile)) {
    await writeFile(
      agentsFile,
      JSON.stringify({ definitions: params.definitions }, null, 2),
      "utf-8"
    );
  }
  if (params.refresh || !existsSync(sandboxFile)) {
    await writeFile(sandboxFile, JSON.stringify({ policies: params.policies }, null, 2), "utf-8");
    return;
  }
  // 文件已存在：按需 union builtin policy 的工具白名单
  if (params.mergeBuiltinSandboxPolicies === false) return;
  try {
    const raw = await readFile(sandboxFile, "utf-8");
    const parsed = SandboxFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return; // 损坏文件交给 loadWorkspaceRuntimeConfig 报 parseError
    const { policies, mutated } = mergeBuiltinSandboxPoliciesIntoUserFile(
      parsed.data.policies,
      params.policies
    );
    if (mutated) {
      await writeFile(sandboxFile, JSON.stringify({ policies }, null, 2), "utf-8");
      console.log(
        `[Workspace] sandbox.json: union new builtin tools/MCPs into existing user policies.`
      );
    }
  } catch {
    // 读/写失败不阻塞启动；GraphRunner 后续 reload 仍会按文件原状跑
  }
}
