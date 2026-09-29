import { describe, expect, test } from "bun:test";
import { createResearchMcpHandler } from "./mcp-adapter";

type RpcResult = { result: { isError?: boolean; tools: Array<{ name: string }> } };

describe("project-bound research MCP adapter", () => {
  test("advertises only research operations and does not offer raw market or executable tools", async () => {
    const handle = createResearchMcpHandler({ baseUrl: "http://localhost:3000", projectId: "p1" });
    const result = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as RpcResult;
    expect(result.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "research_protocol_get",
      "research_protocol_create",
      "research_factor_list",
      "research_factor_register",
      "research_factor_run",
      "research_attempt_cancel",
    ]);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
  test("arguments cannot change bound project, URL or supply hidden execution settings", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const handle = createResearchMcpHandler({
      baseUrl: "http://localhost:3000",
      projectId: "p1",
      fetch: (async (url: string, options: RequestInit) => {
        calls.push({ url, body: options.body ? JSON.parse(String(options.body)) : undefined });
        return Response.json({ ok: true, data: { id: "reserved" } });
      }) as typeof fetch,
    });
    const request = (args: unknown) =>
      handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "research_factor_run", arguments: args },
      }) as Promise<RpcResult>;
    expect(
      (
        await request({
          factorId: "f1",
          kind: "factor_compute",
          idempotencyKey: "k1",
          projectId: "p2",
        })
      ).result.isError
    ).toBe(true);
    expect(calls).toHaveLength(0);
    expect(
      (await request({ factorId: "f1", kind: "factor_compute", idempotencyKey: "k1" })).result
        .isError
    ).toBeUndefined();
    expect(calls[0]?.url).toBe("http://localhost:3000/api/v1/research-programs/p1/attempts");
  });
  test("registration supplies the fixed project and builtin expression provider", async () => {
    let posted: Record<string, unknown> = {};
    const handle = createResearchMcpHandler({
      baseUrl: "http://localhost:3000",
      projectId: "fixed",
      fetch: (async (_url: string, options: RequestInit) => {
        posted = JSON.parse(String(options.body));
        return Response.json({ ok: true, data: posted });
      }) as typeof fetch,
    });
    const result = (await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "research_factor_register",
        arguments: {
          name: "test",
          category: "momentum",
          expr: "close",
          universe: "US",
          horizon: 1,
        },
      },
    })) as RpcResult;
    expect(result.result.isError).toBeUndefined();
    expect(posted.projectId).toBe("fixed");
    expect(posted.providerKey).toBe("qlib_expr");
    expect(posted.dryRun).toBe(false);
  });
});
