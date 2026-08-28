import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EvaluatorConfig, LlmJudgeEvaluatorConfig } from "./types";

const CONFIG_DIR = resolve(process.env.QUBIT_EVALUATOR_CONFIG_DIR ?? join(process.cwd(), "config/evaluators"));

function parseConfig(raw: unknown): EvaluatorConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "llm_judge" || typeof obj.id !== "string") return null;
  return {
    id: obj.id,
    type: "llm_judge",
    enabled: obj.enabled !== false,
    sampleRate: typeof obj.sampleRate === "number" ? obj.sampleRate : 0.05,
    outputScoreName: typeof obj.outputScoreName === "string" ? obj.outputScoreName : "aqm.A-3",
    ...(typeof obj.maxArtifacts === "number" ? { maxArtifacts: obj.maxArtifacts } : {}),
    rubric: obj.rubric === "content-judge" ? "content-judge" : "content-judge",
  };
}

let cached: EvaluatorConfig[] | null = null;

export function loadEvaluatorConfigs(options?: { reload?: boolean }): EvaluatorConfig[] {
  if (cached && !options?.reload) return cached;
  const configs: EvaluatorConfig[] = [];
  try {
    const files = readdirSync(CONFIG_DIR).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      const parsed = parseConfig(JSON.parse(readFileSync(join(CONFIG_DIR, file), "utf8")));
      if (parsed) configs.push(parsed);
    }
  } catch {
    // config dir 缺失时返回内置默认
    configs.push({
      id: "a3-content-judge",
      type: "llm_judge",
      enabled: true,
      sampleRate: 0.05,
      outputScoreName: "aqm.A-3",
      maxArtifacts: 5,
      rubric: "content-judge",
    });
  }
  cached = configs;
  return configs;
}

export function listEnabledLlmJudgeEvaluators(): LlmJudgeEvaluatorConfig[] {
  return loadEvaluatorConfigs().filter(
    (item): item is LlmJudgeEvaluatorConfig => item.type === "llm_judge" && item.enabled
  );
}

/** 单测 / 注入用。 */
export function setEvaluatorConfigsForTesting(configs: EvaluatorConfig[] | null): void {
  cached = configs;
}
