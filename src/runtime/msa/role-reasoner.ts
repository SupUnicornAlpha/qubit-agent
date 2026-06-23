/**
 * RoleReasoner —— 「跑某个角色的一轮推理」的可替换底层引擎。
 *
 * 设计见 docs/CLI_AGENT_PROJECTION_DESIGN.md（模型 B）。核心思想：
 * 分析师 / 辅助角色（research/backtest/risk）的「单角色执行」当前统一走
 * `runResearchTeamSlotReact` → `executeAgentReact`（自研 LangGraph ReAct）。
 * 本抽象把「用什么引擎跑这一轮」从执行逻辑里剥出来，让 workflow 可在
 *   - `native`     ：自研进程内 ReAct（默认，行为零变化）
 *   - `claude_cli` ：子进程 Claude Code CLI（带工具的 ReAct，经 MCP 桥回调我们的工具）
 *   - `codex_cli`  ：子进程 Codex CLI
 * 之间选择，且**产出契约一致**：返回最终文本 `text`（含分析师 JSON 信号块），
 * 下游 `parseJsonSignalFromText` 原样复用，不感知引擎差异。
 *
 * 选择来源（`resolveRoleReasoner`）：
 *   1. `workflow_run.loop_options_json.roleReasoner`（显式覆盖）
 *   2. `workflow_run.loop_kind`（claude_cli / codex_cli ⇒ 对应 CLI reasoner）
 *   3. 默认 native
 * 选中 CLI reasoner 但其不可用 / 未实现时，**fail-soft 回退 native**（团队不中断）。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { normalizeLoopKind, parseLoopOptionsJson } from "../../types/loop";
import { executeAgentReact } from "../langgraph/execute-agent-react";
import type { RuntimeAgentDefinition } from "../types";

export type RoleReasonerKind = "native" | "claude_cli" | "codex_cli";

/** 一次单角色推理请求（引擎无关）。 */
export interface RoleReasonRequest {
  def: RuntimeAgentDefinition;
  role: AgentRole;
  workflowRunId: string;
  runId: string;
  traceId: string;
  /** 自研路径直接喂给 `executeAgentReact` 的 TaskAssign payload。 */
  payload: TaskAssignPayload;
  /** CLI 路径构造 role prompt 用（自研路径已含在 payload.params 内）。 */
  userGoal: string;
  ticker: string;
  context: string;
  /** 与 analyst-team 预创建实例对齐，便于 tool_call_log 关联。 */
  agentInstanceId?: string;
  /** analyst_* 需要 JSON 信号；CLI reasoner 据此调整 prompt 收尾要求。 */
  expectJsonSignal: boolean;
}

export interface RoleReasonOutcome {
  /** 最终推理文本（与自研 `finalState.reasonText` 同义；含 JSON 信号块）。 */
  text: string;
  /** CLI 路径可续跑的会话 id（自研路径为 undefined）。 */
  sessionId?: string;
  /** 实际使用的引擎（可能因 fail-soft 回退与请求选择不同）。 */
  source: RoleReasonerKind;
}

export interface RoleReasoner {
  readonly kind: RoleReasonerKind;
  reason(req: RoleReasonRequest): Promise<RoleReasonOutcome>;
}

/**
 * 自研引擎：进程内 LangGraph ReAct。
 *
 * 行为与重构前 `runResearchTeamSlotReact` 内联调用 `executeAgentReact` 逐字一致：
 * 同样的 `streamLoopKind/streamSource/updateWorkflowStatus`，同样的 text 取值
 * （`finalState.reasonText` 优先，空则回退 `finalResponse` 的 JSON 串）。
 */
export class NativeRoleReasoner implements RoleReasoner {
  readonly kind = "native" as const;

  async reason(req: RoleReasonRequest): Promise<RoleReasonOutcome> {
    const result = await executeAgentReact({
      runId: req.runId,
      workflowId: req.workflowRunId,
      traceId: req.traceId,
      def: req.def,
      ...(req.agentInstanceId !== undefined ? { agentInstanceId: req.agentInstanceId } : {}),
      receiverAgent: `team-slot-${req.role}`,
      payload: req.payload,
      streamLoopKind: "native",
      streamSource: "native",
      updateWorkflowStatus: false,
    });
    const text =
      String(result.finalState.reasonText ?? "").trim() ||
      JSON.stringify(result.finalResponse ?? {});
    return { text, source: "native" };
  }
}

const nativeReasoner = new NativeRoleReasoner();

/**
 * CLI reasoner 注册表。P2/P3 把 claude_cli / codex_cli 实现注册进来；
 * 未注册时 `resolveRoleReasoner` fail-soft 回退 native。
 */
const cliReasonerRegistry = new Map<RoleReasonerKind, RoleReasoner>();

/** 供 cli-role-reasoner 模块在加载时登记自身（避免 msa ←→ loop 循环依赖）。 */
export function registerRoleReasoner(reasoner: RoleReasoner): void {
  if (reasoner.kind === "native") return;
  cliReasonerRegistry.set(reasoner.kind, reasoner);
}

/** 把 workflow 的引擎选择解析成一个具体 reasoner（纯函数，便于单测）。 */
export function pickRoleReasonerKind(input: {
  loopKind: unknown;
  roleReasonerOption?: RoleReasonerKind | undefined;
}): RoleReasonerKind {
  if (
    input.roleReasonerOption === "native" ||
    input.roleReasonerOption === "claude_cli" ||
    input.roleReasonerOption === "codex_cli"
  ) {
    return input.roleReasonerOption;
  }
  const kind = normalizeLoopKind(input.loopKind);
  return kind; // native | claude_cli | codex_cli 同名映射
}

/**
 * 按 workflow_run 决定本次单角色推理用哪个引擎。
 * CLI 引擎未注册（P0 阶段 / 二进制缺失）时回退 native。
 */
export async function resolveRoleReasoner(workflowRunId: string): Promise<RoleReasoner> {
  let loopKind: unknown = "native";
  let roleReasonerOption: RoleReasonerKind | undefined;
  try {
    const db = await getDb();
    const rows = await db
      .select({ loopKind: workflowRun.loopKind, loopOptionsJson: workflowRun.loopOptionsJson })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowRunId))
      .limit(1);
    if (rows[0]) {
      loopKind = rows[0].loopKind;
      roleReasonerOption = parseLoopOptionsJson(rows[0].loopOptionsJson).roleReasoner;
    }
  } catch {
    /* best-effort：读不到就走 native */
  }
  const want = pickRoleReasonerKind({ loopKind, roleReasonerOption });
  if (want === "native") return nativeReasoner;
  let cli = cliReasonerRegistry.get(want);
  if (!cli) {
    // 首次请求 CLI 引擎时动态加载（加载即自注册），避免静态循环依赖。
    try {
      await import("./cli-role-reasoner");
      cli = cliReasonerRegistry.get(want);
    } catch (e) {
      console.warn(
        "[role-reasoner] failed to load cli-role-reasoner:",
        e instanceof Error ? e.message : e
      );
    }
  }
  if (cli) return cli;
  // 选了 CLI 但未注册 / 不可用 → fail-soft 回退 native
  console.warn(
    `[role-reasoner] requested '${want}' but no reasoner registered; falling back to native`
  );
  return nativeReasoner;
}
