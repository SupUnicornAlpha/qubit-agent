import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { connectorCallLog } from "../../../db/sqlite/schema";
import { getConnectorCallSummary, recordConnectorCall } from "../connector-call-log";

beforeAll(async () => {
  await runMigrations();
});

describe("connector-call-log", () => {
  test("records redacted call metadata and aggregates connector health", async () => {
    const connectorName = `test-connector-${crypto.randomUUID()}`;
    await recordConnectorCall({
      connectorName,
      operation: "healthcheck",
      request: { token: "secret", probeTimeoutMs: 5_000 },
      response: { status: "healthy", nested: { password: "secret" } },
      latencyMs: 12.4,
      status: "success",
    });
    await recordConnectorCall({
      connectorName,
      operation: "execute",
      request: { operation: "fetch", params: { symbol: "AAPL" } },
      latencyMs: 30,
      status: "timeout",
      errorMessage: "upstream timed out",
    });

    const db = await getDb();
    const rows = await db
      .select()
      .from(connectorCallLog)
      .where(eq(connectorCallLog.connectorName, connectorName));
    expect(rows).toHaveLength(2);
    const healthcheckRequest = rows.find((row) => row.operation === "healthcheck")?.requestJson;
    expect(healthcheckRequest).toEqual({
      type: "object",
      keys: ["token", "probeTimeoutMs"],
    });

    const summary = await getConnectorCallSummary({ windowMinutes: 60 });
    expect(summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorName,
          operation: "healthcheck",
          totalCalls: 1,
          successCount: 1,
          successRate: 1,
        }),
        expect.objectContaining({
          connectorName,
          operation: "execute",
          totalCalls: 1,
          timeoutCount: 1,
          successRate: 0,
        }),
      ])
    );
  });
});
