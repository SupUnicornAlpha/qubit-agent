/**
 * external.http_memory / external.http_decision 适配样例测试（mock fetch）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsWorkspace } from "../../service";
import { resolveProviders, listRegisteredProviderKinds } from "../resolve";
import { createExternalHttpMemoryProvider } from "../external-http-memory";
import { createExternalHttpDecisionProvider } from "../external-decision-stub";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("external HTTP providers", () => {
  test("registry exposes http memory + http decision kinds", () => {
    const kinds = listRegisteredProviderKinds();
    expect(kinds.memory).toContain("external.http_memory");
    expect(kinds.decision).toContain("external.http_decision");
    expect(kinds.decision).toContain("external.decision_stub");
  });

  test("http memory fails closed without baseUrl", () => {
    const provider = createExternalHttpMemoryProvider({
      kind: "external.http_memory",
      config: {},
    });
    expect(provider.list({} as never)).rejects.toThrow(/baseUrl/);
  });

  test("http memory list/upsert/search against mock API", async () => {
    const store = new Map<string, Record<string, unknown>>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url);
      const path = u.pathname;
      if (path.endsWith("/entries") && method === "GET") {
        return new Response(JSON.stringify([...store.values()]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const put = path.match(/\/entries\/([^/]+)$/);
      if (put && method === "PUT") {
        const id = decodeURIComponent(put[1]!);
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const row = { ...body, id };
        store.set(id, row);
        return new Response(JSON.stringify(row), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.endsWith("/search") && method === "GET") {
        const q = u.searchParams.get("q")?.toLowerCase() ?? "";
        const hits = [...store.values()].filter((e) =>
          String(e.title ?? "")
            .toLowerCase()
            .includes(q)
        );
        return new Response(JSON.stringify(hits.map((e) => ({ ...e, score: 1 }))), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.endsWith("/bootstrap")) {
        return new Response(JSON.stringify({ text: "# remote memory\n" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const dataDir = await mkdtemp(join(tmpdir(), "qb-http-mem-"));
    const created = await createFsWorkspace({ name: "http-mem", dataDir });
    const provider = createExternalHttpMemoryProvider({
      kind: "external.http_memory",
      config: { baseUrl: "http://memory.test" },
    });

    const saved = await provider.upsert(created.fs, {
      title: "alpha thesis",
      body: "long NVDA",
      source: "user",
    });
    expect(saved.id).toBeTruthy();
    const listed = await provider.list(created.fs, { limit: 10 });
    expect(listed.some((e) => e.title === "alpha thesis")).toBe(true);
    const hits = await provider.search(created.fs, "alpha");
    expect(hits[0]?.title).toBe("alpha thesis");
    const boot = await provider.loadBootstrap(created.fs);
    expect(boot).toContain("remote memory");
  });

  test("resolveProviders wires http decision and sync mirrors files", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/strategies")) {
        return new Response(
          JSON.stringify({ items: [{ id: "s1", name: "mom", relPath: "mom.py" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/factors")) {
        return new Response(JSON.stringify([{ id: "f1", name: "rsi" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/sync") && method === "POST") {
        return new Response(
          JSON.stringify({
            factorCount: 1,
            strategyCount: 1,
            strategies: [
              {
                id: "s1",
                name: "mom",
                relPath: "mom.py",
                content: "def on_bar():\n  return 1\n",
              },
            ],
            factors: [
              {
                id: "f1",
                name: "rsi",
                relPath: "rsi.json",
                content: '{"name":"rsi"}\n',
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const dataDir = await mkdtemp(join(tmpdir(), "qb-http-dec-"));
    const created = await createFsWorkspace({ name: "http-dec", dataDir });
    const providers = resolveProviders({
      ...created.manifest,
      providers: {
        memory: { kind: "builtin.fs_memory" },
        decision: {
          kind: "external.http_decision",
          config: { baseUrl: "http://decision.test" },
        },
      },
    });

    expect(providers.decision.kind).toBe("external.http_decision");
    const strategies = await providers.decision.listStrategies(created.fs);
    expect(strategies[0]?.id).toBe("s1");
    const synced = await providers.decision.syncIntoWorkspace?.(created.fs, {
      projectId: "proj-1",
    });
    expect(synced?.strategyCount).toBe(1);
    expect(await created.fs.exists("decision/strategies/mom.py")).toBe(true);
    expect(await created.fs.exists("research/factors/rsi.json")).toBe(true);
  });

  test("createExternalHttpDecisionProvider is used for decision_stub alias", () => {
    const p = createExternalHttpDecisionProvider({
      kind: "external.decision_stub",
      config: { baseUrl: "http://x" },
    });
    expect(p.kind).toBe("external.decision_stub");
  });
});
