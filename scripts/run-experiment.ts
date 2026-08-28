#!/usr/bin/env bun
/**
 * 通用 Experiment Runner：对 eval_dataset 的 items 跑一轮实验并写入 eval_run。
 *
 * Env:
 *   QUBIT_EXPERIMENT_DATASET_ID   必填
 *   QUBIT_EXPERIMENT_LABEL        默认 timestamp
 *   QUBIT_EXPERIMENT_FINGERPRINT  默认 label
 *   QUBIT_EXPERIMENT_MODE         replay | launch（默认 replay）
 *   QUBIT_EXPERIMENT_BASELINE_RUN 可选 baseline run id（仅记录）
 *   QUBIT_EXPERIMENT_PROJECT_ID   launch 模式必填
 *   QUBIT_EXPERIMENT_WAIT_MS      默认 600000
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runExperiment } from "../src/runtime/eval-platform/experiment/experiment-runner";
import { DEFAULT_USER_PROJECT_ID } from "../src/runtime/bootstrap/ensure-default-workspace";

const datasetId = process.env.QUBIT_EXPERIMENT_DATASET_ID?.trim();
if (!datasetId) {
  console.error("QUBIT_EXPERIMENT_DATASET_ID is required");
  process.exit(1);
}

const label = process.env.QUBIT_EXPERIMENT_LABEL ?? new Date().toISOString().replace(/[:.]/g, "-");
const fingerprint = process.env.QUBIT_EXPERIMENT_FINGERPRINT ?? label;
const mode = (process.env.QUBIT_EXPERIMENT_MODE ?? "replay") as "replay" | "launch";
const projectId = process.env.QUBIT_EXPERIMENT_PROJECT_ID ?? DEFAULT_USER_PROJECT_ID;
const baselineRunId = process.env.QUBIT_EXPERIMENT_BASELINE_RUN?.trim();
const waitTimeoutMs = Number(process.env.QUBIT_EXPERIMENT_WAIT_MS ?? 600_000);
const outDir = resolve(process.env.QUBIT_EXPERIMENT_OUT ?? join("out", "experiments", label));

const result = await runExperiment({
  datasetId,
  experimentLabel: label,
  configFingerprint: fingerprint,
  projectId,
  mode,
  waitTimeoutMs,
  ...(baselineRunId ? { baselineRunId } : {}),
});

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({ ok: true, runId: result.runId, summary: result.summary, outDir }, null, 2));
