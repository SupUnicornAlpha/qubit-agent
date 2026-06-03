/**
 * P8 candidate-matcher 单测：
 *   1) parseGapSignature 拆 tool: / mcp: / concept:
 *   2) scoreCatalog：exact tool / slug / desc / capabilities 打分
 *   3) findCandidatesForGap：seed mcp_catalog + mcp_catalog_item，验 top-3 & 阈值过滤
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "../../../config";
import { closeDb, getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  mcpCatalog,
  mcpCatalogItem,
  mcpRegistrySource,
} from "../../../db/sqlite/schema";
import {
  _scoreCatalogForTest,
  findCandidatesForGap,
  parseGapSignature,
} from "../candidate-matcher";

let sourceId: string;

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p8-matcher-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
  const db = await getDb();
  sourceId = `src_${randomUUID()}`;
  await db
    .insert(mcpRegistrySource)
    .values({
      id: sourceId,
      name: "Test Registry",
      baseUrl: "https://example.test/registry",
    })
    .run();
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(mcpCatalog).run();
  await db.delete(mcpCatalogItem).run();
});

describe("parseGapSignature", () => {
  test("tool: namespace", () => {
    const p = parseGapSignature("tool:get_weather");
    expect(p.kind).toBe("tool");
    expect(p.tool).toBe("get_weather");
    expect(p.tokens).toContain("get");
    expect(p.tokens).toContain("weather");
  });

  test("mcp:<server>/<tool> namespace", () => {
    const p = parseGapSignature("mcp:slack/post_message");
    expect(p.kind).toBe("mcp");
    expect(p.server).toBe("slack");
    expect(p.tool).toBe("post_message");
    expect(p.tokens).toContain("slack");
    expect(p.tokens).toContain("post");
    expect(p.tokens).toContain("message");
  });

  test("mcp: 无 / 也能解析为只有 server", () => {
    const p = parseGapSignature("mcp:filesystem");
    expect(p.kind).toBe("mcp");
    expect(p.server).toBe("filesystem");
    expect(p.tool).toBeUndefined();
  });

  test("concept: namespace", () => {
    const p = parseGapSignature("concept:realtime_options_chain");
    expect(p.kind).toBe("concept");
    expect(p.keyword).toBe("realtime_options_chain");
    expect(p.tokens).toEqual(["realtime", "options", "chain"]);
  });

  test("unknown ns 兜底", () => {
    const p = parseGapSignature("???foobar");
    expect(p.kind).toBe("unknown");
  });

  test("short token (<3) 被过滤", () => {
    const p = parseGapSignature("concept:to do x");
    expect(p.tokens).not.toContain("to");
    expect(p.tokens).not.toContain("do");
    expect(p.tokens).not.toContain("x");
  });
});

describe("scoreCatalog (纯函数)", () => {
  test("exact defaultToolName 命中 0.7", () => {
    const s = _scoreCatalogForTest(
      {
        id: "c1",
        slug: "weather",
        name: "Weather",
        defaultToolName: "get_weather",
      },
      "tool:get_weather"
    );
    expect(s.score).toBeGreaterThanOrEqual(0.7);
    expect(s.hits.join(",")).toContain("exact_tool:get_weather");
  });

  test("server == slug 命中 0.4", () => {
    const s = _scoreCatalogForTest(
      { id: "c1", slug: "slack", name: "Slack" },
      "mcp:slack/post_message"
    );
    expect(s.score).toBeGreaterThanOrEqual(0.4);
    expect(s.hits.join(",")).toContain("exact_slug:slack");
  });

  test("description / capability token 命中累计 ≥ 0.3", () => {
    const s = _scoreCatalogForTest(
      {
        id: "c1",
        slug: "options-data",
        name: "Realtime Options Data",
        description: "Realtime options chain feed for US equity",
        capabilities: ["realtime", "options"],
      },
      "concept:realtime_options_chain"
    );
    expect(s.score).toBeGreaterThanOrEqual(0.3);
    expect(s.hits.some((h) => h.startsWith("desc_hits:"))).toBe(true);
  });

  test("毫无关系 → 0 分", () => {
    const s = _scoreCatalogForTest(
      { id: "c1", slug: "filesystem", name: "Filesystem", description: "fs ops" },
      "tool:send_email"
    );
    expect(s.score).toBe(0);
    expect(s.hits.length).toBe(0);
  });

  test("score cap 不超过 1.0", () => {
    const s = _scoreCatalogForTest(
      {
        id: "c1",
        slug: "slack",
        name: "Slack Chat",
        description: "slack post message channel chat",
        defaultToolName: "post_message",
        capabilities: ["slack", "post", "message"],
      },
      "mcp:slack/post_message"
    );
    expect(s.score).toBeLessThanOrEqual(1.0);
  });
});

describe("findCandidatesForGap (DB)", () => {
  test("混合 catalog + catalog_item，按 score 降序返回 top-3", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values([
        {
          id: "c_slack",
          slug: "slack",
          name: "Slack",
          description: "Slack chat integration",
          transport: "stdio",
          riskLevel: "medium",
          defaultToolName: "post_message",
          defaultCapabilitiesJson: ["slack", "chat"],
        },
        {
          id: "c_fs",
          slug: "filesystem",
          name: "Filesystem",
          description: "fs ops local",
          transport: "stdio",
          riskLevel: "high",
          defaultToolName: "read_file",
          defaultCapabilitiesJson: ["files"],
        },
      ])
      .run();
    await db
      .insert(mcpCatalogItem)
      .values([
        {
          id: "ci_slack_ext",
          sourceId,
          externalId: "ext_slack",
          slug: "slack-ext",
          name: "Slack External",
          description: "external slack mcp",
          transport: "stdio",
          riskLevel: "low",
          specJson: { defaultToolName: "post_message", defaultCapabilitiesJson: ["slack"] },
        },
      ])
      .run();

    const out = await findCandidatesForGap("mcp:slack/post_message", { topK: 3 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]!.score).toBeGreaterThanOrEqual(out[out.length - 1]!.score);
    expect(out[0]!.targetSlug).toBe("slack");
    expect(out[0]!.targetKind).toBe("mcp_catalog");
    expect(out.find((c) => c.targetKind === "mcp_catalog_item")).toBeDefined();
  });

  test("score < threshold 全过滤", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_unrelated",
        slug: "weather",
        name: "Weather",
        transport: "stdio",
        defaultToolName: "get_weather",
        defaultCapabilitiesJson: [],
      })
      .run();
    const out = await findCandidatesForGap("tool:send_email", { scoreThreshold: 0.3 });
    expect(out.length).toBe(0);
  });

  test("enabled=false 的 catalog 不参与", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_disabled",
        slug: "slack",
        name: "Slack",
        transport: "stdio",
        defaultToolName: "post_message",
        defaultCapabilitiesJson: [],
        enabled: false,
      })
      .run();
    const out = await findCandidatesForGap("mcp:slack/post_message");
    expect(out.length).toBe(0);
  });

  test("topK 截断", async () => {
    const db = await getDb();
    const seeds = Array.from({ length: 5 }).map((_, i) => ({
      id: `c_t${i}`,
      slug: `slack-${i}`,
      name: `Slack ${i}`,
      description: "slack chat integration",
      transport: "stdio" as const,
      defaultToolName: "post_message",
      defaultCapabilitiesJson: ["slack"],
    }));
    await db.insert(mcpCatalog).values(seeds).run();
    const out = await findCandidatesForGap("mcp:slack/post_message", { topK: 3 });
    expect(out.length).toBe(3);
  });
});
