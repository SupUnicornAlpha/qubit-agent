#!/usr/bin/env bun
/**
 * 将 qubit-bench cases 导入 eval_dataset_item（benchmark 外置化第一步）。
 *
 * Usage:
 *   bun run scripts/import-benchmark-cases.ts --dataset-id=<uuid> [--dataset-name=agent_benchmark]
 */

import { randomUUID } from "node:crypto";
import { QUBIT_BENCH_CASES } from "../src/runtime/benchmark/qubit-bench-cases";
import { createEvalDataset } from "../src/runtime/eval/pipeline";
import { createDatasetItem, listDatasetItems } from "../src/runtime/eval-platform/dataset/dataset-item-service";

const args = process.argv.slice(2);
const datasetIdArg = args.find((a) => a.startsWith("--dataset-id="))?.split("=")[1]?.trim();
const datasetName = args.find((a) => a.startsWith("--dataset-name="))?.split("=")[1]?.trim() ?? "agent_benchmark";

let datasetId = datasetIdArg;
if (!datasetId) {
  const created = await createEvalDataset({
    name: datasetName,
    version: "v1",
    scenario: "agent_benchmark",
    sourceDesc: "imported from qubit-bench-cases.ts",
    metaJson: { importedAt: new Date().toISOString() },
  });
  datasetId = created?.id;
}
if (!datasetId) throw new Error("failed to resolve dataset id");

const existing = new Set((await listDatasetItems(datasetId)).map((item) => item.caseKey));
let imported = 0;
for (const benchCase of QUBIT_BENCH_CASES) {
  if (existing.has(benchCase.id)) continue;
  await createDatasetItem({
    datasetId,
    caseKey: benchCase.id,
    inputJson: {
      scenarioKey: benchCase.scenarioKey,
      goal: benchCase.goal,
      inputParams: benchCase.inputParams,
      budget: benchCase.budget,
      dimensions: benchCase.dimensions,
    },
    expectedJson: {
      minRelevance: benchCase.minRelevance,
      expectations: benchCase.expectations ?? {},
    },
    metadataJson: {
      title: benchCase.title,
      businessTags: benchCase.businessTags ?? [],
      source: "qubit-bench-cases.ts",
    },
  });
  imported += 1;
}

console.log(JSON.stringify({ ok: true, datasetId, imported, total: QUBIT_BENCH_CASES.length }, null, 2));
