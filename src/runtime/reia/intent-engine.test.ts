import { describe, expect, test } from "bun:test";
import { executeIntentLive } from "./intent-engine";

describe("legacy REIA intent engine", () => {
  test("fails closed instead of submitting a legacy intent_order to a live broker", async () => {
    await expect(
      executeIntentLive({
        intentOrderId: "legacy-intent",
        provider: "futu",
      })
    ).rejects.toThrow("legacy_live_execution_retired");
  });
});
