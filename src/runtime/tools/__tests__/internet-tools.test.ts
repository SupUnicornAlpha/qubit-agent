import { describe, expect, test } from "bun:test";
import { isInternetBuiltinTool, INTERNET_BUILTIN_TOOLS } from "../internet-tools";
import { parseDuckDuckGoHtml, resolveWebSearchProvider, runWebSearch } from "../web-search-handler";
import {
  extractHtmlTitle,
  isBlockedHostname,
  parsePublicHttpUrl,
  stripHtmlToText,
} from "../web-ssrf";
import { WEB_FETCH_HANDLER } from "../web-fetch-handler";
import { isBuiltinTool } from "../builtin-tools";
import { buildToolCatalog } from "../tool-catalog";
import { isToolAuthorized, type LoadedSandboxPolicy } from "../../sandbox-executor";

const emptyPolicy = (): LoadedSandboxPolicy => ({
  id: "pol-empty",
  allowedTools: new Set(),
  allowedMcpServers: new Set(),
  allowedConnectors: new Set(),
  allowedHosts: new Set(),
  allowedFsPaths: [],
  maxToolCallMs: 30_000,
  maxIterationsPerRun: 64,
});

const ctx = {
  workflowId: "wf-web",
  runId: "run-web",
  traceId: "trace-web",
  agentInstanceId: "inst-web",
  definition: {
    id: "def-web",
    role: "research" as const,
    name: "research",
    version: "1",
    systemPrompt: "",
    tools: [],
    mcpServers: [],
    skills: [],
    subscriptions: [],
    llmProvider: "mock",
    maxIterations: 5,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
};

describe("internet builtin registration", () => {
  test("web.search and web.fetch are registered", () => {
    expect(INTERNET_BUILTIN_TOOLS).toContain("web.fetch");
    expect(INTERNET_BUILTIN_TOOLS).toContain("web.search");
    expect(isInternetBuiltinTool("web.fetch")).toBe(true);
    expect(isInternetBuiltinTool("web.search")).toBe(true);
    expect(isBuiltinTool("web.search")).toBe(true);
    expect(isBuiltinTool("web.fetch")).toBe(true);
    const catalog = buildToolCatalog();
    expect(catalog.some((e) => e.name === "web.search" && e.kind === "builtin")).toBe(true);
    expect(catalog.find((e) => e.name === "web.search")?.category).toBe("research");
  });

  test("sandbox authorizes internet tools even when allow-list is empty", () => {
    const policy = emptyPolicy();
    expect(isToolAuthorized(policy, "web.fetch")).toBe(true);
    expect(isToolAuthorized(policy, "web.search")).toBe(true);
    expect(isToolAuthorized(policy, "assign_task")).toBe(false);
  });
});

describe("web-ssrf", () => {
  test("blocks private and metadata hosts", () => {
    expect(isBlockedHostname("127.0.0.1")).toBe(true);
    expect(isBlockedHostname("10.0.0.1")).toBe(true);
    expect(isBlockedHostname("192.168.1.1")).toBe(true);
    expect(isBlockedHostname("169.254.169.254")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
  });

  test("parsePublicHttpUrl rejects bad schemes and hosts", () => {
    expect(parsePublicHttpUrl("").ok).toBe(false);
    expect(parsePublicHttpUrl("file:///etc/passwd").ok).toBe(false);
    expect(parsePublicHttpUrl("http://127.0.0.1/").ok).toBe(false);
    const ok = parsePublicHttpUrl("https://example.com/a");
    expect(ok.ok).toBe(true);
  });

  test("extractHtmlTitle and stripHtmlToText", () => {
    expect(extractHtmlTitle("<html><title> Hello &amp; World </title></html>")).toBe(
      "Hello & World"
    );
    expect(stripHtmlToText("<p>a<script>x</script>b</p>")).toBe("a b");
  });
});

describe("web.search", () => {
  test("requires query", async () => {
    const r = await runWebSearch({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/query/i);
  });

  test("resolveWebSearchProvider defaults and validates", () => {
    expect(resolveWebSearchProvider({})).toBe("duckduckgo");
    expect(resolveWebSearchProvider({ WEB_SEARCH_PROVIDER: "brave" })).toBe("brave");
    expect(resolveWebSearchProvider({ WEB_SEARCH_PROVIDER: "SERPER" })).toBe("serper");
    expect(resolveWebSearchProvider({ WEB_SEARCH_PROVIDER: "nope" })).toBe("duckduckgo");
  });

  test("brave requires API key", async () => {
    const r = await runWebSearch({ query: "AAPL" }, { env: { WEB_SEARCH_PROVIDER: "brave" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/BRAVE_SEARCH_API_KEY/);
  });

  test("brave parses JSON results via injectable fetch", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Apple", url: "https://apple.com", description: "company" },
              { title: "AAPL", url: "https://finance.example/aapl", description: "quote" },
            ],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const r = await runWebSearch(
      { query: "AAPL", count: 1 },
      { env: { WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "k" }, fetchImpl }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("brave");
      expect(r.results).toHaveLength(1);
      expect(r.results[0]?.url).toBe("https://apple.com");
      expect(r.source).toBe("web");
    }
  });

  test("serper parses organic results", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          organic: [{ title: "T", link: "https://t.example", snippet: "s" }],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const r = await runWebSearch(
      { query: "test" },
      { env: { WEB_SEARCH_PROVIDER: "serper", SERPER_API_KEY: "k" }, fetchImpl }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.provider).toBe("serper");
      expect(r.results[0]?.url).toBe("https://t.example");
    }
  });

  test("parseDuckDuckGoHtml extracts result blocks", () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example Title</a>
        <a class="result__snippet">A short snippet about example.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://other.example/x">Other</a>
        <td class="result__snippet">More text</td>
      </div>
    `;
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results.length).toBe(2);
    expect(results[0]?.url).toBe("https://example.com/page");
    expect(results[0]?.title).toBe("Example Title");
    expect(results[1]?.url).toBe("https://other.example/x");
  });

  test("duckduckgo falls back to the lite markup endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response("<html>changed classic markup</html>");
      return new Response(`
        <table><tr><td>
          <a class="result-link" href="https://example.com/fallback">Fallback Result</a>
          <td class="result-snippet">Fallback snippet</td>
        </td></tr></table>
      `);
    }) as typeof fetch;
    const result = await runWebSearch(
      { query: "fallback query" },
      { env: { WEB_SEARCH_PROVIDER: "duckduckgo" }, fetchImpl }
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("lite.duckduckgo.com/lite/");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results[0]?.url).toBe("https://example.com/fallback");
  });
});

describe("web.fetch", () => {
  test("rejects private hosts", async () => {
    const r = (await WEB_FETCH_HANDLER(ctx, { url: "http://127.0.0.1/" })) as {
      ok: boolean;
      error?: string;
      source?: string;
    };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/blocked host/);
    expect(r.source).toBe("web");
  });

  test("returns title and source for HTML", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html><title>Doc Title</title><body><p>Hello world</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch;
    try {
      const r = (await WEB_FETCH_HANDLER(ctx, { url: "https://example.com/doc" })) as {
        ok: boolean;
        title?: string;
        text?: string;
        source?: string;
        finalUrl?: string;
      };
      expect(r.ok).toBe(true);
      expect(r.title).toBe("Doc Title");
      expect(r.text).toContain("Hello world");
      expect(r.source).toBe("web");
      expect(r.finalUrl).toBeTruthy();
    } finally {
      globalThis.fetch = original;
    }
  });
});
