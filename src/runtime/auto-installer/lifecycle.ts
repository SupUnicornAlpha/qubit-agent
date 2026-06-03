/**
 * AutoInstaller proposal 状态机迁移：
 *   approveProposal  : pending_review → approved      ; gap: proposed → installed
 *   rejectProposal   : pending_review → rejected      ; gap: proposed → rejected
 *   resolveNoCandidate: 用户在 no_candidate 上点 "ok"，把它存档（rejected）
 *
 * 注意：approve 只是状态标记 —— 真去 install MCP 是 P9 / 用户在
 * mcp catalog 已有装机器上一键 install 的事，本期不做。
 *
 * 设计：纯函数 + 错误显式，业务不可恢复的状态错误统一抛 `ProposalStateError`。
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/sqlite/client.js";
import { autoInstallProposal, toolGapLog } from "../../db/sqlite/schema.js";

export class ProposalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalStateError";
  }
}

export interface TransitionInput {
  proposalId: string;
  actor: string;
  reason?: string;
}

export interface TransitionResult {
  proposalId: string;
  gapLogId: string;
  fromState: string;
  toState: string;
  gapStatusChanged: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function loadProposalOrThrow(id: string): Promise<{
  id: string;
  state: string;
  gapLogId: string;
  projectId: string;
}> {
  const db = await getDb();
  const rows = await db
    .select({
      id: autoInstallProposal.id,
      state: autoInstallProposal.state,
      gapLogId: autoInstallProposal.gapLogId,
      projectId: autoInstallProposal.projectId,
    })
    .from(autoInstallProposal)
    .where(eq(autoInstallProposal.id, id))
    .all();
  if (rows.length === 0) {
    throw new ProposalStateError(`proposal not found: ${id}`);
  }
  return rows[0]!;
}

export async function approveProposal(input: TransitionInput): Promise<TransitionResult> {
  const p = await loadProposalOrThrow(input.proposalId);
  if (p.state !== "pending_review") {
    throw new ProposalStateError(
      `cannot approve from state=${p.state}; only pending_review allowed`
    );
  }
  const db = await getDb();
  const ts = nowIso();
  await db
    .update(autoInstallProposal)
    .set({
      state: "approved",
      stateAt: ts,
      stateBy: input.actor,
      stateReason: input.reason ?? null,
      updatedAt: ts,
    })
    .where(eq(autoInstallProposal.id, p.id));

  // gap 同步：proposed → installed（如果 gap 仍是 proposed）
  const gapResult = await db
    .update(toolGapLog)
    .set({
      status: "installed",
      statusAt: ts,
      statusBy: input.actor,
      statusReason: `approved proposal ${p.id}`,
      updatedAt: ts,
    })
    .where(and(eq(toolGapLog.id, p.gapLogId), eq(toolGapLog.status, "proposed")))
    .returning({ id: toolGapLog.id });

  return {
    proposalId: p.id,
    gapLogId: p.gapLogId,
    fromState: "pending_review",
    toState: "approved",
    gapStatusChanged: gapResult.length > 0,
  };
}

export async function rejectProposal(input: TransitionInput): Promise<TransitionResult> {
  const p = await loadProposalOrThrow(input.proposalId);
  if (p.state !== "pending_review" && p.state !== "no_candidate") {
    throw new ProposalStateError(
      `cannot reject from state=${p.state}; only pending_review / no_candidate allowed`
    );
  }
  const db = await getDb();
  const ts = nowIso();
  await db
    .update(autoInstallProposal)
    .set({
      state: "rejected",
      stateAt: ts,
      stateBy: input.actor,
      stateReason: input.reason ?? null,
      updatedAt: ts,
    })
    .where(eq(autoInstallProposal.id, p.id));

  // gap 同步：仅 proposed → rejected；no_candidate 时 gap 还是 open（不动）
  let changed = false;
  if (p.state === "pending_review") {
    const gapResult = await db
      .update(toolGapLog)
      .set({
        status: "rejected",
        statusAt: ts,
        statusBy: input.actor,
        statusReason: `rejected proposal ${p.id}`,
        updatedAt: ts,
      })
      .where(and(eq(toolGapLog.id, p.gapLogId), eq(toolGapLog.status, "proposed")))
      .returning({ id: toolGapLog.id });
    changed = gapResult.length > 0;
  }

  return {
    proposalId: p.id,
    gapLogId: p.gapLogId,
    fromState: p.state,
    toState: "rejected",
    gapStatusChanged: changed,
  };
}
