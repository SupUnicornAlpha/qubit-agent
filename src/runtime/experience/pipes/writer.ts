/**
 * Writer Pipe — Memory V2 P1（详见 docs/MEMORY_V2_DESIGN.md §6.3）。
 *
 * 唯一职责：把 Bus 上的「事件流」翻译成 ExperienceStore 上的「持久化操作」。
 *
 * 订阅的 3 类事件：
 *   1. step_emitted          → 折叠为 workflow 维度的 episodic experience
 *   2. experience_recalled   → 落 op_log(op=recall)，并 useCount++（**异步**，不阻塞 recall）
 *   3. experience_executed   → 落 op_log(op=execute, outcome) + successCount/failCount
 *
 * 三个高内聚低耦合的设计点：
 *   - **不感知 Recall / Reflector**：纯被动 handler，靠 event type 路由；新增"另一类 op"
 *     只需加一个 case 不动其它 handler。
 *   - **不调 LLM**：所有处理都是 in-memory 折叠 + Store CRUD；保证 < 5ms 热路径开销。
 *   - **失败不抛错**：handler 内部全 try/catch + warn，单条事件 fail 不污染 Bus。
 *
 * 与旧路径关系（P1 双写期）：
 *   旧 consolidateFromWorkflow 仍跑（生成 midterm_memory + skill 候选）；
 *   Writer 平行往 experience 表写 episodic。一周对账确认无 diff 后下线旧路径。
 */

import type { Experience } from "../../../types/entities";
import type { ExperienceBus, Unsubscribe } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";

export interface WriterOptions {
  store: ExperienceStore;
  bus: ExperienceBus;
}

export interface WriterHandle {
  /** 取消订阅所有 3 类 handler；测试 / shutdown 用 */
  detach(): void;
}

/**
 * 启动 Writer pipe 并把它挂到 Bus 上。返回 detach() 用于取消。
 *
 * 设计：返回 handle 而不是用 singleton —— 让测试能"挂 → 跑 → 拆"独立循环，
 * 也方便后续如果想"按 project 起独立 Writer"也不用改 API。
 */
export function startWriterPipe(opts: WriterOptions): WriterHandle {
  const { store, bus } = opts;

  /**
   * 同一 workflow 的 episodic upsert 必须串行，否则并发 emit 会让多个 handler
   * 同时跑 `findOpenEpisodicForWorkflow` 都返回 null，结果各自插一条 → 折叠失败。
   *
   * 生产里 langgraph executor 串行 emit step 不会触发此 race，但单测和未来如果
   * 引入并发 emitter 时仍需要保护。用 per-key Promise chain（轻量且无外部依赖）。
   */
  const episodicLock = new Map<string, Promise<unknown>>();
  const runSerialized = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = episodicLock.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    episodicLock.set(
      key,
      next.finally(() => {
        if (episodicLock.get(key) === next) episodicLock.delete(key);
      })
    );
    return next;
  };

  // ───── step_emitted → episodic 折叠 ─────
  const offStep = bus.subscribe("step_emitted", async (ev) => {
    try {
      // 只折 tool_call / final_answer / memory_write 三类"有产出"的 step；
      // perceive / observe 这种纯流转步骤不进 episodic，避免行爆炸。
      if (
        ev.step.actionType !== "tool_call" &&
        ev.step.actionType !== "final_answer" &&
        ev.step.actionType !== "memory_write"
      ) {
        return;
      }

      await runSerialized(ev.workflowRunId, async () => {
        const existing = await findOpenEpisodicForWorkflow(store, ev.workflowRunId);
        const entry = formatStepEntry(ev.step);

        if (existing) {
          const body = `${(existing.contentJson.body ?? "").toString().trimEnd()}\n${entry}`.slice(
            -EPISODIC_BODY_MAX_CP
          );
          await store.update(existing.id, {
            contentJson: {
              summary: existing.contentJson.summary,
              body,
              stepCount: ((existing.contentJson.stepCount as number) ?? 0) + 1,
            },
          });
        } else {
          await store.insert({
            kind: "episodic",
            subKind: "workflow_trail",
            scope: "workflow",
            scopeId: ev.workflowRunId,
            definitionId: ev.definitionId,
            visibility: "agent_private",
            contentJson: {
              summary: `workflow ${ev.workflowRunId} step trail`,
              body: entry,
              stepCount: 1,
            },
            tagsJson: [`role:${ev.definitionId ?? "unknown"}`],
            validFrom: ev.step.createdAt,
            sourceRunId: ev.workflowRunId,
          });
        }
      });
    } catch (err) {
      warnHandler("step_emitted", err);
    }
  });

  // ───── experience_recalled → op_log(recall) + useCount++ ─────
  const offRecall = bus.subscribe("experience_recalled", async (ev) => {
    try {
      await store.logOp({
        experienceId: ev.experienceId,
        op: "recall",
        actor: "reason",
        workflowRunId: ev.workflowRunId,
        metadataJson: {
          rank: ev.rank,
          score: ev.score,
          agentStepId: ev.agentStepId ?? null,
        },
      });
      const exp = await store.findById(ev.experienceId);
      if (exp) await store.update(exp.id, { useCount: exp.useCount + 1 });
    } catch (err) {
      warnHandler("experience_recalled", err);
    }
  });

  // ───── experience_executed → op_log(execute) + outcome 计数 ─────
  const offExecute = bus.subscribe("experience_executed", async (ev) => {
    try {
      await store.logOp({
        experienceId: ev.experienceId,
        op: "execute",
        actor: "act",
        workflowRunId: ev.workflowRunId,
        outcome: ev.outcome,
      });
      const exp = await store.findById(ev.experienceId);
      if (!exp) return;
      const patch: Parameters<ExperienceStore["update"]>[1] = {};
      if (ev.outcome === "success") patch.successCount = exp.successCount + 1;
      if (ev.outcome === "fail") patch.failCount = exp.failCount + 1;
      if (Object.keys(patch).length > 0) await store.update(exp.id, patch);
    } catch (err) {
      warnHandler("experience_executed", err);
    }
  });

  return {
    detach() {
      offStep();
      offRecall();
      offExecute();
    },
  };
}

// ───────────────────────── 工具函数（pure，便于单测） ─────────────────────────

/** 同一 workflow 的 episodic 行体上限；超出按"保留最新尾部"截断，避免无限增长。 */
export const EPISODIC_BODY_MAX_CP = 6000;

/**
 * 找到当前 workflow 还在 open 状态（validTo == null）的 episodic 行。
 * 同一 workflow 理论上至多 1 条；多于 1 条则取最早创建的（防止并发写时拆出多条）。
 */
export async function findOpenEpisodicForWorkflow(
  store: ExperienceStore,
  workflowRunId: string
): Promise<Experience | null> {
  const rows = await store.query({
    kind: "episodic",
    scope: "workflow",
    scopeId: workflowRunId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 5,
  });
  if (rows.length === 0) return null;
  // 取 createdAt 最早的（最先创建即"open epoch"）
  return rows.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/**
 * 把一个 agent_step 翻成 episodic body 里的一行。短、可 grep。
 */
export function formatStepEntry(step: {
  stepIndex: number;
  phase: string;
  actionType: string;
  actionJson: unknown;
  observationJson: unknown | null;
  createdAt: string;
}): string {
  const ts = step.createdAt.replace("T", " ").replace(/\..+$/, "");
  const action = compactJson(step.actionJson, 200);
  const obs = compactJson(step.observationJson, 200);
  const parts = [
    `[${ts}] #${step.stepIndex} ${step.phase}/${step.actionType}`,
    action ? `→ ${action}` : "",
  ];
  if (obs) parts.push(`  ⟵ ${obs}`);
  return parts.filter(Boolean).join(" ");
}

function compactJson(v: unknown, maxLen: number): string {
  if (v == null) return "";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  // 折叠多余空白
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1)}…`;
  return s;
}

function warnHandler(eventType: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[experience-writer] handler for ${eventType} failed: ${msg}`);
}

// 类型导出方便测试断言
export type _WriterHandleForTesting = WriterHandle;
// 暴露 unsubscribe 数组的便捷类型
export type _Unsub = Unsubscribe;
