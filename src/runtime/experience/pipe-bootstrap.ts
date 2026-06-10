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
import type { SummarizerHandle } from "./pipes/workflow-summarizer";
import {
  sqliteSummarizerLoader,
  startWorkflowSummarizerPipe,
  type SummarizerLlmCallFn,
} from "./pipes/workflow-summarizer";

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

let _handles: { summarizer?: SummarizerHandle } | null = null;

/**
 * 启动 experience pipes（幂等）。
 *
 * 设计：handle 保存在 module 级单例；重复调直接返回。任何 pipe 启动失败仅 warn，
 * 不影响进程主流程（pipe 本身就是"锦上添花"，不在主链路上）。
 */
export function attachExperiencePipes(): void {
  if (_handles) return;
  _handles = {};
  try {
    _handles.summarizer = startWorkflowSummarizerPipe({
      store: getExperienceStore(),
      bus: getExperienceBus(),
      loader: sqliteSummarizerLoader,
      llm: summarizerLlm,
    });
    console.log("[experience-pipes] attached: workflow-summarizer");
  } catch (err) {
    console.warn(
      `[experience-pipes] failed to attach workflow-summarizer: ${(err as Error).message}`
    );
  }
}

/** 仅供测试：detach all + 重置 */
export function _detachExperiencePipesForTesting(): void {
  if (!_handles) return;
  _handles.summarizer?.detach();
  _handles = null;
}
