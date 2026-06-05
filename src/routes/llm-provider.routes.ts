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

/**
 * 把前端传的 apiKey 明文（或显式 apiKeyRef）规范化为 `{ apiKeyRef, apiKeySecret }`。
 *
 * 设计（2026-06-05 修复"重启后缺 apiKey"）：
 *
 * - **apiKeyRef**：env 变量名（如 `OPENAI_API_KEY`）。当 user 通过 env 提供 key 时，
 *   这一列就是唯一来源；当 user 通过 UI 提供明文 apiKey 时，这一列仍然填上推断出的
 *   envKey，便于"hydrate 回 process.env"以及"启动后让 SDK 直接读 env"。
 * - **apiKeySecret**：明文 apiKey 持久化（migration 0079）。本字段是修复重启丢失的
 *   核心载体；之前只写 process.env，进程退出即丢，user 体感"上次配的全消失"。
 *
 * 三个分支：
 *   1. user 显式传 `apiKeyRef` → 不存 secret（user 自己用 env 管理 key，DB 不存明文）
 *   2. user 传明文 `apiKey` → 同时持久化 secret + 写 process.env[apiKeyRef]（当前进程立即生效）
 *   3. 都没传 → `{ apiKeyRef: null, apiKeySecret: null }`（创建场景下表示无 key）
 *
 * NOTE：返回 `apiKeySecret === undefined` 表示"调用方不要动这个字段"（用于 PATCH 时
 * apiKey 字段缺省 == 保持不变）；返回 `apiKeySecret === null` 才是"显式清空"。
 */
function normalizeApiKey(input: {
  apiKey?: string | null;
  apiKeyRef?: string | null;
  providerType?: ProviderType;
  modelName?: string;
}): { apiKeyRef: string | null; apiKeySecret: string | null } {
  // case 1: user 显式 env-ref
  if (input.apiKeyRef && input.apiKeyRef.trim()) {
    return { apiKeyRef: input.apiKeyRef.trim(), apiKeySecret: null };
  }
  // case 2: 明文 apiKey
  if (input.apiKey && input.apiKey.trim()) {
    const secret = input.apiKey.trim();
    const provider =
      input.providerType === "custom" && input.modelName
        ? inferProviderFromModelName(input.modelName)
        : input.providerType;
    const envKey = provider ? providerEnvKey(provider as "openai") : null;
    // 给 custom 兜底一个命名（多个 custom provider 仍会共用同一个 env key，但
    // loadProviderFromDb 主要走 apiKeySecret，这里的 env key 仅为兼容层）
    const finalEnvKey = envKey ?? `QUBIT_LLM_${(input.providerType ?? "custom").toUpperCase()}_KEY`;
    // 同步写 process.env，让本进程内其他 SDK / inline-string 路径立即可见。
    // 进程重启后由 hydrateLlmProviderEnv() 从 DB 重新还原。
    process.env[finalEnvKey] = secret;
    return { apiKeyRef: finalEnvKey, apiKeySecret: secret };
  }
  // case 3: 都没传
  return { apiKeyRef: null, apiKeySecret: null };
}

function apiKeyConfigured(row: {
  apiKeyRef: string | null;
  apiKeySecret: string | null;
}): boolean {
  if (row.apiKeySecret && row.apiKeySecret.length > 0) return true;
  if (row.apiKeyRef && (process.env[row.apiKeyRef] ?? "").length > 0) return true;
  return false;
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
      apiKeyConfigured: apiKeyConfigured(r),
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
  // 不把 apiKeySecret 明文回吐给前端，仅暴露"是否已配置"
  const { apiKeySecret: _omit, ...safeRow } = row;
  return c.json({
    ok: true,
    data: {
      ...safeRow,
      apiKeyConfigured: apiKeyConfigured(row),
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
    const { apiKeyRef, apiKeySecret } = normalizeApiKey(body);
    const id = randomUUID();
    await db.insert(llmProviderConfig).values({
      id,
      providerId: body.providerId.trim(),
      providerType: body.providerType ?? "custom",
      modelName: body.modelName.trim(),
      baseUrl: body.baseUrl ?? null,
      apiKeyRef,
      apiKeySecret,
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

    // apiKey / apiKeyRef 变化时重写。
    //
    // PATCH 语义：apiKey/apiKeyRef 任一字段出现在请求 body 中即视为"要重设 key"。
    // 都缺省则保持现状（前端 LlmProvidersList 的 handleSaveEdit 已遵循此约定：
    // apiKey 留空就不发送）。
    if (body.apiKey !== undefined || body.apiKeyRef !== undefined) {
      const normalized = normalizeApiKey({
        apiKey: body.apiKey,
        apiKeyRef: body.apiKeyRef,
        providerType: body.providerType ?? (existing[0].providerType as ProviderType),
        modelName: body.modelName ?? existing[0].modelName,
      });
      next.apiKeyRef = normalized.apiKeyRef;
      next.apiKeySecret = normalized.apiKeySecret;
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
  const keyOk = apiKeyConfigured(row);

  if (!keyOk && provider !== "ollama" && provider !== "mock") {
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
      apiKeyConfigured: keyOk,
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
