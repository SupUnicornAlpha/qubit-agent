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
    /** 对话 orchestrator 工具执行前 HITL；默认 chat 来源开启 */
    hitlChat: z.boolean().optional(),
    /** 团队研究 Orchestrator 规划完成后 HITL；默认 research/chat 开启 */
    hitlTeam: z.boolean().optional(),
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
