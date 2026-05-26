/**
 * P1-A：workflow_run.status 写入收敛点（唯一真理源）。
 *
 * 历史问题：`workflow_run.status` 在 25 处分散直写（execute-agent-react、
 * graph-factory、a2a-loop-driver、cli-loop-driver、hitl-service、
 * research-team-execute、restore-running-workflows、handlers/role-handlers、
 * routes/workflow、routes/analyst、msa/analyst-team、trader-workflow、
 * compensation-queue …），导致：
 *   - 没人能稳定回答"现在合法的迁移是什么"
 *   - HITL approve 后偶发 "running → awaiting_approval → running" 的违规
 *     bounce，以及 `failed → running` 的悄悄 resume，监控被污染
 *   - `endedAt` 字段语义飘忽（有时被设成 null、有时是 ISO 字符串、有时遗漏）
 *
 * 修复方案：所有 status 写入统一通过 {@link setWorkflowState}：
 *   1. 校验合法迁移；非法仅记日志 + 仍然完成写入（向后兼容，不阻塞业务）
 *   2. 自动维护 `endedAt`：终态 → 当前 ISO；非终态 → null
 *   3. 返回 `{ previous, current }`，便于调用方做幂等判断
 *
 * 注意：这是一个**功能保留**的重构。原本能 happen 的 transition 这里都允许，
 * 只是从"散点直写"挪到了"唯一函数 + 显式日志"。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";

export type WorkflowStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_approval";

/** 写入 `workflow_run.status` 后认为"工作流终结"的状态集合（用于决定是否写 endedAt） */
const TERMINAL_STATUSES = new Set<WorkflowStatus>(["completed", "failed", "cancelled"]);

/**
 * 合法迁移表。`*` 表示来自任何已有状态都允许。
 *
 * 设计来自实际代码盘点（P1-A 重构前 25 处直写的所有迁移路径），未列入的
 * 迁移会记 warn 日志但仍执行，避免引入回归。
 *
 *   - pending  ← *（创建/复用）
 *   - running  ← pending / awaiting_approval / failed / cancelled / running
 *                （首次派发、HITL resume、restore 时把 stale running 标 running、
 *                 compensation-queue 重试时 pending → running）
 *   - completed← running / awaiting_approval（成功 / HITL 完成后归一）
 *   - failed   ← running / awaiting_approval / pending（执行失败 / HITL reject
 *                / restore 把 stale 标 failed / compensation 失败）
 *   - cancelled← *（用户随时可以取消，包括已 cancelled 重复 cancel 的幂等）
 *   - awaiting_approval ← running（HITL 暂停）
 */
const ALLOWED_TRANSITIONS: Record<WorkflowStatus, ReadonlySet<WorkflowStatus | "*">> = {
  /** to=pending：reuse 同 session 工作流时把已 完结/取消 的 chat workflow 改回 pending */
  pending: new Set<WorkflowStatus | "*">(["pending", "completed", "failed", "cancelled"]),
  /** to=running：首派 / 幂等保持 / HITL resume / 失败后 restore-running 直接转 running */
  running: new Set<WorkflowStatus | "*">(["pending", "running", "awaiting_approval", "failed"]),
  /** to=awaiting_approval：仅在 running 时（act/team helper）能进入 HITL 暂停；幂等保留 */
  awaiting_approval: new Set<WorkflowStatus | "*">(["running", "awaiting_approval"]),
  /** to=completed：必须从 running 或 awaiting_approval 完结；幂等保留 */
  completed: new Set<WorkflowStatus | "*">(["running", "awaiting_approval", "completed"]),
  /** to=failed：从所有"未终态"都能失败；幂等保留 */
  failed: new Set<WorkflowStatus | "*">(["pending", "running", "awaiting_approval", "failed"]),
  /** to=cancelled：用户/系统在任何时刻都能取消（包括 trader-workflow 取消 dup 幂等） */
  cancelled: new Set<WorkflowStatus | "*">(["*"]),
};

function isAllowedTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  const allowedFrom = ALLOWED_TRANSITIONS[to];
  return allowedFrom.has("*") || allowedFrom.has(from);
}

export type SetWorkflowStateResult = {
  previous: WorkflowStatus | null;
  current: WorkflowStatus;
  transitionAllowed: boolean;
};

export type SetWorkflowStateOptions = {
  /**
   * 覆盖默认的 endedAt 行为：
   *   - "auto"（默认）：终态写当前 ISO，非终态写 null
   *   - "preserve"：不动 endedAt 列（用于 restoreRunningWorkflows 等需要保留
   *     原 endedAt 的场景）
   */
  endedAt?: "auto" | "preserve";
  /** 调用方上下文，写入 warn 日志方便定位 */
  reason?: string;
};

/**
 * 唯一的 `workflow_run.status` 写入入口。
 *
 * 行为：
 *   1. 先读当前状态
 *   2. 校验 from → to 是否允许（不允许只 warn，不阻塞）
 *   3. 写入 status + endedAt
 *   4. 返回前后状态
 */
export async function setWorkflowState(
  workflowId: string,
  toStatus: WorkflowStatus,
  options: SetWorkflowStateOptions = {},
): Promise<SetWorkflowStateResult> {
  const db = await getDb();
  const endedAtMode = options.endedAt ?? "auto";

  const prevRows = await db
    .select({ status: workflowRun.status })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const previous = (prevRows[0]?.status ?? null) as WorkflowStatus | null;

  const transitionAllowed = previous == null || isAllowedTransition(previous, toStatus);
  if (!transitionAllowed) {
    console.warn(
      `[workflow-state] illegal transition: ${previous} → ${toStatus} (workflowId=${workflowId})` +
        (options.reason ? ` reason=${options.reason}` : ""),
    );
  }

  const patch: { status: WorkflowStatus; endedAt?: string | null } = { status: toStatus };
  if (endedAtMode === "auto") {
    patch.endedAt = TERMINAL_STATUSES.has(toStatus) ? new Date().toISOString() : null;
  }

  await db.update(workflowRun).set(patch).where(eq(workflowRun.id, workflowId));

  return { previous, current: toStatus, transitionAllowed };
}

/** 测试用：暴露合法迁移检查，避免直接 export 内部常量。 */
export function _isAllowedTransitionForTest(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return isAllowedTransition(from, to);
}
