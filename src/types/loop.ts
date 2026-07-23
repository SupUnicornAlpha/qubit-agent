import { z } from "zod";

export const AgentLoopKindSchema = z.enum(["native", "claude_cli", "codex_cli"]);
export type AgentLoopKind = z.infer<typeof AgentLoopKindSchema>;

/**
 * 面向用户的 Agent 工作模式。它与 AgentLoopKind 正交：
 * - loop kind 决定“用哪个推理执行引擎”
 * - control mode 决定“本次任务允许做到哪一步”
 */
export const AgentControlModeSchema = z.enum(["agent", "plan", "goal"]);
export type AgentControlMode = z.infer<typeof AgentControlModeSchema>;

export const WorkflowSopStepSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  required: z.boolean().optional().default(true),
});

export const WorkflowGateConfigSchema = z.object({
  /** 结束前必须存在一份计划，且没有 pending / in_progress 步骤。 */
  requirePlanCompleted: z.boolean().optional().default(false),
  /** 结束前至少要有 minSuccessfulToolCalls 次真实业务工具成功。 */
  requireEvidence: z.boolean().optional().default(false),
  minSuccessfulToolCalls: z.number().int().min(1).max(50).optional().default(1),
});

/**
 * Workflow 只是 Conversation 的流程化运行配置：模板、SOP 和完成门控都收敛在这里。
 * 它不拥有第二套消息模型；消息仍属于 chat_session。
 */
export const WorkflowProcessConfigSchema = z.object({
  templateId: z.string().max(120).optional(),
  sopPreset: z.string().max(80).optional(),
  sopSteps: z.array(WorkflowSopStepSchema).max(20).optional().default([]),
  gates: WorkflowGateConfigSchema.optional().default({}),
});

export type WorkflowProcessConfig = z.infer<typeof WorkflowProcessConfigSchema>;

/** Per-workflow overrides for external CLI loops (stored in workflow_run.loop_options_json). */
export const LoopOptionsJsonSchema = z
  .object({
    /** Override workflow execution_path when loop_kind is native (graph | a2a). */
    executionPath: z.enum(["graph", "a2a"]).optional(),
    /** Full path or binary name on PATH */
    command: z.string().optional(),
    /** Extra CLI args inserted after command-specific defaults */
    extraArgs: z.array(z.string()).optional(),
    /** Subprocess timeout in ms (default 900_000) */
    timeoutMs: z.number().int().positive().optional(),
    /** When true, materialize MCP bridge manifest under the run directory */
    injectMcpBridge: z.boolean().optional(),
    /** Max bytes of combined stdout+stderr to buffer (default 8MB) */
    maxOutputBytes: z.number().int().positive().optional(),
    /** native Agent 内建 ReAct；false 时强制单轮（仍走 perceive→reason→act→observe 一次） */
    reactLoop: z.boolean().optional(),
    /**
     * 单角色推理引擎选择（模型 B，详见 docs/CLI_AGENT_PROJECTION_DESIGN.md）。
     * 覆盖由 `loop_kind` 推出的默认值：
     *   - 'native'     ：自研进程内 ReAct（默认）
     *   - 'claude_cli' ：子进程 Claude Code CLI 作为单角色 reason 引擎
     *   - 'codex_cli'  ：子进程 Codex CLI 作为单角色 reason 引擎
     * 与「整 workflow loop_kind」正交：可在 native 编排下让某些角色的 reason 走 CLI。
     */
    roleReasoner: z.enum(["native", "claude_cli", "codex_cli"]).optional(),
    /**
     * CLI reasoner 经 MCP 桥回调工具时的 allow 白名单（glob：`server/tool`，`*` 通配）。
     * 非空时，工具调用必须命中其一才放行。高危工具（下单/实盘）由桥的默认 deny 始终拦截，
     * 与本白名单无关（docs/CLI_AGENT_PROJECTION_DESIGN.md §5）。
     */
    allowedToolsOverride: z.array(z.string()).optional(),
    /** CLI reasoner 经桥回调工具时追加的 deny 模式（与默认高危表合并）。 */
    denyToolsExtra: z.array(z.string()).optional(),
    /**
     * Chat orchestrator HITL 三档触发策略（与团队 HITL `hitlMode` 同义）。
     *   - 'off'     ：永不主动询问；高危工具硬规则（下单 / 写入外部状态）仍触发
     *   - 'ai'      ：默认 — 仅高危工具或 LLM 显式 hint 才询问
     *   - 'always'  ：每次工具调用都问
     *
     * P1-H 后：v1 兼容字段 `hitlChat` 已通过 migration 0053 统一改写为本字段并删除。
     */
    hitlChatMode: z.enum(["off", "ai", "always"]).optional(),
    /**
     * 团队 HITL 三档触发策略（详见 docs/HITL_REDESIGN.md）。
     *   - 'off'     ：永不主动询问；硬规则（资金 / 规模 / 失败重试）仍触发
     *   - 'ai'      ：默认 — Orchestrator hitlNeeded=true 或命中硬规则才询问
     *   - 'always'  ：每次规划都问
     *
     * P1-H 后：v1 兼容字段 `hitlTeam` 已通过 migration 0053 统一改写为本字段并删除。
     */
    hitlMode: z.enum(["off", "ai", "always"]).optional(),
    /**
     * 资金类硬规则阈值（单笔下单金额，单位美元）；仅 `mode === 'trade'` 生效。
     * 默认 1000；超过则即便 hitlMode='off' 也强制触发 HITL。
     */
    hitlMoneyThreshold: z.number().positive().optional(),
    /**
     * 用户可见的 Agent 工作模式：
     *   - agent：普通执行；按需调用工具和既定团队成员
     *   - plan：只分析并生成计划；运行时硬性禁止业务工具、派单和外部写入
     *   - goal：自主规划、执行、验证并闭环；允许按需召唤拓扑外专家
     */
    agentMode: AgentControlModeSchema.optional(),
    /** Conversation 的流程化执行配置；仅 workflow 界面额外暴露。 */
    processConfig: WorkflowProcessConfigSchema.optional(),
    /**
     * @deprecated 旧版“编排体验”字段。只为历史 DB/API 兼容保留：
     * native -> agent，coding_agent -> goal。新代码必须写 agentMode。
     */
    experience: z.enum(["native", "coding_agent"]).optional(),
  })
  .strip();

export type LoopOptionsJson = z.infer<typeof LoopOptionsJsonSchema>;

export function parseLoopOptionsJson(raw: unknown): LoopOptionsJson {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  if (v == null || typeof v !== "object") return {};
  const parsed = LoopOptionsJsonSchema.safeParse(v);
  return parsed.success ? parsed.data : {};
}

/** 统一解析新旧模式字段；读取失败时走最保守且兼容的普通 Agent 模式。 */
export function resolveAgentControlMode(raw: unknown): AgentControlMode {
  const options = parseLoopOptionsJson(raw);
  if (options.agentMode) return options.agentMode;
  return options.experience === "coding_agent" ? "goal" : "agent";
}

export function resolveWorkflowProcessConfig(raw: unknown): WorkflowProcessConfig | null {
  const options = parseLoopOptionsJson(raw);
  return options.processConfig ?? null;
}

export function normalizeLoopKind(raw: unknown): AgentLoopKind {
  const r = AgentLoopKindSchema.safeParse(raw);
  return r.success ? r.data : "native";
}
