import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/sqlite/migrate";
import { executionRouter } from "../execution.routes";

beforeAll(async () => {
  await runMigrations();
});

describe("POST /execution/intents", () => {
  test("forwards dispatchMode=live into the canonical evidence gate", async () => {
    const response = await executionRouter.request(
      new Request("http://test/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowRunId: "workflow-live-route",
          strategyVersionId: "strategy-live-route",
          instrumentId: "instrument-live-route",
          side: "buy",
          qty: 1,
          orderType: "market",
          timeInForce: "day",
          dispatchMode: "live",
        }),
      })
    );
    const body = (await response.json()) as { ok?: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("thesis_required");
  });
});
