import { z } from "zod";

export const AgentLoopKindSchema = z.enum(["native", "claude_cli", "codex_cli"]);
export type AgentLoopKind = z.infer<typeof AgentLoopKindSchema>;

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

export function normalizeLoopKind(raw: unknown): AgentLoopKind {
  const r = AgentLoopKindSchema.safeParse(raw);
  return r.success ? r.data : "native";
}
