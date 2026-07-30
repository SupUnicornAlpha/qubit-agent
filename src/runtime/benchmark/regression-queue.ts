import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunScorecard } from "./contracts";

export interface RegressionQueueItem {
  workflowRunId: string;
  assertionId: string;
  detail: string;
  createdAt: string;
}

/**
 * P0 采用 JSONL 作为可审计的 pending queue。只保存 run id 和失败码，不保存用户 goal
 * 或工具 payload；同一 run + 断言幂等，人工审核后才会录成 fixture。
 */
export async function enqueueHardFailures(
  scorecard: RunScorecard,
  queuePath = join("out", "qubit-bench", "regression-case-queue.jsonl")
): Promise<RegressionQueueItem[]> {
  if (scorecard.suite !== "production") return [];
  const candidates = scorecard.layers.hard.assertions
    .filter((item) => item.status === "fail")
    .map((item) => ({
      workflowRunId: scorecard.workflowRunId,
      assertionId: item.id,
      detail: item.detail,
      createdAt: new Date().toISOString(),
    }));
  if (candidates.length === 0) return [];

  await mkdir(dirname(queuePath), { recursive: true });
  const existing = await readExisting(queuePath);
  const additions = candidates.filter(
    (candidate) =>
      !existing.some(
        (item) =>
          item.workflowRunId === candidate.workflowRunId &&
          item.assertionId === candidate.assertionId
      )
  );
  if (additions.length) {
    await writeFile(
      queuePath,
      `${[...existing, ...additions].map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8"
    );
  }
  return additions;
}

async function readExisting(queuePath: string): Promise<RegressionQueueItem[]> {
  try {
    const source = await readFile(queuePath, "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const item = JSON.parse(line) as RegressionQueueItem;
          return item.workflowRunId && item.assertionId ? [item] : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
