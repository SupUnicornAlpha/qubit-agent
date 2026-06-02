/**
 * Memory V2 · experience 模块统一导出入口。
 *
 * 业务模块应该 import 这个 barrel，而不是直接深入子文件 —— 给我们以后
 * 重排内部结构的自由（例如把 store 拆成 sqlite/store.ts + memory/store.ts）。
 */
export {
  getExperienceStore,
  setExperienceStoreForTesting,
  SqliteExperienceStore,
  InMemoryExperienceStore,
  type ExperienceStore,
} from "./experience-store";

export {
  getExperienceBus,
  setExperienceBusForTesting,
  eventToOp,
  type ExperienceBus,
  type ExperienceEvent,
  type ExperienceEventType,
  type ExperienceHandler,
  type Unsubscribe,
} from "./experience-bus";

export type {
  ExperienceQuery,
  InsertExperienceInput,
  UpdateExperienceInput,
  OpLogInput,
  LinkExpandParams,
} from "./types";

// ───────────────────────── P1 pipes ─────────────────────────
export {
  type ReflectionRunRepo,
  type ReflectionInsertInput,
  type ReflectionUpdatePatch,
  SqliteReflectionRunRepo,
  InMemoryReflectionRunRepo,
  getReflectionRunRepo,
  setReflectionRunRepoForTesting,
} from "./reflection-run-repo";

export {
  startWriterPipe,
  EPISODIC_BODY_MAX_CP,
  type WriterHandle,
  type WriterOptions,
} from "./pipes/writer";

export {
  startExtractorPipe,
  type ExtractorHandle,
  type ExtractorLoader,
  type ExtractorOptions,
  type ExtractorWorkflowSummary,
} from "./pipes/extractor";

export {
  startReflectorPipe,
  buildReflectionPrompt,
  parseReflectionJson,
  computeFailureSignature,
  playReflectionOnce,
  evalLessonsAgainstGroundTruth,
  REFLECTION_FEWSHOT,
  DEFAULT_DAILY_BUDGET,
  DEFAULT_SAMPLE_RATE,
  EST_REFLECTION_TOKENS,
  type BuildReflectionPromptOptions,
  type LessonsEvalResult,
  type LlmCallFn,
  type ReflectionPlaybackResult,
  type ReflectorHandle,
  type ReflectorLoader,
  type ReflectorOptions,
  type ReflectorWorkflowContext,
} from "./pipes/reflector";

export {
  runJanitorOnce,
  computeQualityScore,
  evaluateDecay,
  type DecayDecision,
  type JanitorOptions,
  type JanitorRunSummary,
} from "./pipes/janitor";

export {
  ExperienceRecall,
  renderRecallBlockForPrompt,
  tokenize,
  keywordScore,
  recencyScore,
  type RecallContext,
  type RecallResult,
  type RecallEngineOptions,
} from "./pipes/recall";

// ───────────────────────── P1.5 监控 / 维护 / 对账 ─────────────────────────
export {
  attachMemoryMetrics,
  getMemoryMetricsCollector,
  getMemoryMetricsSnapshot,
  setMemoryMetricsCollectorForTesting,
  resetMemoryMetricsForTesting,
  InMemoryMetricsCollector,
  type MetricsCollector,
  type MetricsHandle,
} from "./metrics";

export {
  ExperienceMaintenanceWorker,
  experienceMaintenanceWorker,
  type ExperienceMaintenanceOptions,
  type ExperienceMaintenanceTickResult,
} from "./maintenance-worker";

export {
  reconcileProject,
  extractSkillSignature,
  type ReconcileInput,
  type ReconcileReport,
  type ReconcileSemanticDiff,
  type ReconcileProceduralDiff,
  type ReconcileReflectiveStats,
} from "./reconciliation";
