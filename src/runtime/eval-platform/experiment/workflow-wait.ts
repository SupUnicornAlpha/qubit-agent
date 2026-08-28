import { getDb, getSqliteForTesting } from "../../../db/sqlite/client";

const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

export async function waitForWorkflowTerminal(input: {
  workflowRunId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<{ status: string; timedOut: boolean }> {
  await getDb();
  const sqlite = getSqliteForTesting();
  const stmt = sqlite.prepare(`SELECT status FROM workflow_run WHERE id = ?`);
  const deadline = Date.now() + (input.timeoutMs ?? 5 * 60_000);
  const poll = input.pollIntervalMs ?? 2000;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const row = stmt.get(input.workflowRunId) as { status: string } | undefined;
    if (row) {
      lastStatus = row.status;
      if (TERMINAL.has(row.status)) {
        return { status: row.status, timedOut: false };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
  return { status: lastStatus, timedOut: true };
}
