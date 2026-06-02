/**
 * Reflection playback — Memory V2 P1.5 提示词调优工具
 *
 * 用法：
 *   bun run src/scripts/run-reflection-playback.ts \
 *     --workflowId=<id> [--includeFewShot=false] [--noLlm]
 *
 * 行为：
 *   1) 从 DB 读 workflow + steps，凑出 ReflectorWorkflowContext
 *   2) 调 LLM（默认走 resolveLlmForAgent + invokeWithFallback）
 *   3) 打印 prompt / raw output / parsed lessons / 解析错误（如有）
 *   不会写任何表，绝对安全；适合 A/B prompt 改动。
 *
 * 输出 stderr 是 prompt + raw；stdout 是结构化 JSON（pipe 进 jq 用）。
 */

import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import { agentInstance, agentStep, workflowRun } from "../db/sqlite/schema";
import {
  type LlmCallFn,
  type ReflectorWorkflowContext,
  playReflectionOnce,
} from "../runtime/experience";
import { invokeWithFallback, resolveLlmForAgent } from "../runtime/llm/llm-router";

interface CliArgs {
  workflowId?: string;
  includeFewShot: boolean;
  noLlm: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { includeFewShot: true, noLlm: false };
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
    const val = eq >= 0 ? raw.slice(eq + 1) : "true";
    if (key === "workflowId" || key === "workflow_id") args.workflowId = val;
    else if (key === "includeFewShot") args.includeFewShot = val !== "false";
    else if (key === "noLlm") args.noLlm = val !== "false";
  }
  return args;
}

async function loadReflectorContext(workflowId: string): Promise<ReflectorWorkflowContext | null> {
  const db = await getDb();
  const wfRows = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowId)).limit(1);
  const wf = wfRows[0];
  if (!wf) return null;

  const steps = await db
    .select()
    .from(agentStep)
    .where(eq(agentStep.workflowRunId, workflowId))
    .orderBy(asc(agentStep.stepIndex));

  // 取第一条 instance 作为 reflective 归属（playback 用，不必精确分组）
  const instanceIds = Array.from(
    new Set(steps.map((s) => s.agentInstanceId).filter(Boolean) as string[])
  );
  const instances = instanceIds.length
    ? await db.select().from(agentInstance).where(inArray(agentInstance.id, instanceIds))
    : [];
  const firstInstance = instances[0];

  const recentLines: string[] = [];
  for (const s of steps.slice(-30)) {
    recentLines.push(
      `[#${s.stepIndex} ${s.phase}/${s.actionType}] action=${JSON.stringify(s.actionJson).slice(0, 200)} obs=${JSON.stringify(s.observationJson ?? null).slice(0, 200)}`
    );
  }

  // 失败提示：若 wf.status=failed，从最后一步推断 toolName / errorClass
  let failureHint: ReflectorWorkflowContext["failureHint"];
  if (wf.status === "failed") {
    const last = steps[steps.length - 1];
    if (last) {
      const action = (last.actionJson ?? {}) as Record<string, unknown>;
      const obs = (last.observationJson ?? {}) as Record<string, unknown>;
      failureHint = {
        role: firstInstance?.role ?? "unknown",
        toolName: typeof action.tool === "string" ? (action.tool as string) : last.actionType,
        errorClass: typeof obs.error === "string" ? (obs.error as string) : "Unknown",
      };
    }
  }

  return {
    workflowRunId: wf.id,
    projectId: wf.projectId,
    status: (wf.status === "completed" || wf.status === "failed" ? wf.status : "completed") as
      | "completed"
      | "failed",
    mode: wf.mode,
    goal: wf.goal,
    ...(failureHint ? { failureHint } : {}),
    definitionId: firstInstance?.definitionId ?? null,
    episodicIds: [],
    recentStepsText: recentLines.join("\n"),
  };
}

function buildLlm(noLlm: boolean): LlmCallFn {
  if (noLlm) {
    return async () => ({
      text: '```json\n{"lessons":[]}\n```',
      tokensUsed: 0,
    });
  }
  return async (prompt) => {
    const llm = await resolveLlmForAgent({});
    const res = await invokeWithFallback(llm.config, {
      systemPrompt: prompt.system,
      userPrompt: prompt.user,
      onToken: () => {},
    });
    return {
      text: res.answer,
      tokensUsed: res.usage?.totalTokens ?? 0,
    };
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workflowId) {
    console.error(
      "Usage: bun run run-reflection-playback.ts --workflowId=<id> [--includeFewShot=false] [--noLlm]"
    );
    process.exit(2);
  }

  await runMigrations();
  const ctx = await loadReflectorContext(args.workflowId);
  if (!ctx) {
    console.error(`workflow ${args.workflowId} not found`);
    process.exit(3);
  }

  const llm = buildLlm(args.noLlm);
  const result = await playReflectionOnce({
    ctx,
    llm,
    promptOptions: { includeFewShot: args.includeFewShot },
  });

  console.error("─── PROMPT ───────────────────────────────────────");
  console.error("[system]");
  console.error(result.prompt.system);
  console.error("\n[user]");
  console.error(result.prompt.user);
  console.error("\n─── RAW OUTPUT ───────────────────────────────────");
  console.error(result.rawText);

  console.log(
    JSON.stringify(
      {
        workflowId: args.workflowId,
        tokensUsed: result.tokensUsed,
        lessonsCount: result.parsed.length,
        lessons: result.parsed,
        parseError: result.parseError ?? null,
      },
      null,
      2
    )
  );

  process.exit(result.parsed.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[reflection-playback] fatal:", err);
  process.exit(2);
});
