/**
 * llm-provider-persistence.test.ts — 2026-06-05 修复"重启后缺 apiKey"
 *
 * 背景：在 M10.B-P0 阶段，apiKey 只写到 `process.env[envKey]`，DB 仅存 envKey 名字
 *       (`apiKeyRef`)。进程重启后 process.env 清空，前端列表里所有 provider 都显示
 *       "缺 apiKey" —— user 反馈"上次配的 4 个 provider 全消失了"。
 *
 * 修复：migration 0079 增加 `api_key_secret` 列，明文 apiKey 直接落库；启动时
 *       `hydrateLlmProviderEnv()` 把 secret 还原到 process.env[apiKeyRef]。
 *
 * 本测试覆盖：
 *   1. POST 创建 provider 后，即使 process.env 被外部清空，loadProviderFromDb 仍能拿到 apiKey
 *   2. hydrateLlmProviderEnv 把 secret 还原到 process.env，且不覆盖 user 通过 env 注入的同名变量
 *   3. GET 列表中 apiKeyConfigured 在 process.env 为空时仍正确为 true
 *   4. 旧 envKey 当 apiKey 的 bug 修复：env 不存在时 apiKey 应为空，而不是 envKey 名字本身
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import { llmProviderConfig } from "../../../db/sqlite/schema";
import { hydrateLlmProviderEnv, loadProviderFromDb } from "../llm-router";
import { llmProviderRouter } from "../../../routes/llm-provider.routes";
import { Hono } from "hono";

/** 测试用的随机 providerId 前缀，避免与其他测试 / 真实数据冲突 */
const TEST_PREFIX = "test-persist-";

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  // 清理前几次跑剩下的测试 provider；用 LIKE 比 .startsWith 更准确（drizzle 没有 startsWith）
  const db = await getDb();
  const rows = await db.select().from(llmProviderConfig);
  for (const r of rows) {
    if (r.providerId.startsWith(TEST_PREFIX)) {
      await db.delete(llmProviderConfig).where(eq(llmProviderConfig.id, r.id));
    }
  }
  // 清掉测试期间可能残留的 env，确保"重启场景"干净
  delete process.env["OPENAI_API_KEY"];
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["ANTHROPIC_API_KEY"];
});

describe("LlmProvider 持久化 — 修复重启后缺 apiKey", () => {
  test("POST 写入后即使清空 process.env，loadProviderFromDb 仍能拿到 apiKey", async () => {
    const app = new Hono();
    app.route("/api/v1/llm-providers", llmProviderRouter);
    const providerId = `${TEST_PREFIX}openai-${Date.now()}`;
    const res = await app.request("/api/v1/llm-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId,
        providerType: "openai",
        modelName: "gpt-4o-mini",
        apiKey: "sk-test-secret-12345",
      }),
    });
    expect(res.status).toBe(200);

    // 模拟"进程重启"：清空 process.env 中的 envKey
    delete process.env["OPENAI_API_KEY"];

    const cfg = await loadProviderFromDb(providerId);
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("sk-test-secret-12345");
    expect(cfg!.provider).toBe("openai");
    expect(cfg!.model).toBe("gpt-4o-mini");
  });

  test("GET 列表中 apiKeyConfigured 在 process.env 被清空时仍为 true", async () => {
    const app = new Hono();
    app.route("/api/v1/llm-providers", llmProviderRouter);
    const providerId = `${TEST_PREFIX}deepseek-${Date.now()}`;
    await app.request("/api/v1/llm-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId,
        providerType: "custom",
        modelName: "deepseek-chat",
        apiKey: "sk-deepseek-xyz",
      }),
    });

    // 模拟重启
    delete process.env["DEEPSEEK_API_KEY"];

    const listRes = await app.request("/api/v1/llm-providers");
    const list = (await listRes.json()) as {
      ok: boolean;
      data: Array<{ providerId: string; apiKeyConfigured: boolean }>;
    };
    const ours = list.data.find((r) => r.providerId === providerId);
    expect(ours).toBeDefined();
    expect(ours!.apiKeyConfigured).toBe(true);
  });

  test("hydrateLlmProviderEnv 把 secret 还原到 process.env", async () => {
    const db = await getDb();
    const providerId = `${TEST_PREFIX}anthropic-${Date.now()}`;
    await db.insert(llmProviderConfig).values({
      id: providerId,
      providerId,
      providerType: "anthropic",
      modelName: "claude-sonnet-4",
      apiKeyRef: "ANTHROPIC_API_KEY",
      apiKeySecret: "sk-ant-from-db",
      contextWindow: 128_000,
      supportsFunctionCalling: true,
      enabled: true,
    });

    // 模拟重启：env 为空
    delete process.env["ANTHROPIC_API_KEY"];
    expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();

    const r = await hydrateLlmProviderEnv();
    expect(r.hydrated).toBeGreaterThanOrEqual(1);
    expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-from-db");
  });

  test("hydrateLlmProviderEnv 不覆盖 OS-level 已注入的同名 env", async () => {
    const db = await getDb();
    const providerId = `${TEST_PREFIX}env-override-${Date.now()}`;
    await db.insert(llmProviderConfig).values({
      id: providerId,
      providerId,
      providerType: "openai",
      modelName: "gpt-4o-mini",
      apiKeyRef: "OPENAI_API_KEY",
      apiKeySecret: "sk-from-db-old",
      contextWindow: 128_000,
      supportsFunctionCalling: true,
      enabled: true,
    });

    // 模拟 user 通过 shell export 注入新 key —— DB 里的旧 secret 不应覆盖它
    process.env["OPENAI_API_KEY"] = "sk-from-shell-new";

    const r = await hydrateLlmProviderEnv();
    expect(r.skippedExistingEnv).toBeGreaterThanOrEqual(1);
    expect(process.env["OPENAI_API_KEY"]).toBe("sk-from-shell-new");
  });

  test("loadProviderFromDb 在 env 缺失且无 secret 时返回空 apiKey（不再返回 envKey 名字）", async () => {
    /**
     * 复现旧 bug：之前 `process.env[apiKeyRef] ?? apiKeyRef` 会把 envKey 字符串本身
     * 当 apiKey 返回，导致下游用 "OPENAI_API_KEY" 这个字面量去鉴权 OpenAI，错得离谱
     * 但错误信息看起来像"key 不对"，极其误导。
     */
    const db = await getDb();
    const providerId = `${TEST_PREFIX}env-only-${Date.now()}`;
    await db.insert(llmProviderConfig).values({
      id: providerId,
      providerId,
      providerType: "openai",
      modelName: "gpt-4o-mini",
      apiKeyRef: "OPENAI_API_KEY",
      apiKeySecret: null,
      contextWindow: 128_000,
      supportsFunctionCalling: true,
      enabled: true,
    });
    delete process.env["OPENAI_API_KEY"];

    const cfg = await loadProviderFromDb(providerId);
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("");
    expect(cfg!.apiKey).not.toBe("OPENAI_API_KEY"); // 显式断言不是 envKey 名字
  });

  test("PATCH 留空 apiKey 字段时不影响已配置的 secret（避免误清空）", async () => {
    const app = new Hono();
    app.route("/api/v1/llm-providers", llmProviderRouter);
    const providerId = `${TEST_PREFIX}patch-noop-${Date.now()}`;
    const createRes = await app.request("/api/v1/llm-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId,
        providerType: "openai",
        modelName: "gpt-4o-mini",
        apiKey: "sk-original-secret",
      }),
    });
    const createData = (await createRes.json()) as { data: { id: string } };
    const id = createData.data.id;

    // PATCH 只改 modelName，不传 apiKey
    const patchRes = await app.request(`/api/v1/llm-providers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelName: "gpt-4o" }),
    });
    expect(patchRes.status).toBe(200);

    delete process.env["OPENAI_API_KEY"];

    const cfg = await loadProviderFromDb(providerId);
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("sk-original-secret");
    expect(cfg!.model).toBe("gpt-4o");
  });

  test("PATCH 传 apiKey 新值会覆盖旧 secret", async () => {
    const app = new Hono();
    app.route("/api/v1/llm-providers", llmProviderRouter);
    const providerId = `${TEST_PREFIX}patch-update-${Date.now()}`;
    const createRes = await app.request("/api/v1/llm-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId,
        providerType: "openai",
        modelName: "gpt-4o-mini",
        apiKey: "sk-v1",
      }),
    });
    const id = ((await createRes.json()) as { data: { id: string } }).data.id;

    await app.request(`/api/v1/llm-providers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-v2-new" }),
    });

    delete process.env["OPENAI_API_KEY"];

    const cfg = await loadProviderFromDb(providerId);
    expect(cfg!.apiKey).toBe("sk-v2-new");
  });
});
