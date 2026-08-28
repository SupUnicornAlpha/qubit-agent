import { createHash } from "node:crypto";

/** 对同一 workflowRunId 采样结果稳定（便于复现与测试）。 */
export function shouldSampleWorkflow(workflowRunId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const hash = createHash("sha256").update(workflowRunId).digest();
  const bucket = hash.readUInt32BE(0) / 0xffff_ffff;
  return bucket < sampleRate;
}

export function resolveSampleRate(configured: number): number {
  const env = process.env.QUBIT_EVAL_JUDGE_SAMPLE_RATE?.trim();
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return configured;
}
