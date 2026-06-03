/**
 * ExperienceBus — Memory V2 进程内事件总线（P0 落地，详见 docs/MEMORY_V2_DESIGN.md §4.2）。
 *
 * 解决的问题：
 *   旧设计里 `onWorkflowTerminal` 直接 import `consolidateFromWorkflow` /
 *   `syncMemoryForWorkflow`；reason 节点直接 import `skillService.searchWithMeta`；
 *   `skill-recall-logger` 又直接被 reason 调。这种点对点耦合让 5 个 pipe 无法
 *   独立演进 —— 加一个 pipe 就得改所有事件源。
 *
 * 设计原则（保持 Bus 极简，避免它变成"分布式系统"）：
 *   - **同步、in-process**：handler 抛错不会污染其它 handler（catch + warn）。
 *   - **零持久化**：事件不入库；如果某个 pipe 需要"重放"，自己定时器扫 DB。
 *   - **零顺序保证**：subscribe 顺序无关；handler 可以并发执行（这一版仍串行，
 *     方便测试断言，但 caller 不应依赖顺序）。
 *   - **类型安全**：事件 union 用判别字段 `type` 收敛，subscribe<T> 自动窄化。
 *
 * 与 Node EventEmitter 的差异：
 *   - 强类型，IDE 自动补全；
 *   - emit 不抛错，handler 错误被吞 + warn，绝不阻塞 caller；
 *   - 不暴露 once / prependListener 等冷僻 API，避免被滥用。
 */

import type {
  AgentStep,
  ExperienceOp,
  ExperienceOutcome,
  WorkflowStatus,
} from "../../types/entities";

/**
 * 业务事件 union。**新增一种事件时**：
 *   1. 加一个 case 到这个 union；
 *   2. 写一个简单的 doc comment 说明"谁 emit / 谁可能 subscribe"；
 *   3. 不需要改 Bus 实现 —— 类型推导自动生效。
 */
export type ExperienceEvent =
  /**
   * 每个 agent_step 写入后由 langgraph executor emit。
   * Writer 订阅 → 追加到 episodic（按 workflow 折叠）。
   */
  | {
      type: "step_emitted";
      workflowRunId: string;
      definitionId: string | null;
      step: AgentStep;
    }
  /**
   * workflow 走到终态时由 `onWorkflowTerminal` emit（completed / failed 都发）。
   * Extractor 订阅 → 规则式提炼；Reflector 订阅 → 决定是否反思（含 budget/dedup）。
   */
  | {
      type: "workflow_terminal";
      workflowRunId: string;
      projectId: string;
      status: Extract<WorkflowStatus, "completed" | "failed">;
    }
  /**
   * Recall 召回出一条 experience 后 emit（fire-and-forget）。
   * Writer 订阅 → 落 experience_op_log(op=recall)，驱动后续 qualityScore。
   */
  | {
      type: "experience_recalled";
      experienceId: string;
      workflowRunId: string;
      agentStepId: string | null;
      rank: number;
      score: number;
    }
  /**
   * Agent 真的执行了某条召回到的 experience（典型：采纳了 skill 的步骤）。
   * Writer 订阅 → 落 op_log(op=execute, outcome)，驱动 successCount/failCount。
   */
  | {
      type: "experience_executed";
      experienceId: string;
      workflowRunId: string;
      outcome: ExperienceOutcome;
    }
  /**
   * HITL 用户反馈。Reflector / Writer 都可订阅。
   * verdict="approve" 加分；"reject" 标 conflicts_with 候选源头。
   */
  | {
      type: "hitl_feedback";
      workflowRunId: string;
      verdict: "approve" | "reject";
      note?: string;
    }
  /**
   * Janitor / Curator 完成一轮维护后 emit；监控面板订阅做指标。
   *
   * Self-Evolving Agent P4b 新增 3 个 kind：
   *   - pnl_attributor      — PnlAttributor.runOnce 跑完一次
   *   - analyst_accuracy    — AnalystAccuracyWriter.syncPlaceholders + evaluatePending 跑完
   *   - mark_price_fetcher  — DailyMarkPriceFetcher.fetchAndPersist 跑完
   *
   * P5 新增 1 个 kind：
   *   - skill_promoter      — SkillPromoter.runOnce 跑完
   *
   * P6 新增 1 个 kind：
   *   - skill_evolver       — SkillEvolverWatcher.runOnce 跑完
   */
  | {
      type: "maintenance_run";
      kind:
        | "janitor"
        | "skill_curator"
        | "reflector_daily"
        | "embedder"
        | "pnl_attributor"
        | "analyst_accuracy"
        | "mark_price_fetcher"
        | "skill_promoter"
        | "skill_evolver";
      actor: string;
      summary: Record<string, number | string>;
    };

export type ExperienceEventType = ExperienceEvent["type"];

/** 抽出 union 里某个 type 对应的具体 event 子类型，让 handler 拿到精确类型。 */
type EventByType<T extends ExperienceEventType> = Extract<ExperienceEvent, { type: T }>;

export type ExperienceHandler<T extends ExperienceEventType> = (
  ev: EventByType<T>
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface ExperienceBus {
  emit(ev: ExperienceEvent): void;
  subscribe<T extends ExperienceEventType>(type: T, handler: ExperienceHandler<T>): Unsubscribe;
  /** 仅供测试 / shutdown 用，清空所有 handler */
  clearAllForTesting(): void;
  /** 仅供测试用：返回某事件类型的当前 handler 数 */
  handlerCount(type: ExperienceEventType): number;
  /**
   * 等待最近一次 emit 引发的所有 async handler 都 settle。
   * 测试里 emit 同步返回但 handler 可能是 async；用 awaitIdle 取代 setTimeout(0)。
   */
  awaitIdle(): Promise<void>;
}

class InProcessExperienceBus implements ExperienceBus {
  private handlers = new Map<ExperienceEventType, Set<ExperienceHandler<ExperienceEventType>>>();
  private inflight = new Set<Promise<unknown>>();

  emit(ev: ExperienceEvent): void {
    const set = this.handlers.get(ev.type);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      let result: void | Promise<void>;
      try {
        result = handler(ev as EventByType<typeof ev.type>);
      } catch (err) {
        warnHandlerFailure(ev.type, err);
        continue;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        const p = (result as Promise<void>).catch((err) => {
          warnHandlerFailure(ev.type, err);
        });
        this.inflight.add(p);
        p.finally(() => this.inflight.delete(p));
      }
    }
  }

  subscribe<T extends ExperienceEventType>(type: T, handler: ExperienceHandler<T>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as ExperienceHandler<ExperienceEventType>);
    return () => {
      set?.delete(handler as ExperienceHandler<ExperienceEventType>);
    };
  }

  clearAllForTesting(): void {
    this.handlers.clear();
    this.inflight.clear();
  }

  handlerCount(type: ExperienceEventType): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  async awaitIdle(): Promise<void> {
    // 至多 5 轮排空：handler 内部又 emit 引发的新 inflight 也要等到。
    for (let i = 0; i < 5 && this.inflight.size > 0; i++) {
      await Promise.allSettled(Array.from(this.inflight));
    }
  }
}

function warnHandlerFailure(type: ExperienceEventType, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[experience-bus] handler for ${type} failed: ${msg}`);
}

// ───────────────────────── 默认实例 ─────────────────────────

let _default: ExperienceBus | null = null;

export function getExperienceBus(): ExperienceBus {
  if (!_default) _default = new InProcessExperienceBus();
  return _default;
}

export function setExperienceBusForTesting(bus: ExperienceBus | null): void {
  _default = bus;
}

/**
 * Op type 与事件 type 的简易映射（给 Writer 写 op_log 时省得 switch）。
 * 不强制使用；保留扩展点。
 */
export function eventToOp(type: ExperienceEventType): ExperienceOp | null {
  switch (type) {
    case "experience_recalled":
      return "recall";
    case "experience_executed":
      return "execute";
    default:
      return null;
  }
}
