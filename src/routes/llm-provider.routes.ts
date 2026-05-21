/**
 * /api/v1/llm-providers — LLM Provider 配置 CRUD (M10.B2)
 *
 * 配合 src/runtime/llm/llm-router.ts 工作：
 *   - GET 列表 / 单条
 *   - POST 新建
 *   - PATCH 修改（含 apiKey 重设）
 *   - DELETE 删除
 *   - POST :id/test 简单连通性测试（最小可用版：dry-run，不真实调 LLM）
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { llmProviderConfig } from "../db/sqlite/schema";
import { randomUUID } from "node:crypto";
import {
  inferProviderFromModelName,
  parseAgentLlmProviderString,
  providerEnvKey,
  resolveLlmForAgent,
} from "../runtime/llm/llm-router";

export const llmProviderRouter = new Hono();

type ProviderType = "openai" | "anthropic" | "ollama" | "custom";

interface CreatePayload {
  providerId: string;
  providerType?: ProviderType;
  modelName: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  apiKeyRef?: string | null;
  contextWindow?: number;
  supportsFunctionCalling?: boolean;
  enabled?: boolean;
}

interface UpdatePayload {
  providerType?: ProviderType;
  modelName?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  apiKeyRef?: string | null;
  contextWindow?: number;
  supportsFunctionCalling?: boolean;
  enabled?: boolean;
}

/** 把前端传的 apiKey 明文转成 env 变量名引用 — B1 最小版：直接存为 ref，B-P1 改成 keychain */
function normalizeApiKeyRef(input: {
  apiKey?: string | null;
  apiKeyRef?: string | null;
  providerType?: ProviderType;
  modelName?: string;
}): string | null {
  // 优先 apiKeyRef（如用户已经用 env 引用方式配）
  if (input.apiKeyRef && input.apiKeyRef.trim()) {
    return input.apiKeyRef.trim();
  }
  // 明文 apiKey → 注入到 process.env 并存 env 变量名
  // (B-P0 阶段最小可用版：内存级保护，重启后失效。B-P1 改 keychain。)
  if (input.apiKey && input.apiKey.trim()) {
    const provider =
      input.providerType === "custom" && input.modelName
        ? inferProviderFromModelName(input.modelName)
        : input.providerType;
    const envKey = provider ? providerEnvKey(provider as "openai") : null;
    // 为每个 provider 单独命名 env key（避免冲突），存进 process.env
    const finalEnvKey = envKey ?? `QUBIT_LLM_${(input.providerType ?? "custom").toUpperCase()}_KEY`;
    process.env[finalEnvKey] = input.apiKey.trim();
    return finalEnvKey;
  }
  return null;
}

/** GET /api/v1/llm-providers — 列出所有 provider（apiKey 不返回明文，只返回是否已配置） */
llmProviderRouter.get("/", async (c) => {
  const db = await getDb();
  const rows = await db.select().from(llmProviderConfig);
  return c.json({
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      providerId: r.providerId,
      providerType: r.providerType,
      modelName: r.modelName,
      baseUrl: r.baseUrl,
      apiKeyRef: r.apiKeyRef,
      apiKeyConfigured: Boolean(r.apiKeyRef && (process.env[r.apiKeyRef] ?? "").length > 0),
      contextWindow: r.contextWindow,
      supportsFunctionCalling: r.supportsFunctionCalling,
      enabled: r.enabled,
      createdAt: r.createdAt,
    })),
  });
});

/** GET /api/v1/llm-providers/:id */
llmProviderRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const rows = await db.select().from(llmProviderConfig).where(eq(llmProviderConfig.id, id)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ ok: false, error: "not_found" }, 404);
  return c.json({
    ok: true,
    data: {
      ...row,
      apiKeyConfigured: Boolean(row.apiKeyRef && (process.env[row.apiKeyRef] ?? "").length > 0),
    },
  });
});

/** POST /api/v1/llm-providers — 新建 */
llmProviderRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<CreatePayload>();
    if (!body.providerId?.trim()) return c.json({ ok: false, error: "providerId is required" }, 400);
    if (!body.modelName?.trim()) return c.json({ ok: false, error: "modelName is required" }, 400);
    const db = await getDb();
    const existing = await db
      .select({ id: llmProviderConfig.id })
      .from(llmProviderConfig)
      .where(eq(llmProviderConfig.providerId, body.providerId.trim()))
      .limit(1);
    if (existing[0]) {
      return c.json({ ok: false, error: "providerId_already_exists" }, 409);
    }
    const apiKeyRef = normalizeApiKeyRef(body);
    const id = randomUUID();
    await db.insert(llmProviderConfig).values({
      id,
      providerId: body.providerId.trim(),
      providerType: body.providerType ?? "custom",
      modelName: body.modelName.trim(),
      baseUrl: body.baseUrl ?? null,
      apiKeyRef,
      contextWindow: body.contextWindow ?? 128_000,
      supportsFunctionCalling: body.supportsFunctionCalling ?? true,
      enabled: body.enabled ?? true,
    });
    return c.json({ ok: true, data: { id } });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/** PATCH /api/v1/llm-providers/:id */
llmProviderRouter.patch("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json<UpdatePayload>();
    const db = await getDb();
    const existing = await db
      .select()
      .from(llmProviderConfig)
      .where(eq(llmProviderConfig.id, id))
      .limit(1);
    if (!existing[0]) return c.json({ ok: false, error: "not_found" }, 404);

    const next: Partial<typeof llmProviderConfig.$inferInsert> = {};
    if (body.providerType !== undefined) next.providerType = body.providerType;
    if (body.modelName !== undefined) next.modelName = body.modelName.trim();
    if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl;
    if (body.contextWindow !== undefined) next.contextWindow = body.contextWindow;
    if (body.supportsFunctionCalling !== undefined) next.supportsFunctionCalling = body.supportsFunctionCalling;
    if (body.enabled !== undefined) next.enabled = body.enabled;

    // apiKey / apiKeyRef 变化时重写
    if (body.apiKey !== undefined || body.apiKeyRef !== undefined) {
      const newRef = normalizeApiKeyRef({
        apiKey: body.apiKey,
        apiKeyRef: body.apiKeyRef,
        providerType: body.providerType ?? (existing[0].providerType as ProviderType),
        modelName: body.modelName ?? existing[0].modelName,
      });
      next.apiKeyRef = newRef;
    }

    await db.update(llmProviderConfig).set(next).where(eq(llmProviderConfig.id, id));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

/** DELETE /api/v1/llm-providers/:id */
llmProviderRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  await db.delete(llmProviderConfig).where(eq(llmProviderConfig.id, id));
  return c.json({ ok: true });
});

/**
 * POST /api/v1/llm-providers/:id/test — 连通性测试（dry-run）
 *
 * 最小可用版：只验证 provider 解析正常 + apiKey 已配置；不真实调 LLM API。
 * （后续 B-P2 可加真实 ping。）
 */
llmProviderRouter.post("/:id/test", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const rows = await db.select().from(llmProviderConfig).where(eq(llmProviderConfig.id, id)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ ok: false, error: "not_found" }, 404);
  if (!row.enabled) return c.json({ ok: false, error: "provider_disabled" }, 400);

  const parsed = parseAgentLlmProviderString(row.providerId);
  const provider =
    row.providerType === "custom"
      ? inferProviderFromModelName(row.modelName)
      : (row.providerType as "openai" | "anthropic" | "ollama");
  const envKey = providerEnvKey(provider);
  const apiKeyConfigured = Boolean(row.apiKeyRef && (process.env[row.apiKeyRef] ?? "").length > 0);

  if (!apiKeyConfigured && provider !== "ollama" && provider !== "mock") {
    return c.json({
      ok: false,
      error: "api_key_not_configured",
      hint: `provider=${provider} 需要配置 apiKey，envKey=${envKey ?? "?"}`,
    });
  }

  return c.json({
    ok: true,
    data: {
      parsedProvider: parsed.provider,
      runtimeProvider: provider,
      modelName: row.modelName,
      baseUrl: row.baseUrl,
      apiKeyConfigured,
      envKeyHint: envKey,
      note: "B-P0 dry-run only; real ping coming in B-P2.",
    },
  });
});

/**
 * GET /api/v1/llm-providers/_default — 返回当前默认/降级模型
 *
 * 给前端"查看当前默认模型"用。优先级走 LlmRouter 的逻辑。
 */
llmProviderRouter.get("/_default/info", async (c) => {
  const resolved = await resolveLlmForAgent({ llmProvider: undefined });
  return c.json({
    ok: true,
    data: {
      source: resolved.source,
      provider: resolved.config.provider,
      model: resolved.config.model,
      apiKeyConfigured: Boolean(resolved.config.apiKey),
    },
  });
});
