/**
 * Judge Client 工厂：把现有 LLM Router 包装成 JudgeClient 接口。
 *
 * 设计取舍：
 *   - 复用 invokeWithFallback：享受 fallback / length-retry / 熔断 等基础设施
 *   - 默认走 .qubit/model.json 的 default 模型；CLI 可显式覆盖 provider/model
 *   - judge 调用本身**不**写 llm_call_log（评估自己消耗 token 不应污染被评估的 workflow 的 C-3）
 *     —— 实现：直接用 runLlmGateway，绕开自动落库的 invokeWithFallback。
 *     注：现有 invokeWithFallback 路径并不写库（写库是 reasoning 节点的责任），所以保持同函数也可。
 *   - 出错时抛错，让 collectContentJudge 走 fallback 路径
 */
import { runLlmGateway, type LlmGatewayInput } from "../../llm/gateway";
import { loadModelConfig, type RuntimeModelConfig } from "../../config/model-config";
import {
  inferProviderFromModelName,
  type LlmProvider,
} from "../../llm/llm-router";
import type { JudgeClient } from "./content-judge";

export interface CreateJudgeClientInput {
  /** 显式指定 model；不传走 .qubit/model.json default */
  model?: string;
  /** 显式指定 provider；不传从 model 名推断 */
  provider?: LlmProvider;
  /** 单次调用上限（毫秒），默认 30s */
  perCallTimeoutMs?: number;
}

export async function createJudgeClient(
  input: CreateJudgeClientInput = {}
): Promise<JudgeClient> {
  let config: RuntimeModelConfig | null = null;
  if (input.model) {
    config = {
      provider: input.provider ?? inferProviderFromModelName(input.model),
      model: input.model,
      apiKey: process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
    };
  } else {
    config = await loadModelConfig();
  }
  if (!config || !config.model) {
    throw new Error(
      "[judge-client] no LLM model configured—run `qubit init llm` or pass --judge-model"
    );
  }

  const timeoutMs = input.perCallTimeoutMs ?? 30_000;

  return {
    async judge(opts) {
      const gatewayInput: LlmGatewayInput = {
        config: { ...config, ...(input.provider ? { provider: input.provider } : {}) },
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        // 静默吞 token；judge 不需要流式
        onToken: () => {},
        sampling: { temperature: 0.0, maxOutputTokens: 800 },
      };
      const result = await Promise.race([
        runLlmGateway(gatewayInput),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`judge timeout after ${timeoutMs}ms`)),
            timeoutMs
          )
        ),
      ]);
      return result.answer;
    },
  };
}
