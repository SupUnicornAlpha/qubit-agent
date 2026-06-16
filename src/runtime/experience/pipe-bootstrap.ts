/**
 * Wave-1（2026-06-10）：把 experience pipes 在生产代码里启动。
 *
 * 背景：
 *   `startWriterPipe / startExtractorPipe / startReflectorPipe / startWorkflowSummarizerPipe`
 *   等 P1 pipe 都是显式 attach 模型 —— 旧代码里只在 *.test.ts 出现过；
 *   `experienceMaintenanceWorker` 只跑 Janitor + Embedder。
 *
 *   于是生产环境 ExperienceBus 上的 `workflow_terminal` 事件其实**没有 handler**，
 *   导致 Memory V2 设计文档中的 5 个 pipe 中：
 *     - Writer / Extractor / Reflector → 完全不工作（被 emit 但无人订阅）
 *     - Recall → 在 reason 节点直接调，不走 bus，已正常工作
 *     - Janitor / Embedder → 在 maintenance-worker 里，已工作
 *
 *   这次只接入 WorkflowSummarizer（user 明确要求"完成 workflow 后 LLM 总结"）；
 *   Writer / Extractor / Reflector 的 attach 留给后续 wave。
 *
 * 入口：
 *   `attachExperiencePipes()` 在 src/index.ts 启动期调一次（幂等）。
 */

import { loadModelConfig } from "../config/model-config";
import { invokeWithFallback } from "../llm/llm-router";
import { getExperienceBus } from "./experience-bus";
import { getExperienceStore } from "./experience-store";
import { sqliteExtractorLoader, sqliteReflectorLoader } from "./pipe-loaders";
import { type ExtractorHandle, startExtractorPipe } from "./pipes/extractor";
import { type ReflectorHandle, startReflectorPipe } from "./pipes/reflector";
import type { SummarizerHandle } from "./pipes/workflow-summarizer";
import {
  type SummarizerLlmCallFn,
  sqliteSummarizerLoader,
  startWorkflowSummarizerPipe,
} from "./pipes/workflow-summarizer";
import { type WriterHandle, startWriterPipe } from "./pipes/writer";

/**
 * LLM callback 适配器：使用项目默认 model 跑一次 LLM 调用（带 fallback），
 * 不订阅任何流（用 noop onToken）。tokensUsed 从 InvokeWithFallbackResult.usage 取
 * （若 provider 不报 → 用 estimateTokens 兜底）。
 */
const summarizerLlm: SummarizerLlmCallFn = async ({ system, user }) => {
  const cfg = await loadModelConfig();
  if (!cfg) {
    throw new Error("workflow-summarizer: loadModelConfig returned null");
  }
  const res = await invokeWithFallback(cfg, {
    systemPrompt: system,
    userPrompt: user,
    onToken: () => {
      /** 流式 token 不消费 */
    },
  });
  /**
   * usage 字段在 OpenAI / Anthropic 等 provider 普遍可得；不可得时按
   * 4 字符≈1 token 粗估。仅用于 daily budget，估错一点不致命。
   */
  const tokensUsed =
    res.usage?.totalTokens ?? Math.ceil((system.length + user.length + res.answer.length) / 4);
  return { text: res.answer, tokensUsed };
};

interface PipeHandles {
  summarizer?: SummarizerHandle;
  writer?: WriterHandle;
  extractor?: ExtractorHandle;
  reflector?: ReflectorHandle;
}
let _handles: PipeHandles | null = null;

/**
 * 启动 experience pipes（幂等）。
 *
 * P0（2026-06）：把 Writer / Extractor / Reflector 一并接上（此前只接 summarizer，
 * 导致 workflow_terminal 事件几乎无 handler、skill 候选无来源、长期记忆几乎不触发）。
 *   - Writer：step_emitted → episodic（事件驱动，自包含）
 *   - Extractor：workflow_terminal → procedural workflow_play（喂 SkillPromoter 晋升）
 *   - Reflector：workflow_failed / 抽样 completed → reflective（失败反思）
 *   - Summarizer：completed → semantic 总结
 *
 * 设计：每个 pipe 启动失败仅 warn，互不影响（pipe 是旁路增强，不在主链路）。
 */
export function attachExperiencePipes(): void {
  if (_handles) return;
  const handles: PipeHandles = {};
  const store = getExperienceStore();
  const bus = getExperienceBus();
  const attempt = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`[experience-pipes] attached: ${name}`);
    } catch (err) {
      console.warn(`[experience-pipes] failed to attach ${name}: ${(err as Error).message}`);
    }
  };

  attempt("writer", () => {
    handles.writer = startWriterPipe({ store, bus });
  });
  attempt("extractor", () => {
    handles.extractor = startExtractorPipe({ store, bus, loader: sqliteExtractorLoader });
  });
  attempt("reflector", () => {
    handles.reflector = startReflectorPipe({
      store,
      bus,
      loader: sqliteReflectorLoader,
      llm: summarizerLlm,
    });
  });
  attempt("workflow-summarizer", () => {
    handles.summarizer = startWorkflowSummarizerPipe({
      store,
      bus,
      loader: sqliteSummarizerLoader,
      llm: summarizerLlm,
    });
  });

  _handles = handles;
}

/** 仅供测试：detach all + 重置 */
export function _detachExperiencePipesForTesting(): void {
  if (!_handles) return;
  _handles.summarizer?.detach();
  _handles.writer?.detach();
  _handles.extractor?.detach();
  _handles.reflector?.detach();
  _handles = null;
}
