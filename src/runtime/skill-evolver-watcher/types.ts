/**
 * Self-Evolving Agent P6 — SkillEvolverWatcher 类型定义。
 *
 * Reflector / 任何方需要触发 skill 自动修订时，写一条：
 *   experience(kind='reflective', subKind='skill_revision_request',
 *              metadataJson={ baseSkillId, reason, requestedBy, iterations? })
 *
 * Watcher 周期扫这条队列：未处理 → 调 SkillEvolver.evolve → 把 evolutionRunId / status
 * 回写到 metadataJson 标记已处理。重跑、补处理都安全。
 */

/** 写到 reflective.metadataJson 的请求体（contract） */
export interface SkillRevisionRequestMeta {
  /** 必填：要演化的 base skill id */
  baseSkillId: string;
  /** 谁请求的：'reflector' | 'user' | 'janitor' | 'auto' */
  requestedBy: string;
  /** 自由说明：失败信号 / 用户备注 / janitor 触发条件 */
  reason?: string;
  /** 可选覆写 SkillEvolver.evolve 的 iterations / candidatesPerIteration */
  iterations?: number;
  candidatesPerIteration?: number;
  /** Watcher 处理后回写（v0 字段；未处理时为 undefined） */
  processedAt?: string;
  evolutionRunId?: string;
  evolveStatus?: "completed" | "failed" | "skipped_base_missing" | "skipped_base_archived";
  evolveError?: string;
}

/** 单次 watcher tick 处理的结果（一行 = 一条 reflective request） */
export interface WatcherProcessResult {
  experienceId: string;
  baseSkillId: string;
  status: NonNullable<SkillRevisionRequestMeta["evolveStatus"]>;
  evolutionRunId?: string;
  errorMessage?: string;
}

/** 一次 watcher tick 的总览（emit 给 metrics） */
export interface WatcherTickSummary {
  scanned: number;
  processed: number;
  skippedBaseMissing: number;
  skippedBaseArchived: number;
  failed: number;
  elapsedMs: number;
  results: WatcherProcessResult[];
}
